import { BALANCE, SPECIES_BY_ID } from '../shared/config';
import type { PetInstance, SaveData } from '../shared/types';
import { newId } from './auth';

export const SAVE_VERSION = 1;

export function newSave(): SaveData {
  const starter: PetInstance = { id: newId(), s: BALANCE.starterPet, v: 'normal', z: 1 };
  return {
    v: SAVE_VERSION,
    coins: BALANCE.startingCoins,
    gems: BALANCE.startingGems,
    pets: [starter],
    equipped: [starter.id],
    zone: 1,
    rebirths: 0,
    upgrades: {},
    unlocks: {},
    rank: 1,
    rankXp: 0,
    quests: [],
    achievements: {},
    stats: {},
    index: { [starter.s]: 1 },
    items: {},
    boosts: {},
    books: {},
    enchants: [],
    daily: { last: 0, streak: 0 },
    tutorial: 0,
    autoDelete: [],
    createdAt: Date.now(),
  };
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Defensive load: fills missing fields and drops anything invalid so old saves keep working. */
export function loadSave(json: string): SaveData {
  let raw: Partial<SaveData>;
  try {
    raw = JSON.parse(json);
  } catch {
    raw = {};
  }
  const base = newSave();
  const s: SaveData = { ...base, ...raw } as SaveData;
  s.v = SAVE_VERSION;
  s.coins = Math.max(0, num(s.coins));
  s.gems = Math.max(0, Math.floor(num(s.gems)));
  s.pets = Array.isArray(s.pets) ? s.pets.filter((p) => p && typeof p.id === 'string' && SPECIES_BY_ID[p.s]) : base.pets;
  if (!s.pets.length) s.pets = base.pets;
  const ids = new Set(s.pets.map((p) => p.id));
  s.equipped = Array.isArray(s.equipped) ? [...new Set(s.equipped.filter((id) => ids.has(id)))] : [];
  s.zone = Math.min(BALANCE.zoneCount, Math.max(1, Math.floor(num(s.zone, 1))));
  s.rebirths = Math.max(0, Math.floor(num(s.rebirths)));
  s.rank = Math.max(1, Math.floor(num(s.rank, 1)));
  s.rankXp = Math.max(0, num(s.rankXp));
  for (const k of ['upgrades', 'unlocks', 'achievements', 'stats', 'index', 'items', 'boosts', 'books'] as const) {
    if (!s[k] || typeof s[k] !== 'object') (s as any)[k] = {};
  }
  if (!Array.isArray(s.quests)) s.quests = [];
  if (!Array.isArray(s.enchants)) s.enchants = [];
  if (!Array.isArray(s.autoDelete)) s.autoDelete = [];
  if (!s.daily || typeof s.daily !== 'object') s.daily = { last: 0, streak: 0 };
  s.tutorial = Math.floor(num(s.tutorial));
  return s;
}
