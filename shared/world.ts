// World geometry shared by server (validation) and client (rendering).
// Areas are laid out in a line along -Z. The Town (area 0) sits at z 35..105; area N is centred at -(N-1)*ZL.
import { BALANCE, TOWN, ZONES } from './config';

export const ZL = BALANCE.zoneLength;
export const HALF_W = BALANCE.zoneWidth / 2;
export const X_LIMIT = HALF_W - 1.5;
export const TOWN_MIN_Z = ZL / 2;
export const TOWN_MAX_Z = ZL / 2 + ZL;
export const MAX_Z = TOWN_MAX_Z - 1.5;

export function zoneCenterZ(n: number): number {
  return n === 0 ? TOWN_MIN_Z + ZL / 2 : -(n - 1) * ZL;
}

export function zoneAtZ(z: number): number {
  if (z > TOWN_MIN_Z) return 0;
  return Math.min(BALANCE.zoneCount, Math.max(1, Math.floor((TOWN_MIN_Z - z) / ZL) + 1));
}

/** z of the gate that leads INTO zone n (n >= 2). */
export function gateZ(n: number): number {
  return zoneCenterZ(n) + ZL / 2;
}

/** Players with maxZone unlocked may not go below this z. */
export function minZFor(maxZone: number): number {
  return zoneCenterZ(maxZone) - ZL / 2 + 1.2;
}

export function eggStandPos(n: number) {
  return { x: -21, z: zoneCenterZ(n) + 22 };
}

export function bossPos(n: number) {
  return { x: 0, z: zoneCenterZ(n) - 20 };
}

export function zoneSpawn(n: number) {
  return n === 0 ? { x: TOWN.spawn.x, z: TOWN.spawn.z } : { x: 0, z: zoneCenterZ(n) + 18 };
}

export function stationPos(id: string) {
  const s = TOWN.stations.find((st) => st.id === id);
  return s ? { x: s.x, z: s.z } : null;
}

/** Random point in a zone's breakable field (avoids the egg stand and the boss pedestal). */
export function randomFieldPoint(n: number, rnd: () => number) {
  const c = zoneCenterZ(n);
  const egg = eggStandPos(n);
  const boss = bossPos(n);
  for (let i = 0; i < 20; i++) {
    const x = -26 + rnd() * 52;
    const z = c - 27 + rnd() * 41;
    if (Math.hypot(x - egg.x, z - egg.z) < 7) continue;
    if (ZONES[n]?.boss && Math.hypot(x - boss.x, z - boss.z) < 7) continue;
    return { x, z };
  }
  return { x: 10, z: c };
}

export const dist2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
