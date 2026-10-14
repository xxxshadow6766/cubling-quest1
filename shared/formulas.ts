// Game math shared by server (authoritative) and client (display only).
import {
  BALANCE, ENCHANTS_BY_ID, FAMILY_SPECIES, RANKS, REBIRTHS, SECRET_SPECIES, SPECIES_BY_ID, UPGRADES_BY_ID, ZONES,
  BOOSTS_BY_ID, type RebirthDef, type UpgradeDef, type Species,
} from './config';
import type { PetInstance, Rarity, SaveData } from './types';

const B = BALANCE;

export const zoneMult = (n: number) => Math.pow(B.zoneGrowth, Math.max(0, n - 1));
export const gemZoneMult = (n: number) => 1 + (n - 1) * B.gemZoneScale;

export function petPower(p: Pick<PetInstance, 's' | 'v' | 'sh' | 'hg' | 'z'>): number {
  const sp = SPECIES_BY_ID[p.s];
  if (!sp) return 0;
  let pow = B.rarityPower[sp.r] * (sp.m ?? 1) * zoneMult(p.z);
  pow *= B.variantMult[p.v] ?? 1;
  if (p.sh) pow *= B.shinyMult;
  if (p.hg) pow *= B.hugeMult;
  return pow;
}

export function upgradeCost(def: UpgradeDef, level: number): number {
  if (def.costs) return def.costs[level] ?? Infinity;
  return Math.round((def.base ?? 0) * Math.pow(def.growth ?? 1, level));
}

export function rebirthDef(n: number): RebirthDef {
  return REBIRTHS.milestones[n - 1] ?? REBIRTHS.repeatable;
}

/** Requirement for the player's NEXT rebirth. */
export function nextRebirth(rebirths: number): RebirthDef {
  return rebirthDef(rebirths + 1);
}

export function rebirthBonuses(rebirths: number) {
  const out = { coinMult: 1, damageMult: 1, luckMult: 1, slots: 0, enchantSlots: 0 };
  for (let i = 1; i <= rebirths; i++) {
    const d = rebirthDef(i);
    out.coinMult *= d.coinMult;
    out.damageMult *= d.damageMult;
    out.luckMult *= d.luckMult;
    out.slots += d.slots;
    out.enchantSlots += d.enchantSlots;
  }
  return out;
}

export function rankBonuses(rank: number) {
  const out = { slots: 0, enchantSlots: 0, autoFarm: false };
  for (const r of RANKS) {
    if (r.rank > rank) break;
    out.slots += r.rewards.slots ?? 0;
    out.enchantSlots += r.rewards.enchantSlots ?? 0;
    if (r.rewards.unlock === 'autoFarm') out.autoFarm = true;
  }
  return out;
}

export function rankDef(rank: number) {
  return RANKS[Math.min(RANKS.length, Math.max(1, rank)) - 1];
}

export function enchantTotals(save: SaveData): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of save.enchants) {
    const e = ENCHANTS_BY_ID[id];
    if (e) out[e.effect] = (out[e.effect] ?? 0) + e.value;
  }
  return out;
}

export function boostMult(save: SaveData, effect: string, now: number): number {
  const until = save.boosts[effect] ?? 0;
  if (until <= now) return 1;
  const def = Object.values(BOOSTS_BY_ID).find((b) => b.effect === effect);
  return def ? def.mult : 1;
}

export interface DerivedStats {
  damageMult: number;
  coinMult: number;
  gemMult: number;
  itemMult: number;
  luck: number;
  speed: number;
  slots: number;
  invCap: number;
  enchantSlots: number;
  hatchCooldown: number;
  autoFarm: boolean;
  hatchCounts: number[];
}

/** hugeAura = number of Huge pets equipped by everyone in the room (capped in config). */
export function derivedStats(save: SaveData, now: number, hugeAura = 0): DerivedStats {
  const up = (id: string) => save.upgrades[id] ?? 0;
  const per = (id: string) => UPGRADES_BY_ID[id]?.per ?? 0;
  const rb = rebirthBonuses(save.rebirths);
  const rk = rankBonuses(save.rank);
  const en = enchantTotals(save);
  const aura = Math.min(hugeAura, B.hugeAura.maxStacks);
  const counts = [1];
  if (save.unlocks.tripleHatch) counts.push(3);
  if (save.unlocks.octoHatch) counts.push(8);
  return {
    damageMult: (1 + per('damage') * up('damage')) * rb.damageMult * (1 + (en.damage ?? 0)) * boostMult(save, 'damage', now) * (1 + aura * B.hugeAura.damage),
    coinMult: (1 + per('coins') * up('coins')) * rb.coinMult * (1 + (en.coins ?? 0)) * boostMult(save, 'coins', now) * (1 + aura * B.hugeAura.coins),
    gemMult: (1 + per('gemFind') * up('gemFind')) * (1 + (en.gems ?? 0)) * boostMult(save, 'gems', now),
    itemMult: 1 + (en.items ?? 0),
    luck: (1 + per('luck') * up('luck')) * rb.luckMult * (1 + (en.luck ?? 0)) * boostMult(save, 'luck', now),
    speed: B.baseWalkSpeed * (1 + per('speed') * up('speed')) * (1 + (en.speed ?? 0)),
    slots: Math.min(B.maxEquipSlots, B.baseEquipSlots + up('slots') + rb.slots + rk.slots),
    invCap: Math.min(B.maxInventory, B.baseInventory + per('inventory') * up('inventory')),
    enchantSlots: B.baseEnchantSlots + rb.enchantSlots + rk.enchantSlots,
    hatchCooldown: B.hatchCooldownSec * Math.pow(1 - per('hatchSpeed'), up('hatchSpeed')),
    autoFarm: rk.autoFarm,
    hatchCounts: counts,
  };
}

// ------------------------------------------------------------------ eggs
export interface OddsEntry { species: Species; chance: number }
export interface EggOdds {
  entries: OddsEntry[];
  huge: { species: Species; chance: number } | null;
  shiny: number;
  golden: number;
}

/** Exact hatch probabilities for an egg, given the player's luck. Used by the server roll AND the UI. */
export function eggOdds(zone: number, luck: number): EggOdds {
  const z = ZONES[zone];
  const fam = FAMILY_SPECIES[z.egg.family.id];
  const tierOdds = B.eggOdds[z.egg.tier] ?? B.eggOdds[0];
  const raw: { species: Species; w: number }[] = [];
  for (const [rarity, w] of Object.entries(tierOdds)) {
    const sp = fam[rarity as Rarity];
    if (!sp) continue;
    const boosted = B.luckAffects.includes(rarity) ? w * luck : w;
    raw.push({ species: sp, w: boosted });
  }
  const secretSp = SECRET_SPECIES[z.themeIndex % SECRET_SPECIES.length];
  const secretChance = Math.min(0.01, B.secretChance * Math.pow(luck, B.luckExtraRollExponent));
  const total = raw.reduce((a, r) => a + r.w, 0);
  const entries: OddsEntry[] = raw.map((r) => ({ species: r.species, chance: (r.w / total) * (1 - secretChance) }));
  if (secretSp) entries.push({ species: secretSp, chance: secretChance });
  const mythic = fam.mythic ?? null;
  return {
    entries,
    huge: mythic ? { species: mythic, chance: Math.min(0.01, B.hugeChance * Math.pow(luck, B.luckExtraRollExponent)) } : null,
    shiny: B.shinyChance,
    golden: B.goldenHatchChance,
  };
}

/** rnd() must return uniform [0,1). Returns a pet without an id. */
export function rollEgg(zone: number, luck: number, rnd: () => number): Omit<PetInstance, 'id'> {
  const odds = eggOdds(zone, luck);
  if (odds.huge && rnd() < odds.huge.chance) {
    return { s: odds.huge.species.id, v: 'normal', hg: true, z: zone, sh: rnd() < odds.shiny || undefined };
  }
  let r = rnd();
  let picked = odds.entries[0].species;
  for (const e of odds.entries) {
    if (r < e.chance) { picked = e.species; break; }
    r -= e.chance;
  }
  const golden = rnd() < odds.golden;
  const shiny = rnd() < odds.shiny;
  return { s: picked.id, v: golden ? 'golden' : 'normal', z: zone, sh: shiny || undefined };
}

export function weightedPick<T extends { w: number }>(list: T[], rnd: () => number): T {
  const total = list.reduce((a, b) => a + b.w, 0);
  let r = rnd() * total;
  for (const it of list) {
    if (r < it.w) return it;
    r -= it.w;
  }
  return list[list.length - 1];
}

export function breakableHp(type: string, zone: number): number {
  return Math.round(B.breakables[type].hp * zoneMult(zone));
}

export function petName(p: Pick<PetInstance, 's' | 'v' | 'sh' | 'hg'>): string {
  const sp = SPECIES_BY_ID[p.s];
  const parts: string[] = [];
  if (p.hg) parts.push('Huge');
  if (p.sh) parts.push('Shiny');
  if (p.v === 'golden') parts.push('Golden');
  if (p.v === 'rainbow') parts.push('Rainbow');
  parts.push(sp?.name ?? 'Unknown');
  return parts.join(' ');
}

export function petStars(p: Pick<PetInstance, 'z'>): number {
  return ((p.z - 1) % B.zonesPerTheme) + 1;
}

export function indexBits(p: Pick<PetInstance, 'v' | 'sh' | 'hg'>): number {
  let b = p.v === 'golden' ? 2 : p.v === 'rainbow' ? 4 : 1;
  if (p.sh) b |= 8;
  if (p.hg) b |= 16;
  return b;
}

const SUFFIX = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc', 'Ud', 'Dd', 'Td'];
export function fmt(n: number): string {
  if (!isFinite(n)) return '∞';
  const neg = n < 0;
  n = Math.abs(n);
  if (n < 1000) return (neg ? '-' : '') + (n < 10 && n % 1 ? n.toFixed(1) : Math.floor(n).toString());
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SUFFIX.length) return (neg ? '-' : '') + n.toExponential(2);
  const v = n / Math.pow(1000, tier);
  return (neg ? '-' : '') + (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.floor(v).toString()) + SUFFIX[tier];
}

export function fmtPct(p: number): string {
  if (p <= 0) return '0%';
  const pct = p * 100;
  if (pct >= 1) return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  return `1 in ${fmt(Math.round(1 / p))}`;
}

export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.ceil(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}
