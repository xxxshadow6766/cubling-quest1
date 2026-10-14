export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic' | 'secret';
export type Variant = 'normal' | 'golden' | 'rainbow';

/** One owned pet. Power is always derived from config (never stored), so balance edits apply retroactively. */
export interface PetInstance {
  id: string;
  /** species id */
  s: string;
  v: Variant;
  /** shiny */
  sh?: boolean;
  /** huge */
  hg?: boolean;
  /** zone of the egg it hatched from (scales power) */
  z: number;
  /** locked against delete / convert / trade */
  lk?: boolean;
}

export interface QuestState {
  tpl: string;
  target: number;
  progress: number;
  xp: number;
  gems: number;
  label: string;
}

export interface SaveData {
  v: number;
  coins: number;
  gems: number;
  pets: PetInstance[];
  equipped: string[];
  /** highest unlocked area (1..99) */
  zone: number;
  rebirths: number;
  upgrades: Record<string, number>;
  unlocks: Record<string, boolean>;
  rank: number;
  rankXp: number;
  quests: QuestState[];
  /** achievement id -> number of tiers already granted */
  achievements: Record<string, number>;
  stats: Record<string, number>;
  /** species id -> bitmask of discovered variants (1 normal, 2 golden, 4 rainbow, 8 shiny, 16 huge) */
  index: Record<string, number>;
  items: Record<string, number>;
  /** boost effect -> expiry timestamp (ms) */
  boosts: Record<string, number>;
  /** enchant book id -> owned count */
  books: Record<string, number>;
  /** equipped enchant book ids (one entry per slot used) */
  enchants: string[];
  daily: { last: number; streak: number };
  tutorial: number;
  autoDelete: Rarity[];
  lastPos?: { x: number; z: number };
  createdAt: number;
}

export interface BreakableState {
  id: string;
  type: string;
  zone: number;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  /** event tag: 'boss' | 'comet' */
  ev?: string;
}

export interface PublicPlayer {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  zone: number;
  rank: number;
  rebirths: number;
  /** equipped pets (public appearance info only) */
  pets: Pick<PetInstance, 'id' | 's' | 'v' | 'sh' | 'hg'>[];
  x: number;
  y: number;
  z: number;
  ry: number;
}

export interface RoomInfo {
  code: string;
  mode: 'solo' | 'friends';
  ownerId: string;
  capacity: number;
}

export interface RoomEventState {
  frenzyUntil: number;
  nextFrenzy: number;
  nextComet: number;
  comet?: { zone: number; id: string; until: number } | null;
}

export interface TradeOffer {
  pets: string[];
  gems: number;
}

export interface TradeView {
  id: string;
  a: string;
  b: string;
  aName: string;
  bName: string;
  offers: Record<string, TradeOffer>;
  /** public appearance of offered pets so the other side can render them */
  petInfo: Record<string, PetInstance>;
  ready: Record<string, boolean>;
  version: number;
  countdownEnd: number;
  state: 'open' | 'countdown' | 'done' | 'cancelled';
}

export interface RewardEvent {
  bk: string;
  x: number;
  z: number;
  coins: number;
  gems: number;
  items: string[];
  books: string[];
  pets: PetInstance[];
  share: number;
}
