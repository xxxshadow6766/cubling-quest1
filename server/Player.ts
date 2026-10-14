import type { Socket } from 'socket.io';
import type { PetInstance, PublicPlayer, SaveData } from '../shared/types';
import { derivedStats, type DerivedStats } from '../shared/formulas';
import { zoneAtZ, zoneSpawn } from '../shared/world';
import type { Room } from './Room';
import type { Trade } from './trade';

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private rate: number, private burst: number) {
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

const PLAYER_COLORS = ['#4da3ff', '#ff6b8b', '#5ad88a', '#ffb347', '#b77bff', '#3fd6d0', '#ff7a45', '#e05ad8', '#8bd346', '#ffd23f', '#6a7bff', '#ff4f6a'];

export class Player {
  socket: Socket | null = null;
  room: Room | null = null;
  trade: Trade | null = null;
  x: number;
  y = 0;
  z: number;
  ry = 0;
  lastMoveAt = Date.now();
  /** petId -> { breakable id, time assigned } */
  targets = new Map<string, { bk: string; at: number }>();
  targetsChanged = false;
  autoFarm = false;
  autoFarmAt = 0;
  lastHatch = 0;
  lastChat = 0;
  disconnectedAt = 0;
  /** request-id -> cached result, for duplicate request suppression */
  recent = new Map<string, unknown>();
  dirty = false; // needs DB write
  metaDirty = false; // needs 'me' push
  petsDirty = false; // needs 'pets' push
  curDirty = false; // needs 'cur' push
  lastPush = 0;
  readonly color: string;
  readonly actBucket = new TokenBucket(15, 30);
  readonly moveBucket = new TokenBucket(25, 40);

  constructor(public id: string, public nickname: string, public save: SaveData) {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    this.color = PLAYER_COLORS[h % PLAYER_COLORS.length];
    const spawn = save.lastPos ?? zoneSpawn(0);
    this.x = spawn.x;
    this.z = spawn.z;
  }

  get connected() {
    return !!this.socket?.connected;
  }

  get currentZone() {
    return zoneAtZ(this.z);
  }

  stats(now = Date.now()): DerivedStats {
    return derivedStats(this.save, now, this.room?.hugeAura() ?? 0);
  }

  pet(id: string): PetInstance | undefined {
    return this.save.pets.find((p) => p.id === id);
  }

  equippedPets(): PetInstance[] {
    const out: PetInstance[] = [];
    for (const id of this.save.equipped) {
      const p = this.pet(id);
      if (p) out.push(p);
    }
    return out;
  }

  markAll() {
    this.dirty = this.metaDirty = this.petsDirty = this.curDirty = true;
  }

  remember(rid: string, result: unknown) {
    this.recent.set(rid, result);
    if (this.recent.size > 100) {
      const first = this.recent.keys().next().value;
      if (first !== undefined) this.recent.delete(first);
    }
  }

  publicView(): PublicPlayer {
    return {
      id: this.id,
      name: this.nickname,
      color: this.color,
      connected: this.connected,
      zone: this.save.zone,
      rank: this.save.rank,
      rebirths: this.save.rebirths,
      pets: this.equippedPets().map((p) => ({ id: p.id, s: p.s, v: p.v, sh: p.sh, hg: p.hg })),
      x: this.x,
      y: this.y,
      z: this.z,
      ry: this.ry,
    };
  }

  emit(ev: string, data?: unknown) {
    this.socket?.emit(ev, data);
  }

  toast(text: string, kind = 'info') {
    this.emit('toast', { text, kind });
  }
}
