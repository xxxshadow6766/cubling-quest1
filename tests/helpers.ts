// Test harness: launches the real server as a child process and drives it with independent
// Socket.IO clients, each with its OWN guest cookie (= separate browser sessions).
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import type { BreakableState, PetInstance, SaveData } from '../shared/types';

export class TestServer {
  proc: ChildProcess | null = null;
  readonly base: string;
  log = '';
  constructor(readonly port: number, readonly dbFile: string) {
    this.base = `http://127.0.0.1:${port}`;
  }
  static tempDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-test-'));
    return path.join(dir, 'test.db');
  }
  async start() {
    this.proc = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: { ...process.env, PORT: String(this.port), HOST: '127.0.0.1', DB_FILE: this.dbFile, ENABLE_DEV_CHEATS: '1', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout!.on('data', (d) => (this.log += d));
    this.proc.stderr!.on('data', (d) => (this.log += d));
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try {
        const r = await fetch(`${this.base}/healthz`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(150);
    }
    throw new Error(`server did not start:\n${this.log}`);
  }
  async stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    await new Promise<void>((res) => {
      p.once('exit', () => res());
      p.kill();
      setTimeout(res, 3000);
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function newGuest(base: string, nickname: string): Promise<string> {
  const r = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname }) });
  const j = (await r.json()) as { ok: boolean };
  if (!j.ok) throw new Error('session failed');
  const sc = r.headers.get('set-cookie');
  if (!sc) throw new Error('no cookie');
  return sc.split(';')[0];
}

let ridSeq = 0;

export class TestClient {
  socket: Socket;
  id = '';
  save!: SaveData;
  pets: PetInstance[] = [];
  breakables = new Map<string, BreakableState>();
  events: { ev: string; data: any; at: number }[] = [];
  roomCode = '';

  constructor(readonly base: string, readonly cookie: string, readonly name: string) {
    this.socket = io(base, { extraHeaders: { cookie }, transports: ['websocket'], forceNew: true, reconnection: false });
    this.socket.onAny((ev, data) => {
      this.events.push({ ev, data, at: Date.now() });
      if (ev === 'hello') this.id = data.id;
      if (ev === 'init') {
        this.save = data.save;
        this.pets = data.save.pets;
        this.roomCode = data.room.code;
        this.breakables = new Map(data.breakables.map((b: BreakableState) => [b.id, b]));
      }
      if (ev === 'bka') for (const b of data) this.breakables.set(b.id, b);
      if (ev === 'hp') for (const [id, hp] of data) { const b = this.breakables.get(id); if (b) b.hp = hp; }
      if (ev === 'bkr') this.breakables.delete(data.id);
      if (ev === 'bkrs') for (const id of data) this.breakables.delete(id);
      if (ev === 'cur' && this.save) { this.save.coins = data.coins; this.save.gems = data.gems; }
      if (ev === 'me') this.save = { ...this.save, ...data, pets: this.pets };
      if (ev === 'pets') { this.pets = data.pets; if (this.save) { this.save.pets = data.pets; this.save.equipped = data.equipped; } }
    });
  }

  async connected() {
    if (this.socket.connected && this.id) return;
    await this.waitFor('hello', () => true, 8000);
  }

  emitAck<T = any>(ev: string, data: unknown, timeout = 8000): Promise<T> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`ack timeout ${ev}`)), timeout);
      this.socket.emit(ev, data, (r: T) => {
        clearTimeout(t);
        res(r);
      });
    });
  }

  act(type: string, payload: Record<string, unknown> = {}, rid = `t${++ridSeq}-${Math.random().toString(36).slice(2)}`) {
    return this.emitAck<any>('act', { type, rid, ...payload });
  }

  async createRoom(mode: 'solo' | 'friends') {
    const before = this.events.length;
    const r = await this.emitAck<any>('room:create', { mode });
    if (!r.ok) throw new Error(r.error);
    await this.waitFor('init', () => true, 8000, before);
    return r.code as string;
  }

  async joinRoom(code: string) {
    const before = this.events.length;
    const r = await this.emitAck<any>('room:join', { code });
    if (r.ok) await this.waitFor('init', () => true, 8000, before);
    return r;
  }

  waitFor(ev: string, pred: (d: any) => boolean = () => true, timeout = 8000, fromIndex = 0): Promise<any> {
    return new Promise((res, rej) => {
      for (let i = fromIndex; i < this.events.length; i++) {
        const e = this.events[i];
        if (e.ev === ev && pred(e.data)) return res(e.data);
      }
      const t = setTimeout(() => {
        this.socket.offAny(h);
        rej(new Error(`[${this.name}] timeout waiting for ${ev}`));
      }, timeout);
      const h = (e: string, d: any) => {
        if (e === ev && pred(d)) {
          clearTimeout(t);
          this.socket.offAny(h);
          res(d);
        }
      };
      this.socket.onAny(h);
    });
  }

  mark() {
    return this.events.length;
  }

  move(x: number, z: number, y = 0, ry = 0) {
    this.socket.emit('mv', [x, y, z, ry]);
  }

  /** Teleport using the dev-only cheat (enabled only in tests / ENABLE_DEV_CHEATS). */
  async warp(x: number, z: number) {
    const r = await this.act('cheat', { x, z });
    if (!r.ok) throw new Error(r.error);
  }

  close() {
    this.socket.disconnect();
  }
}
