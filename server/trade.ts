// Secure player-to-player trading.
// - Every offer change bumps `version` and resets BOTH confirmations.
// - "Ready" must reference the current version (stale confirmations are rejected).
// - When both are ready a server-side countdown starts; any change cancels it.
// - Execution re-validates everything and swaps items in ONE synchronous step, persisted in ONE
//   SQLite transaction. On any failure the in-memory state is restored and nothing moves.
import { BALANCE } from '../shared/config';
import { indexBits } from '../shared/formulas';
import type { PetInstance, SaveData, TradeOffer, TradeView } from '../shared/types';
import { newId } from './auth';
import type { GameServer } from './GameServer';
import type { Player } from './Player';
import { bump, refreshDerivedStats } from './progress';

export interface Trade {
  id: string;
  a: Player;
  b: Player;
  offers: Map<string, TradeOffer>;
  ready: Map<string, boolean>;
  version: number;
  countdownEnd: number;
  timer: NodeJS.Timeout | null;
  state: 'open' | 'countdown' | 'done' | 'cancelled';
}

interface PendingRequest {
  from: string;
  to: string;
  at: number;
}

export class TradeError extends Error {}

export class TradeManager {
  private requests: PendingRequest[] = [];
  readonly trades = new Map<string, Trade>();

  constructor(private gs: GameServer) {}

  view(t: Trade): TradeView {
    const petInfo: Record<string, PetInstance> = {};
    for (const side of [t.a, t.b]) {
      for (const id of t.offers.get(side.id)!.pets) {
        const pet = side.pet(id);
        if (pet) petInfo[id] = { ...pet };
      }
    }
    return {
      id: t.id,
      a: t.a.id,
      b: t.b.id,
      aName: t.a.nickname,
      bName: t.b.nickname,
      offers: Object.fromEntries([...t.offers].map(([k, v]) => [k, { pets: [...v.pets], gems: v.gems }])),
      petInfo,
      ready: Object.fromEntries(t.ready),
      version: t.version,
      countdownEnd: t.countdownEnd,
      state: t.state,
    };
  }

  private push(t: Trade) {
    const v = this.view(t);
    t.a.emit('trade', v);
    t.b.emit('trade', v);
  }

  request(from: Player, toId: string) {
    const to = this.gs.players.get(toId);
    if (!to || to === from) throw new TradeError('Player not found.');
    if (!from.room || from.room !== to.room) throw new TradeError('You can only trade with players in your room.');
    if (!to.connected) throw new TradeError(`${to.nickname} is offline.`);
    if (from.trade) throw new TradeError('You are already trading.');
    if (to.trade) throw new TradeError(`${to.nickname} is busy in another trade.`);
    if (from.save.zone < BALANCE.tradeMinZone || to.save.zone < BALANCE.tradeMinZone) throw new TradeError(`Both players need area ${BALANCE.tradeMinZone} to trade.`);
    const now = Date.now();
    this.requests = this.requests.filter((r) => now - r.at < BALANCE.tradeRequestTimeoutSec * 1000 && !(r.from === from.id && r.to === to.id));
    this.requests.push({ from: from.id, to: to.id, at: now });
    to.emit('tradeReq', { from: from.id, name: from.nickname, expires: now + BALANCE.tradeRequestTimeoutSec * 1000 });
  }

  respond(to: Player, fromId: string, accept: boolean): Trade | null {
    const now = Date.now();
    const idx = this.requests.findIndex((r) => r.from === fromId && r.to === to.id && now - r.at < BALANCE.tradeRequestTimeoutSec * 1000);
    if (idx < 0) throw new TradeError('That trade request expired.');
    this.requests.splice(idx, 1);
    const from = this.gs.players.get(fromId);
    if (!from) throw new TradeError('Player not found.');
    if (!accept) {
      from.emit('toast', { text: `${to.nickname} declined your trade request.`, kind: 'info' });
      return null;
    }
    if (!from.connected || from.room !== to.room || !to.room) throw new TradeError(`${from.nickname} is no longer here.`);
    if (from.trade || to.trade) throw new TradeError('One of you is already trading.');
    const t: Trade = {
      id: newId(),
      a: from,
      b: to,
      offers: new Map([[from.id, { pets: [], gems: 0 }], [to.id, { pets: [], gems: 0 }]]),
      ready: new Map([[from.id, false], [to.id, false]]),
      version: 1,
      countdownEnd: 0,
      timer: null,
      state: 'open',
    };
    from.trade = to.trade = t;
    this.trades.set(t.id, t);
    this.push(t);
    return t;
  }

  private get(p: Player, tradeId: unknown): Trade {
    const t = p.trade;
    if (!t || t.id !== tradeId || (t.state !== 'open' && t.state !== 'countdown')) throw new TradeError('This trade is no longer active.');
    return t;
  }

  private resetConfirmations(t: Trade) {
    t.version++;
    for (const k of t.ready.keys()) t.ready.set(k, false);
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.countdownEnd = 0;
    t.state = 'open';
  }

  setOffer(p: Player, tradeId: unknown, pets: unknown, gems: unknown) {
    const t = this.get(p, tradeId);
    if (!Array.isArray(pets) || pets.length > BALANCE.maxTradePets || !pets.every((x) => typeof x === 'string')) throw new TradeError(`You can offer up to ${BALANCE.maxTradePets} pets.`);
    const ids = [...new Set(pets as string[])];
    const g = Number(gems);
    if (!Number.isInteger(g) || g < 0) throw new TradeError('Invalid gem amount.');
    if (g > p.save.gems) throw new TradeError("You don't have that many gems.");
    for (const id of ids) {
      const pet = p.pet(id);
      if (!pet) throw new TradeError('You no longer own one of those pets.');
      if (pet.lk) throw new TradeError('Locked pets cannot be traded. Unlock it first.');
    }
    t.offers.set(p.id, { pets: ids, gems: g });
    this.resetConfirmations(t);
    this.push(t);
  }

  setReady(p: Player, tradeId: unknown, version: unknown, ready: unknown) {
    const t = this.get(p, tradeId);
    if (version !== t.version) throw new TradeError('The offer changed — please review it again.');
    t.ready.set(p.id, !!ready);
    if ([...t.ready.values()].every(Boolean)) {
      if (t.state !== 'countdown') {
        t.state = 'countdown';
        t.countdownEnd = Date.now() + BALANCE.tradeCountdownSec * 1000;
        const v = t.version;
        t.timer = setTimeout(() => this.execute(t, v), BALANCE.tradeCountdownSec * 1000);
      }
    } else if (t.state === 'countdown') {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      t.state = 'open';
      t.countdownEnd = 0;
    }
    this.push(t);
  }

  cancel(t: Trade, reason: string) {
    if (t.state === 'done' || t.state === 'cancelled') return;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    t.state = 'cancelled';
    if (t.a.trade === t) t.a.trade = null;
    if (t.b.trade === t) t.b.trade = null;
    this.trades.delete(t.id);
    const v = this.view(t);
    t.a.emit('tradeEnd', { completed: false, reason, view: v });
    t.b.emit('tradeEnd', { completed: false, reason, view: v });
  }

  /** Validates both sides against CURRENT state. Throws TradeError if anything is off. */
  private validate(t: Trade) {
    for (const [self, other] of [[t.a, t.b], [t.b, t.a]] as const) {
      if (!self.connected) throw new TradeError(`${self.nickname} disconnected.`);
      if (self.room !== other.room || !self.room) throw new TradeError('Both players must be in the same room.');
      const o = t.offers.get(self.id)!;
      if (o.gems > self.save.gems) throw new TradeError(`${self.nickname} no longer has enough gems.`);
      for (const id of o.pets) {
        const pet = self.pet(id);
        if (!pet) throw new TradeError(`${self.nickname} no longer owns an offered pet.`);
        if (pet.lk) throw new TradeError(`${self.nickname} locked an offered pet.`);
      }
      const incoming = t.offers.get(other.id)!.pets.length;
      const after = self.save.pets.length - o.pets.length + incoming;
      if (incoming > 0 && after > self.stats().invCap) throw new TradeError(`${self.nickname}'s pet storage is full.`);
    }
  }

  private execute(t: Trade, version: number) {
    t.timer = null;
    if (t.state !== 'countdown' || t.version !== version) return;
    try {
      this.validate(t);
    } catch (e) {
      this.cancel(t, e instanceof TradeError ? e.message : 'Trade failed.');
      return;
    }
    const snapA: SaveData = structuredClone(t.a.save);
    const snapB: SaveData = structuredClone(t.b.save);
    const oa = t.offers.get(t.a.id)!;
    const ob = t.offers.get(t.b.id)!;
    try {
      const moveA = take(t.a.save, oa.pets);
      const moveB = take(t.b.save, ob.pets);
      t.a.save.gems -= oa.gems;
      t.b.save.gems -= ob.gems;
      give(t.a.save, moveB);
      give(t.b.save, moveA);
      t.a.save.gems += ob.gems;
      t.b.save.gems += oa.gems;
      if (t.a.save.gems < 0 || t.b.save.gems < 0) throw new Error('negative gems');
      this.gs.store.tx(() => {
        this.gs.store.saveOne(t.a.id, JSON.stringify(t.a.save));
        this.gs.store.saveOne(t.b.id, JSON.stringify(t.b.save));
        this.gs.store.logTrade(t.id, t.a.id, t.b.id, { a: oa, b: ob });
      });
    } catch (e) {
      console.error('[trade] execution failed, rolled back', e);
      t.a.save = snapA;
      t.b.save = snapB;
      this.cancel(t, 'Trade failed on the server — nothing was exchanged.');
      return;
    }
    t.state = 'done';
    t.a.trade = t.b.trade = null;
    this.trades.delete(t.id);
    for (const p of [t.a, t.b]) {
      bump(p, 'trades');
      refreshDerivedStats(p);
      p.markAll(); // items were persisted in the transaction; this re-saves the updated stats too
      p.room?.broadcast('pj', p.publicView());
      this.gs.flush(p, true);
    }
    const v = this.view(t);
    v.state = 'done';
    t.a.emit('tradeEnd', { completed: true, reason: 'Trade complete!', view: v });
    t.b.emit('tradeEnd', { completed: true, reason: 'Trade complete!', view: v });
  }
}

function take(save: SaveData, ids: string[]): PetInstance[] {
  const set = new Set(ids);
  const out = save.pets.filter((p) => set.has(p.id));
  if (out.length !== ids.length) throw new Error('pet missing');
  save.pets = save.pets.filter((p) => !set.has(p.id));
  save.equipped = save.equipped.filter((id) => !set.has(id));
  return out;
}

function give(save: SaveData, pets: PetInstance[]) {
  for (const p of pets) {
    save.pets.push({ ...p, lk: undefined });
    save.index[p.s] = (save.index[p.s] ?? 0) | indexBits(p);
  }
}
