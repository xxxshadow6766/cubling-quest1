import { ACHIEVEMENTS, BALANCE, EGG_FAMILIES, ITEMS, RARITY_COLORS, RANKS, SPECIES, THEMES, ZONES } from '../../../../shared/config';
import { fmt, fmtTime, rankDef } from '../../../../shared/formulas';
import { sfx } from '../../audio';
import { act } from '../../net';
import { openPanel, toast, useStore } from '../../store';
import { Panel, PetImg, Progress, useNow } from '../common';

export function IndexPanel() {
  const index = useStore((s) => s.save!.index);
  const found = SPECIES.filter((s) => index[s.id]).length;
  const families = [...EGG_FAMILIES.map((f) => ({ id: f.id, name: f.name, theme: THEMES.find((t) => t.id === f.id)! })), { id: 'secret', name: 'Secret Pets', theme: null }];
  return (
    <Panel title={`📖 Pet Index · ${found}/${SPECIES.length} discovered`}>
      <Progress value={found} max={SPECIES.length} gold />
      <div className="muted" style={{ margin: '6px 0 10px' }}>Dots show variants you've found: normal · golden · rainbow · shiny · huge.</div>
      {families.map((f) => (
        <div className="family" key={f.id}>
          <h4 style={{ color: f.theme ? 'var(--ink)' : '#0f9e7a' }}>{f.theme ? `🥚 ${f.name}` : '🤫 Secret Pets'} <span className="muted">{f.theme?.name ?? 'Ultra rare, from any egg'}</span></h4>
          <div className="grid-cards">
            {SPECIES.filter((s) => s.f === f.id).map((s) => {
              const bits = index[s.id] ?? 0;
              return (
                <div key={s.id} className="pet-card" style={{ ['--rc' as any]: RARITY_COLORS[s.r], cursor: 'default' }}>
                  <PetImg pet={{ s: s.id, v: 'normal' }} silhouette={!bits} />
                  <div className="nm">{bits ? s.name : '???'}</div>
                  <div className="rar">{s.r}</div>
                  <div className="vdots">
                    {(['n', 'g', 'r', 's', 'h'] as const).map((k, i) => <i key={k} className={`${k}${bits & (1 << i) ? ' on' : ''}`} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </Panel>
  );
}

export function QuestsPanel() {
  const save = useStore((s) => s.save)!;
  const rd = rankDef(save.rank);
  const next = RANKS[save.rank];
  return (
    <Panel narrow title="📋 Quests & Rank">
      <div className="card">
        <div style={{ fontWeight: 900, fontSize: 20 }}>⭐ Rank {save.rank} · {rd.name}</div>
        {next ? (
          <>
            <div className="muted">{save.rankXp}/{rd.xp} quest stars to Rank {next.rank} ({next.name})</div>
            <Progress value={save.rankXp} max={rd.xp} gold />
            <div className="muted" style={{ marginTop: 4 }}>
              Next rank reward: {[
                next.rewards.gems ? `💎 ${fmt(next.rewards.gems)}` : '',
                next.rewards.slots ? `🐾 +${next.rewards.slots} pet slot` : '',
                next.rewards.enchantSlots ? '📜 +1 enchant slot' : '',
                next.rewards.unlock === 'autoFarm' ? '🤖 Auto Farm' : '',
                next.rewards.items ? '🧪 potions' : '',
              ].filter(Boolean).join(' · ')}
            </div>
          </>
        ) : <div className="muted">Max rank reached — you are royalty! 👑</div>}
      </div>
      <div className="section-title">Active quests</div>
      <div className="list">
        {save.quests.map((q, i) => {
          const done = q.progress >= q.target;
          return (
            <div className="list-row" key={`${q.tpl}-${i}`} style={done ? { borderColor: 'var(--green)', background: '#effff4' } : undefined}>
              <div className="big-ico">{done ? '✅' : '📌'}</div>
              <div className="grow">
                <div className="title">{q.label}</div>
                <div className="sub">{fmt(Math.min(q.progress, q.target))}/{fmt(q.target)} · Reward: ⭐{q.xp} + 💎{q.gems}</div>
                <Progress value={q.progress} max={q.target} />
              </div>
              {done ? (
                <button className="btn green" onClick={() => act('claimQuest', { index: i }).then((r) => {
                  if (r.ok) {
                    sfx('unlock');
                    toast(`📋 Quest complete! +${r.gems} gems, +${r.xp}⭐`, 'success');
                  }
                })}>Claim</button>
              ) : (
                <button className="btn small grey" title="Swap for a different quest" disabled={save.gems < BALANCE.questRerollCost} onClick={() => act('rerollQuest', { index: i })}>🔄 💎{BALANCE.questRerollCost}</button>
              )}
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ marginTop: 8 }}>New quests appear as soon as you claim one. Co-op quests appear while playing in a friends room.</div>
    </Panel>
  );
}

export function AchievementsPanel() {
  const save = useStore((s) => s.save)!;
  return (
    <Panel narrow title="🏆 Achievements">
      <div className="list">
        {ACHIEVEMENTS.map((a) => {
          const got = save.achievements[a.id] ?? 0;
          const val = save.stats[a.stat] ?? 0;
          const done = got >= a.tiers.length;
          const target = a.tiers[Math.min(got, a.tiers.length - 1)];
          return (
            <div className="list-row" key={a.id}>
              <div className="big-ico">{a.icon}</div>
              <div className="grow">
                <div className="title">{a.name} <span style={{ color: '#ffb02e' }}>{'★'.repeat(got)}{'☆'.repeat(a.tiers.length - got)}</span></div>
                <div className="sub">{done ? 'All tiers complete!' : `${a.desc.replace('{n}', fmt(target))} · reward 💎 ${fmt(a.gems[got])}`}</div>
                <Progress value={done ? 1 : val} max={done ? 1 : target} gold />
              </div>
              <div className="muted">{fmt(val)}</div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export function ItemsPanel() {
  const save = useStore((s) => s.save)!;
  const now = useNow(1000);
  return (
    <Panel narrow title="🧪 Items & Boosts">
      <div className="info-box">Potions drop from breakables, quests, ranks and daily gifts. Using more of the same potion adds time (max {ITEMS.maxStackSec / 3600}h).</div>
      <div className="section-title">Potions</div>
      <div className="list">
        {ITEMS.boosts.map((b) => {
          const n = save.items[b.id] ?? 0;
          const until = save.boosts[b.effect] ?? 0;
          return (
            <div className="list-row" key={b.id}>
              <div className="big-ico">{b.icon}</div>
              <div className="grow">
                <div className="title">{b.name} ×{n}</div>
                <div className="sub">{b.desc}{until > now ? ` · ACTIVE ${fmtTime((until - now) / 1000)}` : ''}</div>
              </div>
              <button className="btn green" disabled={n <= 0} onClick={() => act('useItem', { id: b.id }).then((r) => {
                if (r.ok) {
                  sfx('unlock');
                  toast(`${b.icon} ${b.name} activated!`, 'success');
                }
              })}>Use</button>
            </div>
          );
        })}
      </div>
      <div className="section-title">Enchant books</div>
      <div className="muted">You own {Object.values(save.books).reduce((a, b) => a + b, 0)} book(s). Equip them at the 📜 Enchant Altar in Town.</div>
    </Panel>
  );
}

export function TeleportPanel() {
  const save = useStore((s) => s.save)!;
  const zone = useStore((s) => s.zone);
  const go = async (z: number) => {
    const r = await act('teleport', { zone: z });
    if (r.ok) {
      sfx('pop');
      openPanel(null);
    }
  };
  const max = Math.min(BALANCE.zoneCount, save.zone + 1);
  return (
    <Panel title="🌀 Teleport">
      <div className="tp-grid">
        <button className={`tp-btn${zone === 0 ? ' here' : ''}`} style={{ background: 'linear-gradient(135deg, #9fdcff, #f3e7cf)' }} onClick={() => go(0)}>
          <small>Hub · stations & trading</small>🐾 Cubling Town
        </button>
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => {
          const z = ZONES[n];
          const locked = n > save.zone;
          return (
            <button key={n} className={`tp-btn${zone === n ? ' here' : ''}`} disabled={locked} style={{ background: `linear-gradient(135deg, ${z.theme.sky}, ${z.theme.ground})` }} onClick={() => go(n)}>
              <small>Area {n} · {z.theme.name}{z.boss ? ' · 👑' : ''}</small>{locked ? '🔒 ' : ''}{z.name}
            </button>
          );
        })}
      </div>
      <div className="muted" style={{ marginTop: 10 }}>{BALANCE.zoneCount - save.zone} more areas to discover!</div>
    </Panel>
  );
}
