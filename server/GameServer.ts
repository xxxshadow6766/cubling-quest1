import type { Server, Socket } from 'socket.io';
import { BALANCE } from '../shared/config';
import { MAX_Z, X_LIMIT, minZFor, zoneSpawn } from '../shared/world';
import { handleAction, GameError } from './actions';
import { hashToken, tokenFromCookieHeader } from './auth';
import type { Store } from './db';
import { Player } from './Player';
import { fillQuests, refreshDerivedStats } from './progress';
import { roomCode } from './rng';
import { Room } from './Room';
import { loadSave } from './save';
import { TradeManager } from './trade';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ack = (fn: unknown, res: unknown) => {
  if (typeof fn === 'function') fn(res);
};

export class GameServer {
  readonly players = new Map<string, Player>();
  readonly rooms = new Map<string, Room>();
  readonly trades: TradeManager;
  private intervals: NodeJS.Timeout[] = [];

  constructor(readonly io: Server, readonly store: Store, readonly devCheats = false) {
    this.trades = new TradeManager(this);
  }

  attach() {
    this.io.use((socket, next) => {
      const token = tokenFromCookieHeader(socket.handshake.headers.cookie);
      const row = token ? this.store.playerByToken(hashToken(token)) : undefined;
      if (!row) return next(new Error('no_session'));
      socket.data.playerId = row.id;
      next();
    });
    this.io.on('connection', (socket) => this.onConnection(socket));
    this.intervals.push(setInterval(() => this.saveDirty(), BALANCE.saveIntervalSec * 1000));
    this.intervals.push(setInterval(() => this.cleanup(), 30_000));
  }

  // ---------------------------------------------------------------- players
  loadPlayer(id: string): Player | null {
    const cached = this.players.get(id);
    if (cached) return cached;
    const row = this.store.playerById(id);
    if (!row) return null;
    const p = new Player(row.id, row.nickname, loadSave(row.save));
    this.players.set(p.id, p);
    return p;
  }

  /** Called when the nickname changes through the HTTP API. */
  renamePlayer(id: string, nickname: string) {
    const p = this.players.get(id);
    if (!p) return;
    p.nickname = nickname;
    p.room?.broadcast('pj', p.publicView());
  }

  saveNow(p: Player) {
    p.save.lastPos = { x: +p.x.toFixed(1), z: +p.z.toFixed(1) };
    this.store.saveMany([{ id: p.id, save: JSON.stringify(p.save) }]);
    p.dirty = false;
  }

  saveDirty() {
    const list: { id: string; save: string }[] = [];
    for (const p of this.players.values()) {
      if (!p.dirty) continue;
      p.save.lastPos = { x: +p.x.toFixed(1), z: +p.z.toFixed(1) };
      list.push({ id: p.id, save: JSON.stringify(p.save) });
      p.dirty = false;
    }
    try {
      this.store.saveMany(list);
    } catch (e) {
      console.error('[save] failed', e);
      for (const it of list) {
        const p = this.players.get(it.id);
        if (p) p.dirty = true;
      }
    }
  }

  /** Push changed state to the owning client. */
  flush(p: Player, force: boolean) {
    if (!p.connected) return;
    if (p.curDirty) {
      p.curDirty = false;
      p.emit('cur', { coins: p.save.coins, gems: p.save.gems });
    }
    const now = Date.now();
    if ((p.metaDirty || p.petsDirty) && (force || now - p.lastPush > 400)) {
      p.lastPush = now;
      if (p.petsDirty) {
        p.petsDirty = false;
        p.emit('pets', { pets: p.save.pets, equipped: p.save.equipped });
      }
      if (p.metaDirty) {
        p.metaDirty = false;
        const { pets: _omit, ...meta } = p.save;
        p.emit('me', meta);
      }
    }
  }

  // ---------------------------------------------------------------- connections
  private onConnection(socket: Socket) {
    const p = this.loadPlayer(socket.data.playerId);
    if (!p) {
      socket.disconnect(true);
      return;
    }
    if (p.socket && p.socket.id !== socket.id) {
      const old = p.socket;
      p.socket = null;
      old.emit('replaced');
      old.disconnect(true);
    }
    p.socket = socket;
    p.disconnectedAt = 0;
    socket.emit('hello', { id: p.id, nickname: p.nickname, color: p.color, devCheats: this.devCheats, room: p.room?.code ?? null });

    const guard = (fn: (msg: any) => unknown) => (msg: unknown, cb: unknown) => {
      if (!p.actBucket.take()) return ack(cb, { ok: false, error: 'Too many requests — slow down.' });
      try {
        const r = fn(msg ?? {});
        ack(cb, { ok: true, ...(r as object) });
      } catch (e) {
        ack(cb, { ok: false, error: e instanceof GameError ? e.message : 'Server error.' });
        if (!(e instanceof GameError)) console.error('[socket]', e);
      }
    };

    socket.on('room:create', guard((m) => {
      const mode = m.mode === 'solo' ? 'solo' : 'friends';
      const room = this.createRoom(p, mode);
      return { code: room.code };
    }));
    socket.on('room:join', guard((m) => {
      const room = this.joinRoom(p, m.code);
      return { code: room.code };
    }));
    socket.on('room:leave', guard(() => {
      p.room?.removeMember(p, 'left');
      return {};
    }));
    socket.on('act', (msg: unknown, cb: unknown) => {
      if (!p.actBucket.take()) return ack(cb, { ok: false, error: 'Too many actions — slow down.' });
      ack(cb, handleAction(this, p, msg));
    });
    socket.on('mv', (msg: unknown) => {
      try {
        this.onMove(p, msg);
      } catch (e) {
        console.error('[mv]', e);
      }
    });
    socket.on('disconnect', () => this.onDisconnect(p, socket));
  }

  private onMove(p: Player, msg: unknown) {
    if (!p.room || !p.moveBucket.take()) return;
    if (!Array.isArray(msg) || msg.length < 4) return;
    const [x, y, z, ry] = msg.slice(0, 4).map(Number);
    if (![x, y, z, ry].every(Number.isFinite)) return;
    const now = Date.now();
    const dt = Math.min(2, Math.max(0.05, (now - p.lastMoveAt) / 1000));
    const maxDist = p.stats(now).speed * 1.6 * dt + 2.5;
    const nx = clamp(x, -X_LIMIT, X_LIMIT);
    const nz = clamp(z, minZFor(p.save.zone), MAX_Z);
    const ny = clamp(y, 0, 15);
    if (Math.hypot(nx - p.x, nz - p.z) > maxDist) {
      p.emit('corr', { x: p.x, y: p.y, z: p.z });
      p.lastMoveAt = now;
      return;
    }
    p.x = nx;
    p.y = ny;
    p.z = nz;
    p.ry = ry;
    p.lastMoveAt = now;
    if (Math.abs(nx - x) > 0.5 || Math.abs(nz - z) > 0.5) p.emit('corr', { x: nx, y: ny, z: nz });
  }

  private onDisconnect(p: Player, socket: Socket) {
    if (p.socket !== socket) return; // replaced by a newer connection
    p.socket = null;
    p.disconnectedAt = Date.now();
    p.targets.clear();
    p.autoFarm = false;
    if (p.trade) this.trades.cancel(p.trade, `${p.nickname} disconnected.`);
    if (p.room) {
      p.room.broadcast('pj', p.publicView());
      p.room.broadcast('pt', { id: p.id, t: {} });
    }
    try {
      this.saveNow(p);
    } catch (e) {
      console.error('[save on disconnect]', e);
      p.dirty = true;
    }
  }

  // ---------------------------------------------------------------- rooms
  createRoom(p: Player, mode: 'solo' | 'friends'): Room {
    let code = roomCode();
    while (this.rooms.has(code) || this.store.getRoom(code)) code = roomCode();
    const room = new Room(this, code, mode, p.id, new Set(), Date.now());
    this.rooms.set(code, room);
    room.persist();
    room.start();
    this.enterRoom(p, room);
    return room;
  }

  joinRoom(p: Player, codeRaw: unknown): Room {
    const code = String(codeRaw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (code.length < 4) throw new GameError('Enter a valid room code.');
    let room = this.rooms.get(code);
    if (!room) {
      const row = this.store.getRoom(code);
      if (!row) throw new GameError('Room not found. Check the code and try again.');
      let banned: string[] = [];
      try {
        banned = JSON.parse(row.banned);
      } catch {
        /* ignore */
      }
      room = new Room(this, row.code, row.mode, row.owner_id, new Set(banned), row.created_at);
      this.rooms.set(code, room);
      room.start();
    }
    if (room.banned.has(p.id)) throw new GameError('You were removed from this room by its owner.');
    if (room.mode === 'solo' && room.ownerId !== p.id) throw new GameError('That is a private solo room.');
    if (!room.members.has(p.id) && room.members.size >= room.capacity) {
      for (const m of [...room.members.values()]) if (!m.connected) room.removeMember(m, 'timed out');
      if (room.members.size >= room.capacity) throw new GameError('This room is full.');
    }
    this.enterRoom(p, room);
    return room;
  }

  private enterRoom(p: Player, room: Room) {
    if (p.room && p.room !== room) p.room.removeMember(p, 'left');
    if (p.trade) this.trades.cancel(p.trade, 'Room changed.');
    const rejoin = room.members.has(p.id);
    if (!rejoin) {
      const pos = p.save.lastPos;
      if (!pos || pos.z < minZFor(p.save.zone) || pos.z > MAX_Z || Math.abs(pos.x) > X_LIMIT) {
        const s = zoneSpawn(0);
        p.x = s.x;
        p.z = s.z;
      } else {
        p.x = pos.x;
        p.z = pos.z;
      }
      p.y = 0;
      room.addMember(p);
    } else {
      room.broadcast('pj', p.publicView());
    }
    p.socket?.join(room.channel);
    p.lastMoveAt = Date.now();
    p.disconnectedAt = 0;
    fillQuests(p);
    refreshDerivedStats(p);
    p.socket?.emit('init', {
      you: { id: p.id, nickname: p.nickname, color: p.color },
      save: p.save,
      room: room.info(),
      players: [...room.members.values()].map((m) => m.publicView()),
      breakables: room.snapshotBreakables(),
      targets: room.petTargets(),
      events: room.ev,
      serverTime: Date.now(),
      devCheats: this.devCheats,
    });
    p.metaDirty = p.petsDirty = false;
  }

  kick(room: Room, target: Player) {
    room.banned.add(target.id);
    target.emit('kicked', { room: room.code });
    room.removeMember(target, 'removed by the owner');
    room.persist();
  }

  private cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const online = room.connectedMembers().length;
      if (online) {
        if (now - room.lastPersist > 5 * 60_000) {
          room.lastPersist = now;
          room.persist();
        }
        continue;
      }
      if (room.emptySince && now - room.emptySince > (BALANCE.roomGraceSec + 30) * 1000) {
        for (const m of [...room.members.values()]) room.removeMember(m, 'timed out');
        room.stop();
        this.rooms.delete(code);
      }
    }
    for (const [id, p] of this.players) {
      if (!p.connected && !p.room && !p.trade && !p.dirty && now - p.disconnectedAt > 10 * 60_000) this.players.delete(id);
    }
    try {
      this.store.purgeRooms(now - BALANCE.roomIdleExpireHours * 3600_000);
    } catch (e) {
      console.error('[purge]', e);
    }
  }

  shutdown() {
    for (const t of this.intervals) clearInterval(t);
    for (const r of this.rooms.values()) r.stop();
    for (const t of [...this.trades.trades.values()]) this.trades.cancel(t, 'Server is restarting.');
    for (const p of this.players.values()) p.dirty = true;
    this.saveDirty();
  }
}
