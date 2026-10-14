import { RARITY_ORDER, SPECIES_BY_ID } from '../../../shared/config';
import { sfx } from '../audio';
import { act, bus } from '../net';
import { store } from '../store';

let hatchKey = 0;

/** Ask the server to hatch; shows the hatch animation with the server's (authoritative) results. */
export async function doHatch(zone: number, count: number, auto = false) {
  const r = await act('hatch', { zone, count }, auto);
  if (r.ok) {
    store.set({ hatch: { zone, pets: r.pets, key: ++hatchKey } });
    bus.emit('hatched', r.pets);
    let best = 0;
    for (const p of r.pets) {
      const ri = RARITY_ORDER.indexOf(SPECIES_BY_ID[p.s]?.r ?? 'common');
      best = Math.max(best, p.hg ? 6 : ri);
    }
    sfx(best >= 4 ? 'legendary' : best >= 2 ? 'rare' : 'hatch');
  } else if (auto && r.error && r.error !== 'Hatching too fast!') {
    store.set({ autoHatch: null });
  }
  return r;
}

export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function inviteLink(code: string) {
  return `${location.origin}/?room=${encodeURIComponent(code)}`;
}
