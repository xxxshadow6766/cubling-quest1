// Loads the editable JSON config files and derives the 99 data-driven zones.
import balanceJson from '../config/balance.json';
import themesJson from '../config/themes.json';
import eggsJson from '../config/eggs.json';
import petsJson from '../config/pets.json';
import upgradesJson from '../config/upgrades.json';
import rebirthsJson from '../config/rebirths.json';
import ranksJson from '../config/ranks.json';
import questsJson from '../config/quests.json';
import achievementsJson from '../config/achievements.json';
import itemsJson from '../config/items.json';
import enchantsJson from '../config/enchants.json';
import dailyJson from '../config/daily.json';
import eventsJson from '../config/events.json';
import townJson from '../config/town.json';
import type { Rarity } from './types';

export interface BreakableDef {
  name: string; model: string; scale: number; radius: number; hp: number; coins: number;
  gemChance: number; gems: number; itemChance: number; enchantChance: number; hugeChance?: number;
}
export type Balance = typeof balanceJson & { breakables: Record<string, BreakableDef>; rarities: Rarity[]; eggOdds: Record<string, number>[] };
export const BALANCE = balanceJson as unknown as Balance;

export interface SceneryDef { m: string; t: string; n: number; s: number[]; f?: number }
export interface Theme {
  id: string; name: string; zoneNames: string[]; sky: string; fog: string; ground: string; ground2: string;
  path: string; wall: string; gate: string; accent: string; ambient: string; scenery: SceneryDef[]; mix: Record<string, number>;
}
export const THEMES = themesJson.themes as Theme[];

export interface EggFamily { id: string; name: string; shell: string; spot: string }
export const EGG_FAMILIES = eggsJson.families as EggFamily[];

export interface Species {
  id: string; name: string; f: string; r: Rarity; c: string[]; p: string[]; sc?: number[]; m?: number;
}
export const SPECIES = petsJson.species as Species[];
export const SPECIES_BY_ID: Record<string, Species> = Object.fromEntries(SPECIES.map((s) => [s.id, s]));
export const FAMILY_SPECIES: Record<string, Partial<Record<Rarity, Species>>> = {};
for (const s of SPECIES) {
  (FAMILY_SPECIES[s.f] ??= {})[s.r] = s;
}
export const SECRET_SPECIES = SPECIES.filter((s) => s.r === 'secret');

export interface UpgradeDef { id: string; name: string; icon: string; currency: 'coins' | 'gems'; max: number; base?: number; growth?: number; costs?: number[]; per: number; desc: string }
export const UPGRADES = upgradesJson.upgrades as UpgradeDef[];
export const UPGRADES_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));
export interface UnlockDef { id: string; name: string; icon: string; cost: number; desc: string; requires?: string }
export const UNLOCKS = upgradesJson.unlocks as UnlockDef[];

export interface RebirthDef { n?: number; requiresZone: number; title?: string; coinMult: number; damageMult: number; luckMult: number; slots: number; enchantSlots: number; gems: number; unlock?: string | null; desc: string }
export const REBIRTHS = rebirthsJson as unknown as { resets: string[]; keeps: string[]; milestones: RebirthDef[]; repeatable: RebirthDef };

export interface RankDef { rank: number; name: string; xp: number; rewards: { gems?: number; slots?: number; enchantSlots?: number; unlock?: string; items?: Record<string, number> } }
export const RANKS = ranksJson.ranks as RankDef[];

export interface QuestTemplate { id: string; type: string; label: string; base?: number; perRank?: number; factor?: number; xp: number; gems: number; minRank?: number; minZone?: number; coop?: boolean; needsLockedZone?: boolean; needsItem?: boolean }
export const QUESTS = questsJson as { active: number; templates: QuestTemplate[] };

export interface AchievementDef { id: string; name: string; icon: string; stat: string; desc: string; tiers: number[]; gems: number[] }
export const ACHIEVEMENTS = achievementsJson.achievements as AchievementDef[];

export interface BoostDef { id: string; name: string; icon: string; effect: string; mult: number; duration: number; desc: string }
export const ITEMS = itemsJson as { maxStackSec: number; boosts: BoostDef[]; dropTable: { id: string; w: number }[] };
export const BOOSTS_BY_ID: Record<string, BoostDef> = Object.fromEntries(ITEMS.boosts.map((b) => [b.id, b]));

export interface EnchantDef { id: string; name: string; icon: string; effect: string; value: number; w: number }
export const ENCHANTS = enchantsJson.books as EnchantDef[];
export const ENCHANTS_BY_ID: Record<string, EnchantDef> = Object.fromEntries(ENCHANTS.map((e) => [e.id, e]));

export const DAILY = dailyJson as unknown as { cooldownHours: number; streakResetHours: number; days: { gems: number; items: Record<string, number>; enchant?: boolean }[] };
export const EVENTS = eventsJson;

export interface StationDef { id: string; name: string; icon: string; model: string; tint: string; x: number; z: number; ry: number; scale?: number }
export const TOWN = townJson as { spawn: { x: number; z: number }; stations: StationDef[]; decor: { model: string; x: number; z: number; tint?: string; scale?: number }[] };

// ------------------------------------------------------------------ zones (derived)
export interface ZoneDef {
  n: number;
  name: string;
  theme: Theme;
  themeIndex: number;
  /** egg family + tier sold in this zone */
  egg: { family: EggFamily; tier: number; name: string };
  gateCost: number;
  eggCost: number;
  boss: boolean;
}

const G = BALANCE;
export const ZONES: ZoneDef[] = [];
for (let n = 0; n <= G.zoneCount; n++) {
  const ti = n === 0 ? 0 : Math.min(THEMES.length - 1, Math.floor((n - 1) / G.zonesPerTheme));
  const theme = THEMES[ti];
  const tier = n === 0 ? 0 : (n - 1) % G.zonesPerTheme;
  const fam = EGG_FAMILIES[ti];
  ZONES.push({
    n,
    name: n === 0 ? 'Town' : theme.zoneNames[tier] ?? `${theme.name} ${tier + 1}`,
    theme,
    themeIndex: ti,
    egg: { family: fam, tier, name: `${G.eggTierNames[tier]}${fam.name}` },
    gateCost: n <= 1 ? 0 : Math.round(G.gateCostBase * Math.pow(G.gateCostGrowth, n - 2)),
    eggCost: n === 0 ? 0 : Math.round(G.eggCostBase * Math.pow(G.eggCostGrowth, n - 1)),
    boss: n > 0 && (n % EVENTS.bossChest.everyNZones === 0 || EVENTS.bossChest.alsoZones.includes(n)),
  });
}

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#b8c2cc',
  rare: '#4fa3ff',
  epic: '#b06aff',
  legendary: '#ffb02e',
  mythic: '#ff4f7b',
  secret: '#1de9b6',
};
export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary', 'mythic', 'secret'];
