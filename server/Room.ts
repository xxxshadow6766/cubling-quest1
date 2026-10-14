// A room is one shared world instance (solo rooms simply have capacity 1).
// The room simulates breakables, pet damage, rewards and cooperative events at 10 Hz.
import { BALANCE, ENCHANTS, EVENTS, FAMILY_SPECIES, ITEMS, ZONES } from '../shared/config';
import { breakableHp, gemZoneMult, indexBits, petName, petPower, weightedPick, zoneMult } from '../shared/formulas';
import type { BreakableState, PetInstance, RewardEvent, RoomEventState, RoomInfo } from '../shared/types';
import { bossPos, dist2, randomFieldPoint, zoneAtZ } from '../shared/world';
import { newId } from './auth';
import type { GameServer } from './GameServer';
import type { Player } from './Player';
import { bump, refreshDerivedStats } from './progress';
import { rand, stochasticRound } from './rng';

interface Breakable extends BreakableState {
  dmg: Map<string, number>;
  spawnedAt: number;
}
interface ZoneRuntime {
  lastActive: number;
  spawnAcc: number;
  bossAt: number;
  bossId: string | null;
  filled: boolean;
}

const TICK_MS = 100;
const randBetween = (a: number, b: number) => a + rand() * (b - a);

export class Room {
  readonly members = new Map<string, Player>();
  readonly breakables = new Map<string, Breakable>();
  private zones = new Map<number, ZoneRuntime>();
  readonly ev: RoomEventState;
  private hpChanged = new Set<string>();
  private added: BreakableState[] = [];
  private removedSilently: string[] = [];
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  emptySince = Date.now();
  lastPersist = 0;

  constructor(
    readonly gs: GameServer,
    readonly code: string,
    readonly mode: 'solo' | 'friends',
    public ownerId: string,
    readonly banned: Set<string>,
    readonly createdAt: number,
  ) {
    const now = Date.now();
    this.ev = {
      frenzyUntil: 0,
      nextFrenzy: now + randBetween(EVENTS.frenzy.intervalSec[0], EVENTS.frenzy.intervalSec[1]) * 1000,
      nextComet: now + randBetween(EVENTS.comet.intervalSec[0], EVENTS.comet.intervalSec[1]) * 1000,
      comet: null,
    };
  }

  get channel() {
    return `room:${this.code}`;
  }
  get capacity() {
    return this.mode === 'solo' ? 1 : BALANCE.roomCapacity;
  }
  info(): RoomInfo {
    return { code: this.code, mode: this.mode, ownerId: this.ownerId, capacity: this.capacity };
  }
  connectedMembers(): Player[] {
    return [...this.members.values()].filter((p) => p.connected);
  }
  hugeAura(): number {
    let n = 0;
    for (const p of this.members.values()) {
      if (!p.connected) continue;
      for (const pet of p.equippedPets()) if (pet.hg) n++;
    }
    return n;
  }
  broadcast(ev: string, data?: unknown) {
    this.gs.io.to(this.channel).emit(ev, data);
  }
  persist() {
    this.gs.store.putRoom({ code: this.code, mode: this.mode, ownerId: this.ownerId, banned: [...this.banned], createdAt: this.createdAt });
  }

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        console.error(`[room ${this.code}] tick error`, e);
      }
    }, TICK_MS);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  publicBreakable(b: Breakable): BreakableState {
    return { id: b.id, type: b.type, zone: b.zone, x: b.x, z: b.z, hp: b.hp, maxHp: b.maxHp, ev: b.ev };
  }
  snapshotBreakables(): BreakableState[] {
    return [...this.breakables.values()].map((b) => this.publicBreakable(b));
  }
  petTargets(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const p of this.members.values()) out[p.id] = this.targetsOf(p);
    return out;
  }
  targetsOf(p: Player): Record<string, string> {
    const t: Record<string, string> = {};
    for (const [pet, v] of p.targets) t[pet] = v.bk;
    return t;
  }

  // ---------------------------------------------------------------- membership
  addMember(p: Player) {
    this.members.set(p.id, p);
    p.room = this;
    this.emptySince = 0;
    this.broadcast('pj', p.publicView());
  }

  removeMember(p: Player, reason: string) {
    if (!this.members.has(p.id)) return;
    this.members.delete(p.id);
    p.targets.clear();
    if (p.trade) this.gs.trades.cancel(p.trade, `${p.nickname} left the room`);
    if (p.room === this) p.room = null;
    p.socket?.leave(this.channel);
    this.broadcast('pl', { id: p.id, reason });
    if (this.ownerId === p.id && this.mode === 'friends') {
      const next = this.connectedMembers()[0] ?? [...this.members.values()][0];
      if (next) {
        this.ownerId = next.id;
        this.broadcast('room', this.info());
        this.broadcast('evmsg', { text: `👑 ${next.nickname} is now the room owner.` });
      }
    }
    this.persist();
    if (!this.connectedMembers().length) this.emptySince = Date.now();
  }

  // ---------------------------------------------------------------- simulation
  private zoneRt(z: number, now: number): ZoneRuntime {
    let rt = this.zones.get(z);
    if (!rt) {
      rt = { lastActive: now, spawnAcc: 0, bossAt: now + EVENTS.bossChest.firstSpawnDelaySec * 1000, bossId: null, filled: false };
      this.zones.set(z, rt);
    }
    return rt;
  }

  spawn(zone: number, now: number, type?: string, pos?: { x: number; z: number }, ev?: string): Breakable {
    const theme = ZONES[zone].theme;
    const t = type ?? weightedPick(Object.entries(theme.mix).map(([id, w]) => ({ id, w })), rand).id;
    let pt = pos;
    if (!pt) {
      for (let i = 0; i < 6; i++) {
        pt = randomFieldPoint(zone, rand);
        let ok = true;
        for (const b of this.breakables.values()) {
          if (b.zone === zone && Math.hypot(b.x - pt.x, b.z - pt.z) < 3.2) {
            ok = false;
            break;
          }
        }
        if (ok) break;
      }
    }
    const hp = breakableHp(t, zone);
    const b: Breakable = {
      id: (++this.seq).toString(36), type: t, zone, x: +pt!.x.toFixed(2), z: +pt!.z.toFixed(2), hp, maxHp: hp, ev, dmg: new Map(), spawnedAt: now,
    };
    this.breakables.set(b.id, b);
    this.added.push(this.publicBreakable(b));
    return b;
  }

  private removeSilently(b: Breakable) {
    this.breakables.delete(b.id);
    this.removedSilently.push(b.id);
  }

  tick() {
    const now = Date.now();
    const dt = Math.min(0.25, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const online = this.connectedMembers();

    // grace-period cleanup of disconnected members
    for (const p of this.members.values()) {
      if (!p.connected && p.disconnectedAt && now - p.disconnectedAt > BALANCE.roomGraceSec * 1000) {
        this.removeMember(p, 'timed out');
      }
    }
    if (!online.length) return;

    // ---- active zones (where players are, plus neighbours so walking feels seamless)
    const playersInZone = new Map<number, number>();
    const maxUnlocked = Math.max(...online.map((p) => p.save.zone));
    for (const p of online) {
      const z = p.currentZone;
      playersInZone.set(z, (playersInZone.get(z) ?? 0) + 1);
      for (const n of [z - 1, z, z + 1]) {
        if (n < 1 || n > BALANCE.zoneCount || n > maxUnlocked + 1) continue;
        this.zoneRt(n, now).lastActive = now;
      }
    }

    const frenzy = now < this.ev.frenzyUntil;
    for (const [z, rt] of this.zones) {
      if (now - rt.lastActive > BALANCE.zoneIdleDespawnSec * 1000) {
        for (const b of [...this.breakables.values()]) if (b.zone === z && b.ev !== 'comet') this.removeSilently(b);
        this.zones.delete(z);
        continue;
      }
      if (now - rt.lastActive > 1000) continue; // keep existing but don't spawn while nobody is near
      let count = 0;
      for (const b of this.breakables.values()) if (b.zone === z && !b.ev) count++;
      const cap = Math.min(BALANCE.zoneBreakableMax, BALANCE.zoneBreakableBase + BALANCE.zoneBreakablePerPlayer * (playersInZone.get(z) ?? 0));
      if (!rt.filled) {
        while (count < cap) {
          this.spawn(z, now);
          count++;
        }
        rt.filled = true;
      }
      rt.spawnAcc += dt * (frenzy ? EVENTS.frenzy.spawnMult : 1);
      while (rt.spawnAcc >= BALANCE.spawnIntervalSec) {
        rt.spawnAcc -= BALANCE.spawnIntervalSec;
        if (count < cap) {
          this.spawn(z, now);
          count++;
        }
      }
      if (ZONES[z].boss && !rt.bossId && now >= rt.bossAt) {
        const b = this.spawn(z, now, 'boss_chest', bossPos(z), 'boss');
        rt.bossId = b.id;
        this.broadcast('evmsg', { text: `👑 A Boss Chest appeared in ${ZONES[z].name}! Team up to crack it open!`, kind: 'boss', zone: z });
      }
    }

    this.tickEvents(now, online);

    // ---- pets deal damage
    const destroyed = new Set<Breakable>();
    for (const p of online) {
      const st = p.stats(now);
      const pets = p.equippedPets();
      if (p.autoFarm && now - p.autoFarmAt > 400) {
        p.autoFarmAt = now;
        this.autoAssign(p, pets, now);
      }
      for (const pet of pets) {
        const t = p.targets.get(pet.id);
        if (!t) continue;
        const bk = this.breakables.get(t.bk);
        if (!bk || bk.hp <= 0 || bk.zone > p.save.zone || dist2(p.x, p.z, bk.x, bk.z) > BALANCE.petAttackRange) {
          p.targets.delete(pet.id);
          p.targetsChanged = true;
          continue;
        }
        if (now - t.at < BALANCE.petTravelDelaySec * 1000) continue;
        const dmg = Math.min(bk.hp, petPower(pet) * st.damageMult * dt);
        bk.hp -= dmg;
        bk.dmg.set(p.id, (bk.dmg.get(p.id) ?? 0) + dmg);
        this.hpChanged.add(bk.id);
        if (bk.hp <= 1e-9) destroyed.add(bk);
      }
    }
    for (const b of destroyed) this.destroy(b, now);

    // ---- network flush
    if (this.added.length) {
      this.broadcast('bka', this.added);
      this.added = [];
    }
    if (this.removedSilently.length) {
      this.broadcast('bkrs', this.removedSilently);
      this.removedSilently = [];
    }
    if (this.hpChanged.size) {
      const list: [string, number][] = [];
      for (const id of this.hpChanged) {
        const b = this.breakables.get(id);
        if (b) list.push([id, Math.ceil(b.hp)]);
      }
      if (list.length) this.broadcast('hp', list);
      this.hpChanged.clear();
    }
    for (const p of this.members.values()) {
      if (p.targetsChanged) {
        p.targetsChanged = false;
        this.broadcast('pt', { id: p.id, t: this.targetsOf(p) });
      }
    }
    const snap = online.map((p) => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2)]);
    this.gs.io.to(this.channel).volatile.emit('s', snap);
    for (const p of online) this.gs.flush(p, false);
  }

  private tickEvents(now: number, online: Player[]) {
    const E = EVENTS;
    if (now >= this.ev.nextFrenzy) {
      this.ev.frenzyUntil = now + E.frenzy.durationSec * 1000;
      this.ev.nextFrenzy = now + randBetween(E.frenzy.intervalSec[0], E.frenzy.intervalSec[1]) * 1000;
      this.broadcast('ev', this.ev);
      this.broadcast('evmsg', { text: `🪙 COIN FRENZY! ×${E.frenzy.coinMult} coins and faster spawns for ${E.frenzy.durationSec}s!`, kind: 'frenzy' });
    }
    const comet = this.ev.comet;
    if (comet && now > comet.until) {
      const b = this.breakables.get(comet.id);
      if (b) this.removeSilently(b);
      this.ev.comet = null;
      this.broadcast('ev', this.ev);
      this.broadcast('evmsg', { text: '☄️ The comet faded away…' });
    }
    if (!this.ev.comet && now >= this.ev.nextComet) {
      const zones = [...new Set(online.map((p) => p.currentZone).filter((z) => z >= 1))];
      if (!zones.length) {
        this.ev.nextComet = now + 30_000;
      } else {
        const z = zones[Math.floor(rand() * zones.length)];
        const b = this.spawn(z, now, 'comet', undefined, 'comet');
        this.ev.comet = { zone: z, id: b.id, until: now + E.comet.lifetimeSec * 1000 };
        this.ev.nextComet = now + randBetween(E.comet.intervalSec[0], E.comet.intervalSec[1]) * 1000;
        this.broadcast('ev', this.ev);
        this.broadcast('evmsg', { text: `☄️ A Comet crashed into ${ZONES[z].name}! Break it together for gems and rare loot!`, kind: 'comet', zone: z });
      }
    }
  }

  private autoAssign(p: Player, pets: PetInstance[], now: number) {
    const idle = pets.filter((pet) => {
      const t = p.targets.get(pet.id);
      return !t || !this.breakables.has(t.bk);
    });
    if (!idle.length) return;
    const cands = [...this.breakables.values()]
      .filter((b) => b.zone <= p.save.zone && dist2(p.x, p.z, b.x, b.z) <= BALANCE.autoFarmRange)
      .sort((a, b) => dist2(p.x, p.z, a.x, a.z) - dist2(p.x, p.z, b.x, b.z));
    if (!cands.length) return;
    const busy = new Set([...p.targets.values()].map((t) => t.bk));
    const order = [...cands.filter((b) => !busy.has(b.id)), ...cands.filter((b) => busy.has(b.id))];
    idle.forEach((pet, i) => p.targets.set(pet.id, { bk: order[i % order.length].id, at: now }));
    p.targetsChanged = true;
  }

  /** Breakable destroyed: split rewards by damage contribution (+ team bonus). */
  private destroy(bk: Breakable, now: number) {
    this.breakables.delete(bk.id);
    this.hpChanged.delete(bk.id);
    const def = BALANCE.breakables[bk.type];
    const entries = [...bk.dmg.entries()].filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, [, d]) => a + d, 0) || 1;
    const team = 1 + Math.min(BALANCE.teamBonusMax, BALANCE.teamBonusPerPlayer * Math.max(0, this.connectedMembers().length - 1));
    const frenzy = now < this.ev.frenzyUntil ? EVENTS.frenzy.coinMult : 1;
    const zm = zoneMult(bk.zone);
    const coop = entries.length >= 2;
    const isBig = bk.type === 'safe' || bk.type === 'chest' || bk.type === 'boss_chest';
    const isEvent = !!bk.ev;

    for (const [pid, d] of entries) {
      const p = this.gs.players.get(pid);
      if (!p) continue;
      const share = d / total;
      const st = p.stats(now);
      const coins = def.coins * zm * share * st.coinMult * team * frenzy;
      let gems = 0;
      if (rand() < def.gemChance) gems = stochasticRound(def.gems * gemZoneMult(bk.zone) * share * st.gemMult);
      const items: string[] = [];
      const books: string[] = [];
      const pets: PetInstance[] = [];
      const lootScale = isEvent ? (share >= 0.1 ? 1 : 0) : share;
      if (rand() < def.itemChance * st.itemMult * lootScale) items.push(weightedPick(ITEMS.dropTable, rand).id);
      if (rand() < def.enchantChance * lootScale) books.push(weightedPick(ENCHANTS, rand).id);
      if (def.hugeChance && share >= 0.05 && rand() < def.hugeChance * Math.sqrt(st.luck)) {
        const sp = FAMILY_SPECIES[ZONES[bk.zone].egg.family.id]?.mythic;
        if (sp) pets.push({ id: newId(), s: sp.id, v: 'normal', hg: true, z: bk.zone });
      }

      const s = p.save;
      s.coins += coins;
      s.gems += gems;
      for (const it of items) s.items[it] = (s.items[it] ?? 0) + 1;
      for (const bkId of books) s.books[bkId] = (s.books[bkId] ?? 0) + 1;
      for (const pet of pets) {
        s.pets.push(pet); // Huge pets are never lost to a full inventory
        s.index[pet.s] = (s.index[pet.s] ?? 0) | indexBits(pet);
        bump(p, 'hugeHatched');
        this.broadcast('evmsg', { text: `🎉 ${p.nickname} found a HUGE ${petName(pet)}!`, kind: 'huge' });
      }
      bump(p, 'breakables');
      bump(p, 'coinsEarned', coins);
      if (gems) bump(p, 'gemsEarned', gems);
      if (isBig) bump(p, 'chests');
      if (coop) bump(p, 'coopBreaks');
      if (bk.ev === 'boss') bump(p, 'bossChests');
      if (pets.length) refreshDerivedStats(p);
      p.curDirty = true;
      p.dirty = true;
      if (items.length || books.length) p.metaDirty = true;
      if (pets.length) {
        p.petsDirty = true;
        this.gs.saveNow(p);
      }
      const ev: RewardEvent = { bk: bk.id, x: bk.x, z: bk.z, coins, gems, items, books, pets, share };
      p.emit('reward', ev);
    }

    this.broadcast('bkr', { id: bk.id, x: bk.x, z: bk.z, type: bk.type, by: entries.map(([pid]) => pid) });
    for (const p of this.members.values()) {
      for (const [petId, t] of p.targets) {
        if (t.bk === bk.id) {
          p.targets.delete(petId);
          p.targetsChanged = true;
        }
      }
    }
    if (bk.ev === 'boss') {
      const rt = this.zones.get(bk.zone);
      if (rt) {
        rt.bossId = null;
        rt.bossAt = now + EVENTS.bossChest.respawnSec * 1000;
      }
      this.broadcast('evmsg', { text: `👑 The Boss Chest in ${ZONES[bk.zone].name} was destroyed by ${entries.length} player${entries.length > 1 ? 's' : ''}!`, kind: 'boss' });
    }
    if (bk.ev === 'comet') {
      this.ev.comet = null;
      this.broadcast('ev', this.ev);
    }
  }

  /** Manual targeting. Returns false if not allowed. */
  setTarget(p: Player, bkId: string | null): { ok: boolean; error?: string; toggledOff?: boolean } {
    const now = Date.now();
    const pets = p.equippedPets();
    if (!pets.length) return { ok: false, error: 'Equip a pet first!' };
    if (bkId === null) {
      p.targets.clear();
      p.targetsChanged = true;
      return { ok: true };
    }
    const bk = this.breakables.get(bkId);
    if (!bk) return { ok: false, error: 'That object is already gone.' };
    if (bk.zone > p.save.zone) return { ok: false, error: 'Unlock this area first!' };
    if (dist2(p.x, p.z, bk.x, bk.z) > BALANCE.petAttackRange) return { ok: false, error: 'Too far away — move closer!' };
    const all = pets.every((pet) => p.targets.get(pet.id)?.bk === bkId);
    if (all) {
      p.targets.clear();
      p.targetsChanged = true;
      return { ok: true, toggledOff: true };
    }
    for (const pet of pets) {
      const prev = p.targets.get(pet.id);
      p.targets.set(pet.id, { bk: bkId, at: prev?.bk === bkId ? prev.at : now });
    }
    p.targetsChanged = true;
    return { ok: true };
  }

  zoneOf(p: Player) {
    return zoneAtZ(p.z);
  }
}
