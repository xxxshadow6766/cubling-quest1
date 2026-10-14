import { useMemo, useState } from 'react';
import { BALANCE, RARITY_COLORS, RARITY_ORDER } from '../../../../shared/config';
import { derivedStats, fmt, petName, petPower, petStars } from '../../../../shared/formulas';
import type { PetInstance, Rarity } from '../../../../shared/types';
import { sfx } from '../../audio';
import { act } from '../../net';
import { openPanel, toast, useStore } from '../../store';
import { Modal, Panel, PetCard, PetImg, RarityTag, rarityOf } from '../common';

type Sort = 'power' | 'rarity' | 'name' | 'new';

export function InventoryPanel() {
  const save = useStore((s) => s.save)!;
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('power');
  const [rar, setRar] = useState<'all' | Rarity>('all');
  const [variant, setVariant] = useState('all');
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string[] | null>(null);
  const [autoDel, setAutoDel] = useState(false);
  const stats = derivedStats(save, Date.now());
  const eq = new Set(save.equipped);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    let ps = save.pets.map((p, i) => ({ p, i }));
    if (ql) ps = ps.filter(({ p }) => petName(p).toLowerCase().includes(ql));
    if (rar !== 'all') ps = ps.filter(({ p }) => rarityOf(p) === rar);
    if (variant === 'golden' || variant === 'rainbow' || variant === 'normal') ps = ps.filter(({ p }) => p.v === variant);
    if (variant === 'shiny') ps = ps.filter(({ p }) => p.sh);
    if (variant === 'huge') ps = ps.filter(({ p }) => p.hg);
    if (variant === 'equipped') ps = ps.filter(({ p }) => eq.has(p.id));
    if (variant === 'locked') ps = ps.filter(({ p }) => p.lk);
    const ro = (p: PetInstance) => RARITY_ORDER.indexOf(rarityOf(p));
    ps.sort((a, b) => {
      if (sort === 'power') return petPower(b.p) - petPower(a.p);
      if (sort === 'rarity') return ro(b.p) - ro(a.p) || petPower(b.p) - petPower(a.p);
      if (sort === 'name') return petName(a.p).localeCompare(petName(b.p));
      return b.i - a.i;
    });
    // equipped always first for quick access
    return ps.map((x) => x.p).sort((a, b) => Number(eq.has(b.id)) - Number(eq.has(a.id)));
  }, [save.pets, save.equipped, q, sort, rar, variant]);

  const toggleSel = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };

  const equipBest = async () => {
    const r = await act('equipBest');
    if (r.ok) {
      sfx('buy');
      toast('💪 Equipped your strongest pets!', 'success');
    }
  };

  const selectedPets = save.pets.filter((p) => sel.has(p.id));
  const detailPet = detail ? save.pets.find((p) => p.id === detail) : null;

  return (
    <Panel
      title={<>🐾 Pets <span style={{ fontSize: 15, opacity: 0.9 }}>· Equipped {save.equipped.length}/{stats.slots} · Storage {save.pets.length}/{stats.invCap}</span></>}
      footer={selectMode ? (
        <>
          <span className="muted">{sel.size} selected</span>
          <span className="spacer" />
          <button className="btn small grey" onClick={() => setSel(new Set(list.map((p) => p.id)))}>Select all shown</button>
          <button className="btn small grey" onClick={() => setSel(new Set())}>Clear</button>
          <button className="btn small blue" disabled={!sel.size} onClick={() => act('lock', { ids: [...sel], locked: true }).then((r) => r.ok && toast('🔒 Locked', 'success'))}>🔒 Lock</button>
          <button className="btn small blue" disabled={!sel.size} onClick={() => act('lock', { ids: [...sel], locked: false }).then((r) => r.ok && toast('🔓 Unlocked', 'success'))}>🔓 Unlock</button>
          <button className="btn small red" disabled={!sel.size} onClick={() => setConfirmDel([...sel])}>🗑 Delete</button>
          <button className="btn small" onClick={() => { setSelectMode(false); setSel(new Set()); }}>Done</button>
        </>
      ) : (
        <>
          <button className="btn green" onClick={equipBest}>💪 Equip Best</button>
          <button className="btn grey" onClick={() => setSelectMode(true)}>☑️ Select</button>
          <button className="btn grey" onClick={() => setAutoDel(true)}>🧹 Auto-Delete{save.autoDelete.length ? ` (${save.autoDelete.length})` : ''}</button>
          <span className="spacer" />
          <span className="muted">Tip: combine 5 identical pets at the ✨ Golden Machine in Town</span>
        </>
      )}
    >
      <div className="toolbar">
        <input className="input" placeholder="🔎 Search pets…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="power">Sort: Power</option>
          <option value="rarity">Sort: Rarity</option>
          <option value="name">Sort: Name</option>
          <option value="new">Sort: Newest</option>
        </select>
        <select className="select" value={rar} onChange={(e) => setRar(e.target.value as any)} aria-label="Rarity filter">
          <option value="all">All rarities</option>
          {RARITY_ORDER.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
        </select>
        <select className="select" value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="Variant filter">
          <option value="all">All types</option>
          <option value="equipped">Equipped</option>
          <option value="normal">Normal</option>
          <option value="golden">Golden</option>
          <option value="rainbow">Rainbow</option>
          <option value="shiny">Shiny</option>
          <option value="huge">Huge</option>
          <option value="locked">Locked</option>
        </select>
      </div>
      {list.length === 0 && <div className="muted">No pets match these filters.</div>}
      <div className="grid-cards">
        {list.map((p) => (
          <PetCard key={p.id} pet={p} equipped={eq.has(p.id)} selected={sel.has(p.id)}
            onClick={() => (selectMode ? toggleSel(p.id) : setDetail(p.id))} />
        ))}
      </div>

      {detailPet && <PetDetail pet={detailPet} equipped={eq.has(detailPet.id)} slotsFull={save.equipped.length >= stats.slots} onClose={() => setDetail(null)} onDelete={() => setConfirmDel([detailPet.id])} />}

      {confirmDel && (() => {
        const victims = save.pets.filter((p) => confirmDel.includes(p.id));
        const locked = victims.filter((p) => p.lk);
        const ok = victims.filter((p) => !p.lk);
        const rare = ok.filter((p) => p.hg || p.sh || p.v !== 'normal' || RARITY_ORDER.indexOf(rarityOf(p)) >= 3);
        return (
          <Modal title={`Delete ${ok.length} pet${ok.length === 1 ? '' : 's'}?`} danger confirmText="Delete forever" onCancel={() => setConfirmDel(null)}
            onConfirm={async () => {
              const r = await act('deletePets', { ids: ok.map((p) => p.id) });
              setConfirmDel(null);
              if (r.ok) {
                sfx('pop');
                toast(`🗑 Deleted ${r.deleted} pet${r.deleted === 1 ? '' : 's'}`, 'info');
                setSel(new Set());
                setDetail(null);
              }
            }}>
            This cannot be undone.
            {locked.length > 0 && <div style={{ marginTop: 6 }}>🔒 {locked.length} locked pet(s) will be skipped.</div>}
            {rare.length > 0 && <div style={{ marginTop: 6, color: '#c2284e' }}>⚠️ Includes {rare.length} special pet(s) (Legendary+, Golden, Rainbow, Shiny or Huge)!</div>}
            {ok.some((p) => eq.has(p.id)) && <div style={{ marginTop: 6 }}>Equipped pets will be unequipped first.</div>}
          </Modal>
        );
      })()}

      {autoDel && <AutoDeleteModal current={save.autoDelete} onClose={() => setAutoDel(false)} />}
    </Panel>
  );
}

function PetDetail({ pet, equipped, slotsFull, onClose, onDelete }: { pet: PetInstance; equipped: boolean; slotsFull: boolean; onClose: () => void; onDelete: () => void }) {
  const r = rarityOf(pet);
  const mults = [
    `${BALANCE.rarityPower[r]} base (${r})`,
    `★${petStars(pet)} from area ${pet.z}`,
    pet.v !== 'normal' ? `${pet.v} ×${BALANCE.variantMult[pet.v]}` : '',
    pet.sh ? `shiny ×${BALANCE.shinyMult}` : '',
    pet.hg ? `HUGE ×${BALANCE.hugeMult}` : '',
  ].filter(Boolean);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ textAlign: 'center' }}>
        <PetImg pet={pet} className="thumb" />
        <h3 style={{ color: RARITY_COLORS[r] }}>{petName(pet)}</h3>
        <div className="row" style={{ justifyContent: 'center', marginTop: 0 }}>
          <RarityTag r={r} /> <span className="muted">{'★'.repeat(petStars(pet))}</span>
        </div>
        <div style={{ fontSize: 24, fontWeight: 900, margin: '8px 0' }}>⚔️ {fmt(petPower(pet))} damage/sec</div>
        <div className="muted">{mults.join(' · ')}</div>
        {pet.hg && <div className="info-box" style={{ marginTop: 8 }}>🦖 <b>Huge bonus:</b> while equipped, everyone in your room gets +{BALANCE.hugeAura.coins * 100}% coins and +{BALANCE.hugeAura.damage * 100}% damage (stacks up to {BALANCE.hugeAura.maxStacks}).</div>}
        <div className="row" style={{ justifyContent: 'center' }}>
          {equipped
            ? <button className="btn grey" onClick={() => act('unequip', { id: pet.id }).then((x) => x.ok && sfx('pop'))}>Unequip</button>
            : <button className="btn green" disabled={slotsFull} onClick={() => act('equip', { id: pet.id }).then((x) => x.ok && sfx('buy'))}>{slotsFull ? 'Slots full' : 'Equip'}</button>}
          <button className="btn blue" onClick={() => act('lock', { id: pet.id, ids: [pet.id], locked: !pet.lk }).then((x) => x.ok && sfx('click'))}>{pet.lk ? '🔓 Unlock' : '🔒 Lock'}</button>
          <button className="btn red" disabled={pet.lk} onClick={onDelete}>🗑 Delete</button>
          <button className="btn grey" onClick={onClose}>Close</button>
        </div>
        {pet.lk && <div className="muted" style={{ marginTop: 8 }}>Locked pets can't be deleted, converted or traded.</div>}
      </div>
    </div>
  );
}

export function AutoDeleteModal({ current, onClose }: { current: Rarity[]; onClose: () => void }) {
  const [rs, setRs] = useState<Set<Rarity>>(new Set(current));
  const [confirm, setConfirm] = useState(false);
  const options: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
  const added = [...rs].filter((r) => !current.includes(r));
  const save = async () => {
    const r = await act('setAutoDelete', { rarities: [...rs] });
    if (r.ok) {
      toast(rs.size ? `🧹 Auto-delete on for: ${[...rs].join(', ')}` : '🧹 Auto-delete turned off', 'success');
      onClose();
    }
  };
  if (confirm) {
    return (
      <Modal title="Enable auto-delete?" danger confirmText="Yes, enable" onCancel={() => setConfirm(false)} onConfirm={save}>
        From now on, newly hatched <b>{added.join(', ')}</b> pets will be deleted immediately and never enter your inventory.
        <br /><br />Shiny, Golden, Huge and Secret pets are <b>always kept</b>. Deleted pets still count toward your Pet Index.
      </Modal>
    );
  }
  return (
    <Modal title="🧹 Auto-delete rules" confirmText="Save rules" onCancel={onClose} onConfirm={() => (added.length ? setConfirm(true) : save())}>
      Choose rarities to delete automatically when hatching (only affects NEW hatches):
      <div className="chips" style={{ margin: '10px 0' }}>
        {options.map((r) => (
          <button key={r} className={`chip${rs.has(r) ? ' on' : ''}`} style={{ color: RARITY_COLORS[r] }} onClick={() => {
            const n = new Set(rs);
            if (n.has(r)) n.delete(r);
            else n.add(r);
            setRs(n);
          }}>{rs.has(r) ? '☑' : '☐'} {r}</button>
        ))}
      </div>
      Always kept: Mythic, Secret, Shiny, Golden and Huge pets.
    </Modal>
  );
}

export function closeAll() {
  openPanel(null);
}
