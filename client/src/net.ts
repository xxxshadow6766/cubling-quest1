// Networking: guest session (HTTP, HttpOnly cookie) + Socket.IO realtime connection with auto-reconnect.
// The client never sends currency or inventory values — only requested actions.
import { io, type Socket } from 'socket.io-client';
import type { PublicPlayer } from '../../shared/types';
import { banner, openPanel, pushChat, store, toast } from './store';

type Handler = (data: any) => void;
class Bus {
  private map = new Map<string, Set<Handler>>();
  on(ev: string, h: Handler) {
    let s = this.map.get(ev);
    if (!s) this.map.set(ev, (s = new Set()));
    s.add(h);
    return () => s!.delete(h);
  }
  emit(ev: string, data?: any) {
    this.map.get(ev)?.forEach((h) => {
      try {
        h(data);
      } catch (e) {
        console.error(`[bus ${ev}]`, e);
      }
    });
  }
}
export const bus = new Bus();

let socket: Socket | null = null;
let wantRoom: string | null = null;
let stopped = false;
export let lastInit: any = null;

const ridBase = Math.random().toString(36).slice(2, 8);
let ridSeq = 0;
const makeRid = () => `${ridBase}-${Date.now().toString(36)}-${(++ridSeq).toString(36)}`;

export async function fetchSession(): Promise<{ ok: boolean; id?: string; nickname?: string; zone?: number; rebirths?: number }> {
  try {
    const r = await fetch('/api/session', { credentials: 'same-origin' });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

export async function saveNickname(nickname: string): Promise<{ ok: boolean; error?: string; id?: string }> {
  try {
    const r = await fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname }),
    });
    return await r.json();
  } catch {
    return { ok: false, error: 'Cannot reach the game server. Is it running?' };
  }
}

export async function roomInfo(code: string) {
  try {
    const r = await fetch(`/api/room/${encodeURIComponent(code)}`);
    return await r.json();
  } catch {
    return { ok: false };
  }
}

function toHome(msg: string) {
  wantRoom = null;
  lastInit = null;
  try {
    sessionStorage.removeItem('cq_room');
  } catch {
    /* ignore */
  }
  store.set({ screen: 'home', homeError: msg, room: null, save: null, players: {}, trade: null, panel: null, hatch: null, autoHatch: null, autoFarm: false });
}

function connect(): Promise<void> {
  stopped = false;
  if (socket?.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!socket) {
      socket = io({ withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 4000, timeout: 8000 });
      wire(socket);
    } else socket.connect();
    store.set({ conn: 'connecting' });
    const s = socket;
    const ok = () => {
      s.off('connect_error', bad);
      resolve();
    };
    const bad = (e: Error) => {
      if (e.message === 'no_session') {
        s.off('hello', ok);
        reject(new Error('no_session'));
      }
    };
    s.once('hello', ok);
    s.on('connect_error', bad);
    setTimeout(() => {
      s.off('connect_error', bad);
      if (!s.connected) reject(new Error('Could not connect to the game server.'));
    }, 12000);
  });
}

function wire(s: Socket) {
  let everConnected = false;
  s.on('connect', () => {
    store.set({ conn: 'connected' });
    if (everConnected && wantRoom) {
      s.timeout(8000).emitWithAck('room:join', { code: wantRoom }).then((r: any) => {
        if (!r.ok) {
          toHome(r.error || 'Could not rejoin the room.');
        } else toast('Reconnected!', 'success');
      }).catch(() => {});
    }
    everConnected = true;
  });
  s.on('disconnect', (reason) => {
    if (stopped || reason === 'io client disconnect') {
      store.set({ conn: 'offline' });
      return;
    }
    store.set({ conn: 'reconnecting' });
    if (reason === 'io server disconnect' && !stopped) s.connect();
  });
  s.io.on('reconnect_attempt', () => store.set({ conn: 'reconnecting' }));
  s.on('connect_error', (e) => {
    if (e.message === 'no_session') {
      stopped = true;
      s.disconnect();
      toHome('Your guest session was not found (browser data may have been cleared). Pick a nickname to start a new save.');
    } else store.set({ conn: 'reconnecting' });
  });

  s.on('hello', (d) => store.set({ me: { id: d.id, nickname: d.nickname, color: d.color }, devCheats: !!d.devCheats }));
  s.on('init', (d) => {
    lastInit = d;
    const players: Record<string, PublicPlayer> = {};
    for (const p of d.players) players[p.id] = p;
    store.set({
      save: d.save,
      room: d.room,
      players,
      events: d.events,
      serverOffset: d.serverTime - Date.now(),
      devCheats: !!d.devCheats,
      me: { id: d.you.id, nickname: d.you.nickname, color: d.you.color },
      trade: null,
      screen: 'game',
      tutorialStep: d.save.tutorial ?? 0,
    });
    bus.emit('init', d);
  });
  s.on('me', (d) => store.set((st) => ({ save: st.save ? { ...st.save, ...d, pets: st.save.pets } : st.save })));
  s.on('pets', (d) => store.set((st) => ({ save: st.save ? { ...st.save, pets: d.pets, equipped: d.equipped } : st.save })));
  s.on('cur', (d) => store.set((st) => ({ save: st.save ? { ...st.save, coins: d.coins, gems: d.gems } : st.save })));
  s.on('pj', (p: PublicPlayer) => {
    const prev = store.get().players[p.id];
    store.set((st) => ({ players: { ...st.players, [p.id]: p } }));
    if (!prev && p.id !== store.get().me?.id) pushChat({ name: '', color: '#888', text: `👋 ${p.name} joined the room`, sys: true });
    else if (prev && prev.connected !== p.connected && p.id !== store.get().me?.id) {
      pushChat({ name: '', color: '#888', text: p.connected ? `🟢 ${p.name} reconnected` : `🟠 ${p.name} lost connection…`, sys: true });
    }
    bus.emit('pj', p);
  });
  s.on('pl', (d) => {
    const p = store.get().players[d.id];
    store.set((st) => {
      const players = { ...st.players };
      delete players[d.id];
      return { players };
    });
    if (p) pushChat({ name: '', color: '#888', text: `🚪 ${p.name} left (${d.reason})`, sys: true });
    bus.emit('pl', d);
  });
  s.on('room', (info) => store.set({ room: info }));
  s.on('ev', (ev) => store.set({ events: ev }));
  s.on('evmsg', (d) => {
    banner(d.text, d.kind || 'info');
    pushChat({ name: '', color: '#888', text: d.text, sys: true });
    bus.emit('evmsg', d);
  });
  s.on('toast', (d) => toast(d.text, d.kind));
  s.on('chat', (d) => pushChat({ name: d.name, color: d.color, text: d.text }));
  s.on('tradeReq', (d) => store.set((st) => ({ tradeReqs: [...st.tradeReqs.filter((r) => r.from !== d.from), d] })));
  s.on('trade', (v) => store.set({ trade: v, panel: 'trade', tradeReqs: [] }));
  s.on('tradeEnd', (d) => {
    store.set((st) => ({ trade: null, panel: st.panel === 'trade' ? null : st.panel }));
    toast(d.completed ? '🤝 Trade complete!' : `Trade cancelled: ${d.reason}`, d.completed ? 'success' : 'info');
    bus.emit('tradeEnd', d);
  });
  s.on('kicked', () => {
    stopped = true;
    toHome('You were removed from that room by its owner.');
  });
  s.on('replaced', () => {
    stopped = true;
    s.disconnect();
    toHome('Cubling Quest was opened in another tab or window with the same save. This tab was disconnected.');
  });
  for (const ev of ['s', 'pt', 'bka', 'hp', 'bkr', 'bkrs', 'reward', 'tp', 'corr', 'rankup']) s.on(ev, (d) => bus.emit(ev, d));
}

export async function enterRoom(kind: 'solo' | 'create' | 'join', code?: string) {
  store.set({ screen: 'loading', loadingText: 'Connecting to the server…', homeError: '' });
  try {
    await connect();
  } catch (e: any) {
    toHome(e?.message === 'no_session' ? 'Your guest session expired. Choose a nickname to continue.' : e?.message || 'Connection failed.');
    return;
  }
  store.set({ loadingText: kind === 'join' ? 'Joining room…' : 'Creating room…' });
  let r: any;
  try {
    r = kind === 'join'
      ? await socket!.timeout(10000).emitWithAck('room:join', { code })
      : await socket!.timeout(10000).emitWithAck('room:create', { mode: kind === 'solo' ? 'solo' : 'friends' });
  } catch {
    r = { ok: false, error: 'The server did not respond. Please try again.' };
  }
  if (!r.ok) {
    toHome(r.error || 'Could not enter the room.');
    return;
  }
  wantRoom = r.code;
  try {
    sessionStorage.setItem('cq_room', r.code);
  } catch {
    /* ignore */
  }
}

export function leaveRoom() {
  socket?.emit('room:leave', {});
  toHome('');
}

export function emitMove(x: number, y: number, z: number, ry: number) {
  if (socket?.connected) socket.volatile.emit('mv', [x, y, z, ry]);
}

/** Request an action from the server. Shows server errors as toasts unless quiet. */
export async function act(type: string, payload: Record<string, unknown> = {}, quiet = false): Promise<any> {
  if (!socket?.connected) {
    if (!quiet) toast('Not connected — reconnecting…', 'error');
    return { ok: false, error: 'offline' };
  }
  try {
    const res = await socket.timeout(10000).emitWithAck('act', { type, rid: makeRid(), ...payload });
    if (!res.ok && res.error && !quiet) toast(res.error, 'error');
    return res;
  } catch {
    if (!quiet) toast('The server did not respond in time.', 'error');
    return { ok: false, error: 'timeout' };
  }
}

export function closeTradePanelIfIdle() {
  if (!store.get().trade) openPanel(null);
}
