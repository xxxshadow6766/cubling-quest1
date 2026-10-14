# 🐾 Cubling Quest

A colourful, cooperative **3D pet-collecting browser game**. Hatch cute cube pets ("Cublings"), send them to smash coins, crates, safes and treasure chests, unlock 99 themed areas, rebirth for permanent bonuses, and trade with friends, all in real-time multiplayer rooms. **No accounts are needed.**

- **Players:** open the site → pick a nickname → **Play Solo**, **Create Friends Room**, **Join** with a code, or open an **invite link**.
- **Saves:** an anonymous guest identity is created automatically and kept in a secure HttpOnly cookie. Progress lives on the server in SQLite.
- **Stack:** TypeScript, Three.js, React + Vite (client), Node.js + Express + Socket.IO (server), SQLite via Node's built-in `node:sqlite`. **All 3D models were built with Blender** from a reproducible Python script.

> ⚠️ **Multiplayer needs the Node server to be running and reachable.** Opening `index.html` as a file does *not* give you internet multiplayer. *Hosting* the game (one server, below) is a one-time job for whoever runs it; *players* never need any account.

---

## 1. Run it locally (2 minutes)

Requirements: **Node.js 22.13+** (Node 24 recommended). No database server or native build tools are needed.

```bash
npm install
npm run dev
```

Open **http://localhost:5173**. `npm run dev` starts two things:
- the game server (API + WebSockets) on port **3000**, auto-restarting on changes;
- the Vite dev server on port **5173** with hot reload, proxying `/api` and `/socket.io` to port 3000.

**Production mode locally**

```bash
npm run build      # typecheck + client bundle (dist/client) + server bundle (dist/server)
npm start          # ONE process on http://localhost:3000 serving the game, API and WebSockets
```

**Play with someone on your Wi-Fi/LAN:** run `npm start`, find your computer's LAN IP (e.g. `192.168.1.20`), and have friends open `http://192.168.1.20:3000`. Allow Node through your firewall if asked.

### Tests

```bash
npm test
```

This runs an end-to-end suite (`tests/multiplayer.test.ts`). It starts the **real server** with a temporary database and connects several **independent guest sessions**, each with its own cookie, over real WebSockets. See [Verification](#8-verification-what-was-actually-tested).

---

## 2. How to play

| | Desktop | Mobile / tablet |
|---|---|---|
| Move | WASD / arrow keys | Virtual joystick (bottom-left) |
| Camera | Drag mouse, wheel to zoom | Drag the screen, pinch to zoom |
| Send pets | Click a coin pile / crate / chest | Tap it |
| Interact (eggs, gates, stations) | **E** | ✋ button |
| Jump | Space | ⤒ button |
| Shortcuts | F auto-farm · P pets · Q quests · T teleport · Enter chat · Esc close | Menu buttons |

**Core loop:** smash breakables → earn 🪙 coins, 💎 gems and potions → hatch eggs → **Equip Best** → buy upgrades → unlock the next area at its gate → complete quests to rank up → **Rebirth** for permanent multipliers → trade with friends for rare pets.

The **Town hub** has: ⬆️ Upgrade Station, ✨ Golden Machine, 🌈 Rainbow Machine, 📜 Enchant Altar, 🎁 Daily Gift, 📖 Pet Index, 🔄 Rebirth Shrine, 🤝 Trading Plaza, 📋 Quest Board and 🌀 Teleporter.

A short interactive tutorial guides new players. A new player hatches their first egg within about 30 seconds and can reach Area 2 within a few minutes.

---

## 3. Features

**Multiplayer (server-authoritative)**
- Rooms of up to **12 players** (solo rooms are private, capacity 1). Join by 6-character code or invite link (`/?room=CODE`).
- Players see each other's characters, names, ranks, equipped pets, movement (interpolated), and pet targets.
- **Shared breakables**: one health pool per object for everyone in the room. Rewards are split **in proportion to damage dealt**, plus a **team bonus** (+10% per extra online player, up to +50%). Item drops are rolled per player and weighted by contribution.
- Cooperative events: **Boss Chests** in every 5th area (and area 99), **Comet** crashes, and room-wide **Coin Frenzy** (×2 coins).
- Player list, live connection status, chat, **automatic reconnection** (90-second grace period in the room), and owner **Remove player** (removed players can't rejoin that room).
- Opening the game in a second tab with the same save disconnects the first tab, so one save can't play twice at once.

**Content (all data-driven, in `config/*.json`)**
- **99 areas** generated from **20 visual themes**: meadow, beach, desert, candy, snow, volcano, jungle, coral reef (underwater), sky/clouds, haunted, mushroom forest, crystal caverns, autumn, sakura, swamp, toy town, clockwork, neon city, aurora, space. Each has its own colours, scenery, ambient particles, breakable mix, egg and music key.
- **105 original pet species**: 20 egg families × Common/Rare/Epic/Legendary/Mythic, plus 5 **Secret** pets.
- **20 egg families × 5 versions** (Basic → Super → Mega → Ultra → Omega). Higher versions have better odds and stronger pets.
- Variants: **Normal, Golden, Rainbow, Shiny**. Very rare **HUGE** pets: 2.6× size, ×12 power, plus a room-wide aura (+10% coins and damage for everyone, stacks ×3).
- Exact odds shown before hatching. These are the same numbers the server rolls with, using crypto-secure randomness.

**Progression**
- Inventory: cards (appearance, name, rarity, power, variant, ★ tier), equip/unequip, **Equip Best**, sort/filter/search, **lock**, multi-select **delete with confirmation**, **Pet Index**.
- Upgradable pet slots and inventory capacity, single / ×3 / ×8 hatching, unlockable **Auto Hatch**, optional **auto-delete rules** (with an explicit confirmation explaining what will happen).
- Golden and Rainbow machines (5 identical pets + gem fee → 1 upgraded pet; costs and results shown up front).
- Coin upgrades (damage, coins, walk speed) and gem upgrades (luck, hatch speed, slots, storage, gem finder), each with clear effect text.
- **Rebirth** with 3 milestones plus repeatable rebirths. The panel lists exactly what resets and what's kept before you confirm.
- Ranks (25), repeatable quests (including co-op quests in friends rooms), achievements, daily gifts with streaks, boost potions, and **enchant books** (equipped in slots).

**Trading**: request → accept → both sides add pets/gems → any change resets both confirmations → both confirm → 5-second server countdown → atomic swap in one SQLite transaction. Locked pets can't be offered. Equipped pets are clearly marked and unequipped on completion. Trades cancel safely if anyone leaves, disconnects or the offer becomes invalid.

**Visuals & audio**: Blender-built rounded cube pets with faces, ears, tails, wings and accessories (each pet merged into one draw call), animated coin/gem pickups, damage numbers, capped particle pools, health bars, hatch animation, procedural music and sound effects. Settings include music/SFX volume, reduced effects, skip hatch animations, name tags, camera sensitivity and graphics quality (auto mode lowers quality on slow devices).

---

## 4. Project layout

```
config/               ← EDITABLE game data: pets, eggs, themes (→ 99 zones), balance, upgrades,
                        rebirths, ranks, quests, achievements, items, enchants, daily, events, town
shared/               ← types + formulas + world geometry used by BOTH client and server
server/               ← Node server: HTTP API, Socket.IO, rooms, actions, trading, SQLite
client/               ← Vite + React UI and Three.js game (client/src/game/*)
client/public/models/assets.glb   ← all 3D models (generated by Blender)
tools/blender/build_models.py     ← Blender script that builds assets.glb from code
tests/                ← end-to-end multiplayer tests
```

### Rebuilding the models with Blender

The repo already contains the generated `client/public/models/assets.glb`. To regenerate or tweak it (Blender 4.2+, tested with 5.2):

```bash
npm run models                 # finds Blender automatically, or set BLENDER_PATH=/path/to/blender
PREVIEW=1 npm run models       # also renders tools/blender/preview.png (a contact sheet)
```

Materials named `tint_*` are recoloured at runtime per species, theme and player, so 105 pets and 20 themes come from one small GLB (~1 MB).

### Editing content / balance

Edit any file in `config/` and restart the server. Examples:
- `config/pets.json`: add a species (colours + part list), and it appears in eggs and the Index.
- `config/themes.json`: scenery, colours and breakable mix per theme; zone names.
- `config/balance.json`: growth curves, costs, odds per egg tier, huge/shiny chances, team bonus, room size, trade countdown.

---

## 5. Deploying for friends on different networks

The game is **one Node process** that serves the web client, the HTTP API and the WebSocket server **on the same origin**. Deploy that process to any host that supports **long-running Node servers with WebSockets** and a **persistent disk**.

| Need | Why |
|---|---|
| Node 22.13+ | Built-in `node:sqlite` |
| WebSocket support | Real-time multiplayer (Socket.IO falls back to HTTP long-polling if needed) |
| A persistent disk/volume | The SQLite save database (`DATA_DIR`) |
| HTTPS | Secure cookies + `wss://`; browsers need it for clipboard and other features |
| One instance | Rooms live in the server's memory; don't run multiple replicas without sticky sessions plus a shared room layer |

**Not suitable on their own:** static-only hosts (GitHub Pages, plain Netlify/Vercel static) and serverless functions. They can't keep WebSocket rooms alive or a SQLite file.

### Option A: a VPS (DigitalOcean, Hetzner, Linode, etc.)

```bash
git clone <your repo> cubling && cd cubling
npm ci
npm run build
NODE_ENV=production PORT=3000 DATA_DIR=/var/lib/cubling TRUST_PROXY=1 COOKIE_SECURE=1 npm start
```

Keep it running with **systemd** or **pm2** (`pm2 start dist/server/index.js --name cubling`). Put **Caddy** in front for automatic HTTPS (WebSockets work out of the box):

```
# /etc/caddy/Caddyfile
play.example.com {
    reverse_proxy localhost:3000
}
```

Or with nginx (WebSocket upgrade headers are required):

```nginx
server {
  server_name play.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
  # + certbot-managed TLS: listen 443 ssl; ssl_certificate ...;
}
```

### Option B1: Render (blueprint included)

1. Push this folder to a GitHub or GitLab repository (Render deploys from a repo).
2. In Render: **New → Blueprint**, select the repo. Render reads [`render.yaml`](render.yaml) and creates:
   - a Node **web service** (build `npm ci --include=dev && npm run build`, start `npm start`, health check `/healthz`);
   - a **1 GB persistent disk** mounted at `/var/data`, where the SQLite save database lives;
   - env vars `NODE_VERSION=24`, `NODE_ENV=production`, `DATA_DIR=/var/data`, `TRUST_PROXY=1`, `COOKIE_SECURE=1`.
3. Open the `https://<name>.onrender.com` URL, create a friends room and share the invite link. Render provides HTTPS/WSS automatically.

Notes:
- **Persistent disks require a paid instance type.** On the free plan you must delete the `disk:` block; the game still works, but every deploy/restart **wipes all saves**, and free services sleep when idle (the first visit after a nap takes a while to wake, and active rooms are lost).
- With a disk attached Render runs exactly one instance, which is what this game needs (rooms live in memory).
- Doing it by hand instead of the blueprint: create a *Web Service* with the same build/start commands and env vars, then add a Disk under the service's *Disks* tab with mount path `/var/data`.

### Option B2: other container/app platforms (Railway, Fly.io, Koyeb, etc.)

- **Build command:** `npm ci && npm run build`  **Start command:** `npm start`
- Attach a **persistent volume/disk** and set `DATA_DIR` to its mount path (e.g. `/data`). Without a volume, saves are wiped on every redeploy.
- Set env vars: `NODE_ENV=production`, `TRUST_PROXY=1`, `COOKIE_SECURE=1`. The platform's `PORT` is picked up automatically.
- Run exactly **one** instance. On Fly.io, for example, use one machine with a mounted volume.
- Platforms terminate HTTPS for you, so the game is automatically served over `https://` and `wss://`.

### Environment variables

See `.env.example`. The server also reads a local `.env` file if present.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | 3000 / 0.0.0.0 | Listen address |
| `DATA_DIR` / `DB_FILE` | `./data` | SQLite location: **must be persistent** |
| `TRUST_PROXY` | unset | Set to `1` behind a proxy/platform so HTTPS is detected |
| `COOKIE_SECURE` | auto | `1` = always Secure cookies (recommended in production) |
| `ALLOWED_ORIGINS` | unset | Only if the client is served from a different origin (not recommended) |
| `ENABLE_DEV_CHEATS` | unset | Dev/testing only; ignored in production builds |

### Inviting friends

1. Open your deployed URL (e.g. `https://play.example.com`), pick a nickname, and press **Create Friends Room**.
2. Click **📋 Copy Invite Link** (top right), or read out the 6-character room code.
3. Friends open the link on any device or network, pick a nickname, and press **Join**. That's it: no accounts, no downloads, no port forwarding for players.

Rooms are remembered for 72 hours of inactivity, so the same code works even after a server restart.

### Persistence & backups

- Everything durable is in `DATA_DIR/cubling.db` (WAL mode). Hatches, purchases, unlocks, trades and rebirths are written **immediately**. Breakable rewards are flushed every 15 s and on disconnect/shutdown (`SIGTERM`/`SIGINT` save everything).
- Back up with `sqlite3 cubling.db ".backup backup.db"` (safe while running), or snapshot the volume.

---

## 6. Guest saves: what players should know

- No registration, email, password or social login. A random 256-bit secret is created on first visit and stored **only** in an `HttpOnly`, `SameSite=Lax` (and `Secure` over HTTPS) cookie. The database stores just its SHA-256 hash.
- The **nickname is only a display name**, not proof of identity (two players may share a name).
- Returning on the **same browser** restores progress automatically.
- **Clearing cookies/site data, private browsing, or switching browser or device loses access to that guest save.** There is no cross-device recovery. The in-game Settings panel says so too.

---

## 7. Security & anti-cheat summary

- The server owns all currencies, pets, damage, rewards, egg rolls, purchases, unlocks, rebirths and trades. Clients only send *requests* (e.g. "hatch zone 3 ×1").
- Every request is validated: types and ranges, ownership, unlocked areas, **proximity** (egg stands, stations, gates, target range), cooldowns, costs.
- Movement is speed-checked and clamped to unlocked areas, with corrections sent back to the client.
- Per-socket rate limits (actions and movement), a 64 KB message cap, and malformed messages are rejected without crashing.
- Every action carries a request ID; **repeated or resent requests return the original result** instead of running twice.
- Trades are versioned, use a countdown, and execute atomically with rollback. Trade outcomes are also logged (`trade_log` table).
- Origin check on WebSocket upgrade (blocks cross-site socket hijacking), a strict CSP in production, and no secrets in browser code.

---

## 8. Verification (what was actually tested)

Run on Windows 11, Node 24.16, Blender 5.2.2:

**Automated (`npm test`): 18/18 passed**, against the real server with independent guest sessions:
- Guest session cookie is `HttpOnly` / `SameSite=Lax`; bad nicknames and forged cookies are rejected.
- Two independent sessions join the same friends room and see each other's player and pets.
- Movement is broadcast to the other player; a teleport hack is rejected with a correction.
- Both players attack the same breakable: shared health updates reach both, destruction syncs, and both receive rewards whose shares sum to 1 and are proportional to damage.
- Hatching charges exactly once, enforces the cooldown, requires standing at the egg, and a **resent request with the same ID doesn't hatch twice**.
- Equip / Equip Best / lock protects against delete; upgrades and unlocks require the station.
- Area unlock is idempotent (repeat → same result, charged once) and can't skip areas.
- Golden Machine converts 5 matching pets into 1.
- Trade: stale confirmation rejected, any change resets confirmations, spamming confirm doesn't double-execute, items and gems move exactly once, finished trades can't be replayed.
- Locked pets can't be offered; cancelling loses nothing; **disconnecting mid-countdown cancels safely** and the reconnecting player has identical pets and coins.
- Rebirth resets coins, areas and coin upgrades but keeps pets, gems and unlocks, and grants the milestone reward.
- Daily gift cooldown, potions activate boosts, enchant altar buy/equip with slot limits, quests (claim guard, reroll).
- Boss Chests spawn as shared room events in boss areas.
- Malformed/hostile messages are rejected and the server stays healthy.
- Solo rooms are private; only the owner can remove players; removed players can't rejoin.
- **Full server restart**: the same room code works and pets, coins and rebirths are unchanged.

**Manual in a real browser (built-in browser pane):**
- Home screen, nickname, Play Solo, Create Friends Room, the invite link pre-fills and joins the room, and Rejoin after refresh.
- Two independent sessions (`localhost` and `127.0.0.1` have separate cookies) in one friends room: each sees the other's avatar, name tag and pets. Both smashed the same coin pile and the second player received a contribution share. A full trade done through the UI showed the countdown, the swap and the achievement toast.
- Hatching animation, egg odds panel, inventory, all 14 panels open without errors, and a themed-area tour (Meadow, Candy, Volcano, Reef, Haunted, Space, Boss arena).
- Mobile viewport (375×812, touch emulation): joystick moves the player, tap-to-target sends pets, touch-drag rotates the camera, and the large Interact/Jump/Chat buttons are present.
- **Production build** (`npm run build && npm start`) serves the game on one port with the strict CSP and no console errors.

**Not tested here:** real phones on cellular networks, actual cloud deployment with HTTPS, and long-term balance across all 99 areas (the numbers are tuned so the early game is fast; later areas are intentionally slower and rely on rebirths).

---

## 9. Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Game server (port 3000, auto-restart) + Vite dev client (port 5173) |
| `npm run build` | Typecheck + production client + bundled server |
| `npm start` | Run the production server (serves everything on `PORT`) |
| `npm test` | End-to-end multiplayer test suite |
| `npm run typecheck` | TypeScript check of client, server, shared and tests |
| `npm run models` | Rebuild `assets.glb` with Blender |

All names, pets, artwork, models, music and sounds are original and procedurally generated. Cubling Quest is inspired by the pet-collecting genre and is not affiliated with any existing game.
