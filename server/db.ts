// Durable storage using Node's built-in SQLite (node:sqlite, Node >= 22.13). No native build step needed.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface PlayerRow {
  id: string;
  token_hash: string;
  nickname: string;
  save: string;
  rev: number;
  created_at: number;
  updated_at: number;
}

export interface RoomRow {
  code: string;
  mode: 'solo' | 'friends';
  owner_id: string;
  banned: string;
  created_at: number;
  last_active: number;
}

export class Store {
  readonly db: DatabaseSync;
  private q: Record<string, StatementSync>;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        save TEXT NOT NULL,
        rev INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        banned TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        last_active INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trade_log (
        id TEXT PRIMARY KEY,
        a TEXT NOT NULL,
        b TEXT NOT NULL,
        detail TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `);
    this.q = {
      byToken: this.db.prepare('SELECT * FROM players WHERE token_hash = ?'),
      byId: this.db.prepare('SELECT * FROM players WHERE id = ?'),
      insert: this.db.prepare('INSERT INTO players (id, token_hash, nickname, save, rev, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'),
      nick: this.db.prepare('UPDATE players SET nickname = ?, updated_at = ? WHERE id = ?'),
      save: this.db.prepare('UPDATE players SET save = ?, rev = rev + 1, updated_at = ? WHERE id = ?'),
      roomGet: this.db.prepare('SELECT * FROM rooms WHERE code = ?'),
      roomPut: this.db.prepare(`INSERT INTO rooms (code, mode, owner_id, banned, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET owner_id = excluded.owner_id, banned = excluded.banned, last_active = excluded.last_active`),
      roomPurge: this.db.prepare('DELETE FROM rooms WHERE last_active < ?'),
      tradeLog: this.db.prepare('INSERT INTO trade_log (id, a, b, detail, at) VALUES (?, ?, ?, ?, ?)'),
    };
  }

  /** Runs fn inside a single SQLite transaction (all-or-nothing). */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  playerByToken(hash: string): PlayerRow | undefined {
    return this.q.byToken.get(hash) as PlayerRow | undefined;
  }
  playerById(id: string): PlayerRow | undefined {
    return this.q.byId.get(id) as PlayerRow | undefined;
  }
  createPlayer(id: string, tokenHash: string, nickname: string, save: string) {
    const now = Date.now();
    this.q.insert.run(id, tokenHash, nickname, save, now, now);
  }
  setNickname(id: string, nickname: string) {
    this.q.nick.run(nickname, Date.now(), id);
  }
  /** Writes many saves atomically. */
  saveMany(list: { id: string; save: string }[]) {
    if (!list.length) return;
    const now = Date.now();
    this.tx(() => {
      for (const it of list) this.q.save.run(it.save, now, it.id);
    });
  }
  /** Used inside an outer tx (trades). */
  saveOne(id: string, save: string) {
    this.q.save.run(save, Date.now(), id);
  }
  logTrade(id: string, a: string, b: string, detail: unknown) {
    this.q.tradeLog.run(id, a, b, JSON.stringify(detail), Date.now());
  }
  getRoom(code: string): RoomRow | undefined {
    return this.q.roomGet.get(code) as RoomRow | undefined;
  }
  putRoom(r: { code: string; mode: string; ownerId: string; banned: string[]; createdAt: number }) {
    this.q.roomPut.run(r.code, r.mode, r.ownerId, JSON.stringify(r.banned), r.createdAt, Date.now());
  }
  purgeRooms(olderThan: number) {
    this.q.roomPurge.run(olderThan);
  }
  close() {
    this.db.close();
  }
}
