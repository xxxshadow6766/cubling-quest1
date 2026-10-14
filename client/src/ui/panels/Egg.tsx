import { useEffect, useState } from 'react';
import { RARITY_COLORS, UNLOCKS, ZONES } from '../../../../shared/config';
import { derivedStats, eggOdds, fmt, fmtPct, petName, petPower } from '../../../../shared/formulas';
import { sfx } from '../../audio';
import { openPanel, store, useStore } from '../../store';
import { doHatch } from '../actions';
import { EggImg, Panel, PetCard, PetImg, rarityOf } from '../common';
import { AutoDeleteModal } from './Inventory';

export function EggPanel({ zone }: { zone: number }) {
  const save = useStore((s) => s.save)!;
  const autoHatch = useStore((s) => s.autoHatch);
  const [busy, setBusy] = useState(false);
  const [autoDel, setAutoDel] = useState(false);
  const z = ZONES[zone];
  const st = derivedStats(save, Date.now());
  const odds = eggOdds(zone, st.luck);
  const locked = zone > save.zone;

  const hatch = async (count: number) => {
    if (busy) return;
    setBusy(true);
    const r = await doHatch(zone, count);
    setBusy(false);
    if (r.ok) openPanel(null);
  };

  const unlockName = (id: string) => UNLOCKS.find((u) => u.id === id)?.name ?? id;
  const btn = (count: number, unlockId?: string) => {
    const cost = z.eggCost * count;
    const has = st.hatchCounts.includes(count);
    return (
      <button key={count} className={`btn ${count === 1 ? 'green' : count === 3 ? 'blue' : 'pink'} big`} disabled={busy || locked || !has || save.coins < cost} onClick={() => hatch(count)}>
        {has ? `🥚 Hatch ×${count}` : `🔒 ${unlockName(unlockId!)}`}
        <span style={{ fontSize: 14 }}>🪙 {fmt(cost)}</span>
      </button>
    );
  };

  return (
    <Panel title={`🥚 ${z.egg.name}`}>
      <div className="egg-hero">
        <EggImg zone={zone} />
        <div>
          <div style={{ fontWeight: 900, fontSize: 20 }}>{z.egg.name} <span className="muted">· Area {zone} · ★{z.egg.tier + 1} version</span></div>
          <div className="muted">Cost per egg: 🪙 {fmt(z.eggCost)} · You have 🪙 {fmt(save.coins)}</div>
          <div className="muted">🍀 Your luck: ×{st.luck.toFixed(2)} (multiplies Epic, Legendary and Mythic odds)</div>
          <div className="muted">⏱ Hatch cooldown: {st.hatchCooldown.toFixed(1)}s</div>
        </div>
      </div>
      <div className="section-title">Exact odds (server uses these numbers)</div>
      <div className="odds">
        {odds.entries.map((e) => (
          <div key={e.species.id} className="odds-row" style={{ ['--rc' as any]: RARITY_COLORS[e.species.r] }}>
            <PetImg pet={{ s: e.species.id, v: 'normal' }} className="" silhouette={!save.index[e.species.id] && e.species.r === 'secret'} />
            <div>
              <div style={{ fontWeight: 900 }}>{!save.index[e.species.id] && e.species.r === 'secret' ? '??? Secret pet' : e.species.name}</div>
              <div className="muted" style={{ color: RARITY_COLORS[e.species.r] }}>{e.species.r.toUpperCase()} · ⚔️ {fmt(petPower({ s: e.species.id, v: 'normal', z: zone }))}</div>
            </div>
            <div className="pct">{fmtPct(e.chance)}</div>
          </div>
        ))}
        {odds.huge && (
          <div className="odds-row" style={{ ['--rc' as any]: '#2a1f45' }}>
            <PetImg pet={{ s: odds.huge.species.id, v: 'normal' }} className="" />
            <div>
              <div style={{ fontWeight: 900 }}>HUGE {odds.huge.species.name}</div>
              <div className="muted">Bonus roll on every hatch · ⚔️ {fmt(petPower({ s: odds.huge.species.id, v: 'normal', z: zone, hg: true }))} + room-wide aura</div>
            </div>
            <div className="pct">{fmtPct(odds.huge.chance)}</div>
          </div>
        )}
        <div className="muted" style={{ marginTop: 4 }}>
          Extra rolls on every pet: ✨ Shiny {fmtPct(odds.shiny)} (×1.5 power) · 🟡 Golden {fmtPct(odds.golden)} (×2.5 power)
        </div>
      </div>
      <div className="section-title">Hatch</div>
      {locked ? <div className="warn-box">🔒 Unlock Area {zone} to hatch this egg.</div> : (
        <div className="egg-buttons">
          {btn(1)}
          {btn(3, 'tripleHatch')}
          {btn(8, 'octoHatch')}
          {save.unlocks.autoHatch ? (
            <button className={`btn big ${autoHatch === zone ? 'red' : 'gold'}`} onClick={() => {
              sfx('click');
              store.set({ autoHatch: autoHatch === zone ? null : zone, panel: null });
            }}>{autoHatch === zone ? '⏹ Stop Auto Hatch' : '🔁 Auto Hatch'}</button>
          ) : (
            <button className="btn big grey" disabled>🔒 Auto Hatch (Upgrade Station / Rebirth I)</button>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <span className="muted">🧹 Auto-delete: {save.autoDelete.length ? save.autoDelete.join(', ') : 'off'}</span>
        <button className="btn small grey" onClick={() => setAutoDel(true)}>Edit</button>
      </div>
      {autoDel && <AutoDeleteModal current={save.autoDelete} onClose={() => setAutoDel(false)} />}
    </Panel>
  );
}

/** Egg hatch animation + reveal. With "skip hatch animations" on, a compact non-blocking strip is shown instead. */
export function HatchOverlay() {
  const hatch = useStore((s) => s.hatch);
  const skip = useStore((s) => s.settings.skipHatch);
  const auto = useStore((s) => s.autoHatch);
  const [phase, setPhase] = useState<'shake' | 'reveal'>('shake');

  useEffect(() => {
    if (!hatch) return;
    const quick = skip || !!auto;
    setPhase(quick ? 'reveal' : 'shake');
    const timers: number[] = [];
    if (!quick) {
      timers.push(window.setTimeout(() => sfx('wobble'), 200));
      timers.push(window.setTimeout(() => sfx('wobble'), 700));
      timers.push(window.setTimeout(() => setPhase('reveal'), 1300));
    }
    timers.push(window.setTimeout(() => store.set({ hatch: null }), quick ? 1300 : 5500));
    return () => timers.forEach(clearTimeout);
  }, [hatch?.key]);

  if (!hatch) return null;
  const close = () => store.set({ hatch: null });
  if (skip || auto) {
    return (
      <div className="hatch-strip">
        {hatch.pets.map((p) => (
          <div key={p.id} style={{ position: 'relative', ['--rc' as any]: RARITY_COLORS[rarityOf(p)] }}>
            <PetImg pet={p} className="" />
            {p.deleted && <span className="deleted-tag" style={{ position: 'absolute', bottom: 2, left: 2 }}>🧹</span>}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="hatch-overlay" onClick={() => (phase === 'shake' ? setPhase('reveal') : close())}>
      {phase === 'shake' ? (
        <>
          <EggImg zone={hatch.zone} className="hatch-egg" />
          <div className="hatch-tip">Hatching… (tap to skip)</div>
        </>
      ) : (
        <>
          <div className="hatch-flash" />
          <div className="hatch-cards">
            {hatch.pets.map((p, i) => (
              <div key={p.id} className="hatch-card" style={{ animationDelay: `${i * 0.08}s` }}>
                <PetCard pet={p} note={p.deleted ? '🧹 auto-deleted' : 'NEW!'} />
              </div>
            ))}
          </div>
          <div className="hatch-tip">
            {hatch.pets.some((p) => p.hg) ? '🦖 HUGE PET!!! ' : ''}
            {hatch.pets.length === 1 ? `You got ${petName(hatch.pets[0])}!` : `You hatched ${hatch.pets.length} pets!`} Tap to continue
          </div>
        </>
      )}
    </div>
  );
}
