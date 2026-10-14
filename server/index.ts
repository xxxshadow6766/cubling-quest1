// Cubling Quest server: HTTP (guest session API + static client) and Socket.IO multiplayer on ONE port.
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { cleanNickname, hashToken, newId, newToken, sessionCookie, tokenFromCookieHeader } from './auth';
import { Store } from './db';
import { GameServer } from './GameServer';
import { newSave } from './save';

// Minimal .env support (KEY=VALUE lines). Real environment variables take precedence.
try {
  const envFile = path.resolve(process.env.ENV_FILE || '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  /* ignore malformed .env */
}

const here = path.dirname(fileURLToPath(import.meta.url));
const bundled = /[\\/]dist[\\/]server$/.test(here);
const isProd = process.env.NODE_ENV === 'production' || bundled;
const portArg = process.argv.indexOf('--port');
const PORT = Number((portArg > 0 && process.argv[portArg + 1]) || process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'cubling.db');
const TRUST_PROXY = process.env.TRUST_PROXY;
const COOKIE_SECURE = process.env.COOKIE_SECURE; // '1' force, '0' never, unset = auto (HTTPS detection)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DEV_CHEATS = !isProd && process.env.ENABLE_DEV_CHEATS === '1';

const store = new Store(DB_FILE);
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  if (isProd) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; media-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self'",
    );
  }
  next();
});

// ------------------------------------------------------------------ guest session API
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string, max: number): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++h.n > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60_000).unref();

const secureFor = (req: express.Request) => (COOKIE_SECURE === '1' ? true : COOKIE_SECURE === '0' ? false : req.secure);

app.use('/api', express.json({ limit: '2kb' }));

app.get('/api/session', (req, res) => {
  const token = tokenFromCookieHeader(req.headers.cookie);
  const row = token ? store.playerByToken(hashToken(token)) : undefined;
  if (!row) return res.json({ ok: false });
  let zone = 1;
  let rebirths = 0;
  try {
    const s = JSON.parse(row.save);
    zone = s.zone ?? 1;
    rebirths = s.rebirths ?? 0;
  } catch {
    /* ignore */
  }
  res.json({ ok: true, id: row.id, nickname: row.nickname, zone, rebirths, createdAt: row.created_at });
});

app.post('/api/session', (req, res) => {
  if (limited(req.ip || 'x', 30)) return res.status(429).json({ ok: false, error: 'Too many requests, try again in a minute.' });
  const nickname = cleanNickname(req.body?.nickname);
  if (!nickname) return res.status(400).json({ ok: false, error: 'Nickname must be 2–16 letters, numbers, spaces, dots, dashes or underscores.' });
  const token = tokenFromCookieHeader(req.headers.cookie);
  const row = token ? store.playerByToken(hashToken(token)) : undefined;
  if (row) {
    store.setNickname(row.id, nickname);
    game.renamePlayer(row.id, nickname);
    // refresh cookie lifetime
    res.setHeader('Set-Cookie', sessionCookie(token!, secureFor(req)));
    return res.json({ ok: true, id: row.id, nickname, created: false });
  }
  const newTok = newToken();
  const id = newId(12);
  store.createPlayer(id, hashToken(newTok), nickname, JSON.stringify(newSave()));
  res.setHeader('Set-Cookie', sessionCookie(newTok, secureFor(req)));
  res.json({ ok: true, id, nickname, created: true });
});

app.get('/api/room/:code', (req, res) => {
  if (limited(`room:${req.ip}`, 60)) return res.status(429).json({ ok: false });
  const code = String(req.params.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const live = game.rooms.get(code);
  if (live) return res.json({ ok: true, exists: true, mode: live.mode, players: live.connectedMembers().length, capacity: live.capacity });
  const row = store.getRoom(code);
  res.json({ ok: true, exists: !!row && row.mode === 'friends', mode: row?.mode, players: 0, capacity: 12 });
});

app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: game.rooms.size, players: [...game.players.values()].filter((p) => p.connected).length }));

// ------------------------------------------------------------------ static client (production build)
const clientDir = process.env.CLIENT_DIR ? path.resolve(process.env.CLIENT_DIR) : path.resolve(here, '../client');
const servesClient = fs.existsSync(path.join(clientDir, 'index.html')) && !fs.existsSync(path.join(clientDir, 'src'));
if (servesClient) {
  app.use(
    express.static(clientDir, {
      index: 'index.html',
      setHeaders(res, file) {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

// ------------------------------------------------------------------ realtime
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingInterval: 10_000,
  pingTimeout: 8_000,
  cors: ALLOWED_ORIGINS.length ? { origin: ALLOWED_ORIGINS, credentials: true } : undefined,
  allowRequest: (req, cb) => {
    // Block cross-site WebSocket hijacking: browsers always send Origin.
    const origin = req.headers.origin;
    if (!origin) return cb(null, true);
    try {
      const ok = ALLOWED_ORIGINS.includes(origin) || new URL(origin).host === req.headers.host;
      cb(null, ok);
    } catch {
      cb(null, false);
    }
  },
});
const game = new GameServer(io, store, DEV_CHEATS);
game.attach();

server.listen(PORT, HOST, () => {
  console.log(`🐾 Cubling Quest server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`   mode=${isProd ? 'production' : 'development'} db=${DB_FILE} static=${servesClient ? clientDir : '(none, use Vite dev server)'}${DEV_CHEATS ? ' DEV CHEATS ENABLED' : ''}`);
});

let shuttingDown = false;
function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${sig} received — saving all players…`);
  try {
    game.shutdown();
    io.close();
    store.close();
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  console.error('[uncaught]', e);
  try {
    game.saveDirty();
  } catch {
    /* ignore */
  }
});
