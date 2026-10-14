import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { RARITY_COLORS, SPECIES_BY_ID } from '../../../shared/config';
import { fmt, petName, petPower, petStars } from '../../../shared/formulas';
import type { PetInstance, Rarity } from '../../../shared/types';
import { eggThumb, onThumbs, petThumb } from '../game/assets';
import { sfx } from '../audio';
import { openPanel } from '../store';

export function useThumbRefresh() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const off = onThumbs(force);
    return () => {
      off();
    };
  }, []);
}

export function PetImg({ pet, className = 'thumb', silhouette = false }: { pet: Pick<PetInstance, 's' | 'v' | 'sh'>; className?: string; silhouette?: boolean }) {
  useThumbRefresh();
  const url = petThumb(pet);
  return url ? <img className={`${className}${silhouette ? ' silhouette' : ''}`} src={url} alt="" draggable={false} /> : <div className="ph" />;
}

export function EggImg({ zone, className }: { zone: number; className?: string }) {
  useThumbRefresh();
  const url = eggThumb(zone);
  return url ? <img className={className} src={url} alt="" draggable={false} /> : <div className="ph" />;
}

export const rarityOf = (p: Pick<PetInstance, 's'>): Rarity => SPECIES_BY_ID[p.s]?.r ?? 'common';

export function RarityTag({ r }: { r: Rarity }) {
  return <span className="tag" style={{ background: RARITY_COLORS[r] }}>{r}</span>;
}

export function PetCard({
  pet, onClick, selected, equipped, disabled, note, mini,
}: {
  pet: PetInstance; onClick?: () => void; selected?: boolean; equipped?: boolean; disabled?: boolean; note?: string; mini?: boolean;
}) {
  const r = rarityOf(pet);
  const cls = ['pet-card', selected ? 'sel' : '', disabled ? 'disabled' : '', pet.v === 'golden' ? 'v-golden' : '', pet.v === 'rainbow' ? 'v-rainbow' : '', `r-glow-${r}`].join(' ');
  return (
    <div className={cls} style={{ ['--rc' as any]: RARITY_COLORS[r] }} onClick={disabled ? undefined : onClick} title={petName(pet)}>
      <div className="badges">
        <span>{equipped ? '✅' : ''}{pet.sh ? '✨' : ''}</span>
        <span>{pet.lk ? '🔒' : ''}</span>
      </div>
      <PetImg pet={pet} />
      <div className="stars">{'★'.repeat(petStars(pet))}</div>
      {pet.hg && <div className="huge-badge">HUGE</div>}
      {!mini && <div className="nm">{petName(pet)}</div>}
      <div className="pw">⚔️ {fmt(petPower(pet))}</div>
      {!mini && <div className="rar">{r}</div>}
      {note && <div className="muted" style={{ fontSize: 11 }}>{note}</div>}
    </div>
  );
}

export function Panel({ title, children, footer, narrow, onClose }: { title: ReactNode; children: ReactNode; footer?: ReactNode; narrow?: boolean; onClose?: () => void }) {
  const close = () => {
    sfx('click');
    (onClose ?? (() => openPanel(null)))();
  };
  return (
    <div className="panel-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`panel${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true">
        <div className="panel-head">
          <h2>{title}</h2>
          <button className="panel-close" onClick={close} aria-label="Close">✕</button>
        </div>
        <div className="panel-body">{children}</div>
        {footer && <div className="panel-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Modal({ title, children, onCancel, onConfirm, confirmText = 'Confirm', danger, busy }: {
  title: string; children: ReactNode; onCancel: () => void; onConfirm: () => void; confirmText?: string; danger?: boolean; busy?: boolean;
}) {
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" role="alertdialog">
        <h3>{title}</h3>
        <div className="muted" style={{ color: 'var(--ink)' }}>{children}</div>
        <div className="row">
          <button className="btn grey" onClick={onCancel}>Cancel</button>
          <button className={`btn ${danger ? 'red' : 'green'}`} disabled={busy} onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

export function Progress({ value, max, gold }: { value: number; max: number; gold?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <div className={`progress${gold ? ' gold' : ''}`}><i style={{ width: `${pct}%` }} /></div>;
}

/** Smoothly animates a number toward its target value (for satisfying currency counters). */
export function useAnimatedNumber(target: number) {
  const [v, setV] = useState(target);
  const ref = useRef(target);
  useEffect(() => {
    let raf = 0;
    const start = ref.current;
    const t0 = performance.now();
    const dur = 450;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      const cur = start + (target - start) * e;
      ref.current = cur;
      setV(cur);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
