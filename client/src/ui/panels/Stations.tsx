import { useState } from 'react';
import { BALANCE, BOOSTS_BY_ID, DAILY, ENCHANTS, ENCHANTS_BY_ID, REBIRTHS, UNLOCKS, UPGRADES, ZONES } from '../../../../shared/config';
import { derivedStats, fmt, fmtTime, nextRebirth, petName, petPower, petStars, rebirthDef, upgradeCost } from '../../../../shared/formulas';
import type { PetInstance } from '../../../../shared/types';
import { sfx } from '../../audio';
import { act } from '../../net';
import { banner, openPanel, toast, useStore } from '../../store';
import { Modal, Panel, PetImg, Progress, useNow } from '../common';

export function GatePanel({ zone }: { zone: number }) {
  const save = useStore((s) => s.save)!;
  const [busy, setBusy] = useState(false);
  const z = ZONES[zone];
  const can = save.coins >= z.gateCost;
  const done = zone <= save.zone;
  return (
    <Panel narrow title={`🔓 Area ${zone}: ${z.name}`}>
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="muted">{z.theme.name} · new egg: {z.egg.name}{z.boss ? ' · 👑 Boss Chest arena' : ''}</div>
        <div style={{ fontSize: 30, fontWeight: 900, margin: '10px 0' }}>🪙 {fmt(z.gateCost)}</div>
        <Progress value={save.coins} max={z.gateCost} gold />
        <div className="muted" style={{ marginTop: 6 }}>{can ? 'You can afford it!' : `You need 🪙 ${fmt(z.gateCost - save.coins)} more.`}</div>
        <button className="btn green big wide" style={{ marginTop: 12 }} disabled={busy || done || !can} onClick={async () => {
          setBusy(true);
          const r = await act('unlockZone', { zone });
          setBusy(false);
          if (r.ok) {
            sfx('unlock');
            banner(`🎉 Area ${zone} unlocked: ${z.name}!`, 'boss');
            openPanel(null);
          }
        }}>{done ? 'Already unlocked' : 'Unlock area'}</button>
      </div>
    </Panel>
  );
}

function effectText(id: string, per: number, lvl: number) {
  const v = per * lvl;
  switch (id) {
    case 'damage': return `+${Math.round(v * 100)}% pet damage`;
    case 'coins': return `+${Math.round(v * 100)}% coins`;
    case 'speed': return `+${Math.round(v * 100)}% walk speed`;
    case 'luck': return `+${Math.round(v * 100)}% rare-pet luck`;
    case 'hatchSpeed': return `${Math.round((1 - Math.pow(1 - per, lvl)) * 100)}% faster hatching`;
    case 'slots': return `+${v} pet slots`;
    case 'inventory': return `+${v} pet storage`;
    case 'gemFind': return `+${Math.round(v * 100)}% gems`;
    default: return '';
  }
}

export function UpgradesPanel() {
  const save = useStore((s) => s.save)!;
  const buy = async (id: string) => {
    const r = await act('buyUpgrade', { id });
    if (r.ok) sfx('buy');
  };
  const group = (currency: 'coins' | 'gems') => UPGRADES.filter((u) => u.currency === currency).map((u) => {
    const lvl = save.upgrades[u.id] ?? 0;
    const maxed = lvl >= u.max;
    const cost = upgradeCost(u, lvl);
    const have = currency === 'coins' ? save.coins : save.gems;
    return (
      <div className="list-row" key={u.id}>
        <div className="big-ico">{u.icon}</div>
        <div className="grow">
          <div className="title">{u.name} <span className="muted">Lv {lvl}/{u.max}</span></div>
          <div className="sub">{u.desc}</div>
          <div className="sub">Now: <b>{lvl ? effectText(u.id, u.per, lvl) : 'no bonus'}</b>{!maxed && <> → Next: <b style={{ color: '#1f8a45' }}>{effectText(u.id, u.per, lvl + 1)}</b></>}</div>
          <Progress value={lvl} max={u.max} />
        </div>
        <button className={`btn ${currency === 'coins' ? 'gold' : 'blue'}`} disabled={maxed || have < cost} onClick={() => buy(u.id)}>
          {maxed ? 'MAX' : `${currency === 'coins' ? '🪙' : '💎'} ${fmt(cost)}`}
        </button>
      </div>
    );
  });
  return (
    <Panel title="⬆️ Upgrade Station">
      <div className="section-title">🪙 Coin upgrades <span style={{ textTransform: 'none' }}>(reset on Rebirth)</span></div>
      <div className="list">{group('coins')}</div>
      <div className="section-title">💎 Gem upgrades <span style={{ textTransform: 'none' }}>(permanent)</span></div>
      <div className="list">{group('gems')}</div>
      <div className="section-title">🔓 Hatching unlocks (permanent)</div>
      <div className="list">
        {UNLOCKS.map((u) => {
          const owned = !!save.unlocks[u.id];
          const blocked = !!u.requires && !save.unlocks[u.requires];
          return (
            <div className="list-row" key={u.id}>
              <div className="big-ico">{u.icon}</div>
              <div className="grow"><div className="title">{u.name}</div><div className="sub">{u.desc}</div></div>
              <button className="btn blue" disabled={owned || blocked || save.gems < u.cost} onClick={() => act('buyUnlock', { id: u.id }).then((r) => r.ok && sfx('unlock'))}>
                {owned ? '✅ Owned' : blocked ? '🔒 Needs previous' : `💎 ${fmt(u.cost)}`}
              </button>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function MachinePanel({ kind }: { kind: 'golden' | 'rainbow' }) {
  const save = useStore((s) => s.save)!;
  const [busy, setBusy] = useState(false);
  const cfg = kind === 'golden' ? BALANCE.golden : BALANCE.rainbow;
  const from = kind === 'golden' ? 'normal' : 'golden';
  const lockedMachine = kind === 'rainbow' && save.zone < BALANCE.rainbow.requiresZone;
  const groups = new Map<string, PetInstance[]>();
  for (const p of save.pets) {
    if (p.v !== from || p.hg) continue;
    const k = `${p.s}|${p.z}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const list = [...groups.values()].sort((a, b) => b.filter((p) => !p.lk).length - a.filter((p) => !p.lk).length || petPower(b[0]) - petPower(a[0]));
  return (
    <Panel title={kind === 'golden' ? '✨ Golden Machine' : '🌈 Rainbow Machine'}>
      <div className="info-box">
        Combine <b>{cfg.count} identical {kind === 'golden' ? 'normal' : 'Golden'} pets</b> (same pet, same ★ tier) + 💎 {cfg.gemFee} gems →
        <b> 1 {kind === 'golden' ? 'Golden' : 'Rainbow'} pet</b> with ×{BALANCE.variantMult[kind]} base power (instead of ×{BALANCE.variantMult[from]}).
        Success is guaranteed. If any input is Shiny, the result is Shiny. Locked pets are never used.
      </div>
      {lockedMachine ? <div className="warn-box" style={{ marginTop: 10 }}>🔒 Reach Area {BALANCE.rainbow.requiresZone} to power up the Rainbow Machine.</div> : (
        <>
          <div className="section-title">Your pets</div>
          {list.length === 0 && <div className="muted">No {from} pets to convert yet. Hatch more eggs!</div>}
          <div className="list">
            {list.map((g) => {
              const usable = g.filter((p) => !p.lk);
              const ready = usable.length >= cfg.count;
              const result = { ...g[0], v: kind } as PetInstance;
              return (
                <div className="list-row" key={`${g[0].s}|${g[0].z}`}>
                  <PetImg pet={g[0]} className="" />
                  <div className="grow">
                    <div className="title">{petName(g[0])} <span className="muted">{'★'.repeat(petStars(g[0]))}</span></div>
                    <div className="sub">{usable.length}/{cfg.count} available{g.length > usable.length ? ` (${g.length - usable.length} locked)` : ''} · ⚔️ {fmt(petPower(g[0]))} → <b style={{ color: '#c47f00' }}>{fmt(petPower(result))}</b></div>
                    <Progress value={usable.length} max={cfg.count} gold />
                  </div>
                  <PetImg pet={result} className="" />
                  <button className="btn gold" disabled={busy || !ready || save.gems < cfg.gemFee} onClick={async () => {
                    setBusy(true);
                    const r = await act(kind, { id: usable[0].id });
                    setBusy(false);
                    if (r.ok) {
                      sfx('rare');
                      toast(`${kind === 'golden' ? '✨' : '🌈'} You made a ${petName(r.pet)}!`, 'success');
                    }
                  }}>Convert · 💎{cfg.gemFee}</button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}

export function EnchantPanel() {
  const save = useStore((s) => s.save)!;
  const st = derivedStats(save, Date.now());
  const owned = Object.entries(save.books).filter(([, n]) => n > 0);
  const totalW = ENCHANTS.reduce((a, b) => a + b.w, 0);
  return (
    <Panel title="📜 Enchant Altar">
      <div className="info-box">Enchant books give permanent bonuses while equipped. Slots: <b>{save.enchants.length}/{st.enchantSlots}</b> (more at Rank 10, Rank 20 and Rebirth II). Equipped bonuses add together.</div>
      <div className="section-title">Equipped</div>
      <div className="list">
        {save.enchants.length === 0 && <div className="muted">No enchants equipped.</div>}
        {save.enchants.map((id, i) => {
          const e = ENCHANTS_BY_ID[id];
          return (
            <div className="list-row" key={`${id}-${i}`}>
              <div className="big-ico">{e?.icon}</div>
              <div className="grow"><div className="title">{e?.name}</div><div className="sub">+{Math.round((e?.value ?? 0) * 100)}% {e?.effect}</div></div>
              <button className="btn small grey" onClick={() => act('enchantUnequip', { index: i })}>Unequip</button>
            </div>
          );
        })}
      </div>
      <div className="section-title">Your books</div>
      <div className="list">
        {owned.length === 0 && <div className="muted">No books yet — they drop from chests, comets and boss chests, or buy one below.</div>}
        {owned.map(([id, n]) => {
          const e = ENCHANTS_BY_ID[id];
          const used = save.enchants.filter((x) => x === id).length;
          return (
            <div className="list-row" key={id}>
              <div className="big-ico">{e?.icon}</div>
              <div className="grow"><div className="title">{e?.name} ×{n}</div><div className="sub">+{Math.round((e?.value ?? 0) * 100)}% {e?.effect} · {used} equipped</div></div>
              <button className="btn small green" disabled={used >= n || save.enchants.length >= st.enchantSlots} onClick={() => act('enchantEquip', { id }).then((r) => r.ok && sfx('buy'))}>Equip</button>
            </div>
          );
        })}
      </div>
      <div className="section-title">Buy a random book</div>
      <div className="card">
        <div className="chips">
          {ENCHANTS.map((e) => <span key={e.id} className="chip">{e.icon} {e.name}: {((e.w / totalW) * 100).toFixed(1)}%</span>)}
        </div>
        <button className="btn blue big wide" style={{ marginTop: 10 }} disabled={save.gems < BALANCE.enchantAltarCost} onClick={async () => {
          const r = await act('enchantBuy');
          if (r.ok) {
            sfx('rare');
            toast(`📜 You got ${ENCHANTS_BY_ID[r.book]?.name}!`, 'success');
          }
        }}>📜 Buy book · 💎 {BALANCE.enchantAltarCost}</button>
      </div>
    </Panel>
  );
}

export function DailyPanel() {
  const save = useStore((s) => s.save)!;
  const now = useNow(1000);
  const d = save.daily;
  const next = d.last + DAILY.cooldownHours * 3600_000;
  const ready = !d.last || now >= next;
  const streakBroken = d.last && now - d.last > DAILY.streakResetHours * 3600_000;
  const nextDay = streakBroken ? 0 : d.streak % DAILY.days.length;
  return (
    <Panel narrow title="🎁 Daily Gift">
      <div className="muted" style={{ marginBottom: 8 }}>Come back every day to grow your streak! Current streak: <b>{streakBroken ? 0 : d.streak}</b> day(s).</div>
      <div className="list">
        {DAILY.days.map((day, i) => (
          <div key={i} className="list-row" style={i === nextDay ? { borderColor: 'var(--accent)' } : undefined}>
            <div className="big-ico">{i === nextDay ? '🎁' : i < nextDay ? '✅' : '📦'}</div>
            <div className="grow">
              <div className="title">Day {i + 1}</div>
              <div className="sub">💎 {day.gems}{Object.entries(day.items).map(([id, n]) => ` · ${BOOSTS_BY_ID[id]?.icon} ${BOOSTS_BY_ID[id]?.name} ×${n}`).join('')}{day.enchant ? ' · 📜 random enchant book' : ''}</div>
            </div>
          </div>
        ))}
      </div>
      <button className="btn gold big wide" style={{ marginTop: 12 }} disabled={!ready} onClick={async () => {
        const r = await act('claimDaily');
        if (r.ok) {
          sfx('unlock');
          toast(`🎁 Day ${((r.streak - 1) % DAILY.days.length) + 1} claimed: +${r.gems} gems${r.book ? ` + ${ENCHANTS_BY_ID[r.book]?.name}` : ''}!`, 'success');
        }
      }}>{ready ? '🎁 Claim gift' : `Next gift in ${fmtTime((next - now) / 1000)}`}</button>
    </Panel>
  );
}

export function RebirthPanel() {
  const save = useStore((s) => s.save)!;
  const [confirm, setConfirm] = useState(false);
  const def = nextRebirth(save.rebirths);
  const can = save.zone >= def.requiresZone;
  return (
    <Panel title={`🔄 Rebirth Shrine · You have ${save.rebirths} rebirth${save.rebirths === 1 ? '' : 's'}`}>
      <div className="card">
        <div className="title" style={{ fontWeight: 900, fontSize: 20 }}>{def.title ?? `Rebirth ${save.rebirths + 1}`}</div>
        <div className="muted">Requires Area {def.requiresZone} · your best area: {save.zone}</div>
        <Progress value={save.zone} max={def.requiresZone} gold />
        <div style={{ marginTop: 8, fontWeight: 900 }}>Rewards: {def.desc}</div>
      </div>
      <div className="row" style={{ alignItems: 'stretch', marginTop: 10 }}>
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <div className="section-title" style={{ color: '#c2284e' }}>❌ What resets</div>
          <ul className="reset-list">{REBIRTHS.resets.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
        <div className="card" style={{ flex: 1, minWidth: 220 }}>
          <div className="section-title" style={{ color: '#1f8a45' }}>✅ What you keep</div>
          <ul className="keep-list">{REBIRTHS.keeps.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      </div>
      <div className="section-title">Milestones</div>
      <div className="list">
        {REBIRTHS.milestones.map((m, i) => (
          <div key={i} className="list-row" style={save.rebirths > i ? { background: '#effff4' } : undefined}>
            <div className="big-ico">{save.rebirths > i ? '✅' : `${i + 1}`}</div>
            <div className="grow"><div className="title">{m.title}</div><div className="sub">Area {m.requiresZone} · {m.desc}</div></div>
          </div>
        ))}
        <div className="list-row"><div className="big-ico">♾️</div><div className="grow"><div className="title">Further rebirths</div><div className="sub">Area {REBIRTHS.repeatable.requiresZone} · {REBIRTHS.repeatable.desc}</div></div></div>
      </div>
      <button className="btn pink big wide" style={{ marginTop: 12 }} disabled={!can} onClick={() => setConfirm(true)}>
        {can ? '🔄 Rebirth now' : `🔒 Reach Area ${def.requiresZone}`}
      </button>
      {confirm && (
        <Modal title="Are you sure?" danger confirmText="Rebirth!" onCancel={() => setConfirm(false)} onConfirm={async () => {
          setConfirm(false);
          const r = await act('rebirth');
          if (r.ok) {
            sfx('rankup');
            banner(`🔄 Rebirth ${r.rebirths}! ${rebirthDef(r.rebirths).desc}`, 'boss');
            openPanel(null);
          }
        }}>
          Your coins, unlocked areas and coin upgrades will reset. You keep all {save.pets.length} pets, your gems and permanent upgrades.
          <br /><br />You gain: <b>{def.desc}</b>
        </Modal>
      )}
    </Panel>
  );
}
