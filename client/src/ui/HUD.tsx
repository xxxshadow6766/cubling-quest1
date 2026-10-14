import { useEffect, useRef, useState } from 'react';
import { BALANCE, BOOSTS_BY_ID, ZONES } from '../../../shared/config';
import { fmt, fmtTime, rankBonuses, rankDef } from '../../../shared/formulas';
import { sfx } from '../audio';
import { currentGame, toggleAutoFarm } from '../game/Game';
import { act, bus } from '../net';
import { openPanel, serverNow, store, toast, useStore, type PanelId } from '../store';
import { copyText, inviteLink } from './actions';
import { useAnimatedNumber, useNow } from './common';

export function HUD() {
  const isTouch = useStore((s) => s.isTouch);
  const conn = useStore((s) => s.conn);
  return (
    <div className="hud">
      <TopLeft />
      <TopCenter />
      <TopRight />
      <MenuLeft />
      <BottomCenter />
      <Toasts />
      <Banner />
      <Tutorial />
      <Chat />
      <TradeRequests />
      {isTouch && <Joystick />}
      {isTouch && <MobileActions />}
      {conn !== 'connected' && <div className="reconnecting">{conn === 'offline' ? '⚠️ Offline' : '🔄 Reconnecting… your progress is safe'}</div>}
    </div>
  );
}

function TopLeft() {
  const coins = useStore((s) => s.save?.coins ?? 0);
  const gems = useStore((s) => s.save?.gems ?? 0);
  const rank = useStore((s) => s.save?.rank ?? 1);
  const xp = useStore((s) => s.save?.rankXp ?? 0);
  const c = useAnimatedNumber(coins);
  const g = useAnimatedNumber(gems);
  const rd = rankDef(rank);
  return (
    <div className="top-left">
      <div className="pill coins" title="Coins"><span className="ico">🪙</span>{fmt(c)}</div>
      <div className="pill gems" title="Gems"><span className="ico">💎</span>{fmt(g)}</div>
      <div className="rank-chip" onClick={() => openPanel('quests')} title="Rank — complete quests to rank up">
        ⭐ {rank} {rd.name}
        <span className="bar"><i style={{ width: `${Math.min(100, (xp / rd.xp) * 100)}%` }} /></span>
      </div>
    </div>
  );
}

function TopCenter() {
  const zone = useStore((s) => s.zone);
  const ev = useStore((s) => s.events);
  useNow(1000);
  const now = serverNow();
  const z = ZONES[zone];
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [zone]);
  return (
    <div className="top-center">
      <div className="area-title" style={flash ? { transform: 'scale(1.12)', transition: 'transform 0.2s' } : { transition: 'transform 0.4s' }}>
        <small>{zone === 0 ? 'Hub' : `Area ${zone} · ${z.theme.name}`}</small>
        {zone === 0 ? '🐾 Cubling Town' : z.name}
      </div>
      {ev && ev.frenzyUntil > now && <div className="event-chip">🪙 COIN FRENZY ×2 · {fmtTime((ev.frenzyUntil - now) / 1000)}</div>}
      {ev?.comet && ev.comet.until > now && (
        <div className="event-chip comet">☄️ Comet in Area {ev.comet.zone} · {fmtTime((ev.comet.until - now) / 1000)}</div>
      )}
    </div>
  );
}

function TopRight() {
  const room = useStore((s) => s.room);
  const conn = useStore((s) => s.conn);
  const players = useStore((s) => s.players);
  const online = Object.values(players).filter((p) => p.connected).length;
  const copy = async () => {
    if (!room) return;
    const ok = await copyText(inviteLink(room.code));
    toast(ok ? '📋 Invite link copied! Send it to your friends.' : `Share this link: ${inviteLink(room.code)}`, ok ? 'success' : 'info');
  };
  return (
    <div className="top-right">
      <div className="room-chip" title={conn}>
        <span className={`conn-dot ${conn === 'connected' ? '' : conn === 'offline' ? 'bad' : 'warn'}`} />
        {room?.mode === 'friends' ? (
          <>
            <code>{room.code}</code>
            <button className="btn small blue" onClick={copy} aria-label="Copy Invite Link">📋 <span className="hide-mobile">Copy Invite Link</span><span className="show-mobile">Invite</span></button>
          </>
        ) : (
          <span>Solo</span>
        )}
      </div>
      <button className="icon-btn" title="Players" onClick={() => openPanel('players')}>👥<span className="count" style={{ background: 'var(--accent)' }}>{online}</span></button>
      <button className="icon-btn" title="Settings" onClick={() => openPanel('settings')}>⚙️</button>
    </div>
  );
}

function MenuLeft() {
  const save = useStore((s) => s.save);
  const questReady = !!save?.quests.some((q) => q.progress >= q.target);
  const items = save ? Object.values(save.items).reduce((a, b) => a + b, 0) : 0;
  const btn = (id: PanelId, icon: string, label: string, dot = false) => (
    <button className="menu-btn" onClick={() => { sfx('click'); openPanel(id); }} title={label}>
      {icon}<span>{label}</span>{dot && <i className="dot" />}
    </button>
  );
  return (
    <div className="menu-left">
      {btn('pets', '🐾', 'Pets')}
      {btn('quests', '📋', 'Quests', questReady)}
      {btn('items', '🧪', 'Items', items > 0)}
      {btn('teleport', '🌀', 'Teleport')}
      {btn('index', '📖', 'Index')}
      {btn('achievements', '🏆', 'Awards')}
    </div>
  );
}

function BottomCenter() {
  const interact = useStore((s) => s.interact);
  const autoFarm = useStore((s) => s.autoFarm);
  const autoHatch = useStore((s) => s.autoHatch);
  const isTouch = useStore((s) => s.isTouch);
  const rank = useStore((s) => s.save?.rank ?? 1);
  const boosts = useStore((s) => s.save?.boosts);
  useNow(1000);
  const now = Date.now();
  const farmUnlocked = rankBonuses(rank).autoFarm;
  const active = Object.entries(boosts ?? {}).filter(([, until]) => until > now);
  return (
    <div className="bottom-center">
      {active.length > 0 && (
        <div className="boosts">
          {active.map(([eff, until]) => {
            const def = Object.values(BOOSTS_BY_ID).find((b) => b.effect === eff);
            return <div key={eff} className="boost-chip">{def?.icon} ×{def?.mult} {fmtTime((until - now) / 1000)}</div>;
          })}
        </div>
      )}
      {interact && !isTouch && (
        <button className="interact-btn" onClick={() => currentGame?.interact()}>
          <kbd>E</kbd>{interact.label}
        </button>
      )}
      <div className="action-row">
        {autoHatch && <button className="btn small pink" onClick={() => store.set({ autoHatch: null })}>🔁 Auto Hatch ON · stop</button>}
        <button className={`btn small auto-btn ${autoFarm ? 'on' : 'grey'}`} onClick={() => {
          if (!farmUnlocked) {
            toast(`🔒 Auto Farm unlocks at Rank ${BALANCE.autoFarmUnlockRank}. Complete quests to rank up!`, 'info');
            return;
          }
          toggleAutoFarm();
        }}>
          {farmUnlocked ? '🤖' : '🔒'} Auto Farm {autoFarm ? 'ON' : 'OFF'}{!isTouch && ' (F)'}
        </button>
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

function Banner() {
  const b = useStore((s) => s.banner);
  if (!b) return null;
  return <div key={b.key} className={`banner ${b.kind}`}>{b.text}</div>;
}

const STEPS = [
  'Welcome to Cubling Quest! Move with WASD / arrow keys (or the joystick). Drag to turn the camera.',
  'Walk into Sunny Meadow and click (or tap) a coin pile — your pet will run over and smash it!',
  `Keep smashing! Collect 🪙 ${BALANCE.eggCostBase} coins for your first egg.`,
  'Walk up to the Meadow Egg stand and press E (or the 🥚 button) to hatch it!',
  'Open 🐾 Pets and press “Equip Best” to send your new friends into battle.',
  'Save up coins and unlock the next area at the gate. Have fun! 🎉',
];

function Tutorial() {
  const step = useStore((s) => s.tutorialStep);
  const save = useStore((s) => s.save);
  const advance = (n: number) => {
    if (store.get().tutorialStep >= n) return;
    store.set({ tutorialStep: n });
    act('tutorial', { step: n }, true);
    sfx('pop');
  };
  useEffect(() => {
    const offs = [bus.on('moved', () => store.get().tutorialStep === 0 && advance(1)), bus.on('targeted', () => store.get().tutorialStep <= 1 && advance(2))];
    return () => offs.forEach((o) => o());
  }, []);
  useEffect(() => {
    if (!save) return;
    const eggs = save.stats.eggs ?? 0;
    if (step === 2 && (save.coins >= BALANCE.eggCostBase || eggs > 0)) advance(3);
    if (step === 3 && eggs > 0) advance(4);
    if (step === 4 && save.equipped.length >= 2) advance(5);
    if (step === 5 && save.zone >= 2) advance(6);
  }, [save, step]);
  const isTouch = useStore((s) => s.isTouch);
  if (step >= STEPS.length || !save) return null;
  let text = STEPS[step];
  if (isTouch) {
    text = text
      .replace('Move with WASD / arrow keys (or the joystick). Drag to turn the camera.', 'Move with the joystick (bottom-left). Drag the screen to turn the camera.')
      .replace('click (or tap)', 'tap')
      .replace('press E (or the 🥚 button)', 'tap the ✋ button');
  }
  return (
    <div className="tutorial">
      <button className="skip" onClick={() => advance(6)}>Skip tutorial</button>
      <h4>Tutorial · {step + 1}/{STEPS.length}</h4>
      <p>{text}</p>
    </div>
  );
}

function Chat() {
  const chat = useStore((s) => s.chat);
  const open = useStore((s) => s.chatOpen);
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo(0, 1e6);
  }, [chat]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  const send = () => {
    const t = text.trim();
    if (t) act('chat', { text: t });
    setText('');
    store.set({ chatOpen: false });
    inputRef.current?.blur();
  };
  return (
    <div className={`chat${open ? ' open' : ''}`}>
      <div className="chat-log" ref={logRef}>
        {chat.slice(-8).map((m) => (
          <div key={m.id} className={`chat-line${m.sys ? ' sys' : ''}`}>
            {!m.sys && <b style={{ color: m.color }}>{m.name}: </b>}{m.text}
          </div>
        ))}
      </div>
      {open ? (
        <div className="chat-input">
          <input ref={inputRef} className="input" maxLength={140} value={text} placeholder="Say something nice…" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') store.set({ chatOpen: false }); e.stopPropagation(); }} />
          <button className="btn small" onClick={send}>Send</button>
        </div>
      ) : (
        <button className="btn small grey" style={{ width: 'fit-content' }} onClick={() => store.set({ chatOpen: true })}>💬 Chat (Enter)</button>
      )}
    </div>
  );
}

function TradeRequests() {
  const reqs = useStore((s) => s.tradeReqs);
  useNow(1000);
  const live = reqs.filter((r) => r.expires > serverNow());
  if (!live.length) return null;
  const r = live[live.length - 1];
  const respond = (accept: boolean) => {
    store.set((s) => ({ tradeReqs: s.tradeReqs.filter((x) => x.from !== r.from) }));
    act('tradeRespond', { from: r.from, accept });
  };
  return (
    <div className="trade-req">
      🤝 <b>{r.name}</b> wants to trade with you!
      <div className="row">
        <button className="btn small green" onClick={() => respond(true)}>Accept</button>
        <button className="btn small red" onClick={() => respond(false)}>Decline</button>
      </div>
    </div>
  );
}

function Joystick() {
  const ref = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const pid = useRef<number | null>(null);
  const update = (cx: number, cy: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const R = r.width / 2;
    let dx = cx - (r.left + R);
    let dy = cy - (r.top + R);
    const d = Math.hypot(dx, dy);
    const max = R * 0.62;
    if (d > max) {
      dx = (dx / d) * max;
      dy = (dy / d) * max;
    }
    setKnob({ x: dx, y: dy });
    if (currentGame) currentGame.input.joy.x = dx / max, currentGame.input.joy.y = -dy / max;
  };
  const end = () => {
    pid.current = null;
    setKnob({ x: 0, y: 0 });
    if (currentGame) currentGame.input.joy.x = currentGame.input.joy.y = 0;
  };
  return (
    <div ref={ref} className="joystick" aria-label="Movement joystick"
      onPointerDown={(e) => {
        pid.current = e.pointerId;
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* best-effort */
        }
        update(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => pid.current === e.pointerId && update(e.clientX, e.clientY)}
      onPointerUp={end} onPointerCancel={end}>
      <div className="joy-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

function MobileActions() {
  const interact = useStore((s) => s.interact);
  return (
    <div className="mobile-actions">
      {interact && (
        <button className="interact-btn" onClick={() => currentGame?.interact()}>{interact.kind === 'egg' ? '🥚' : interact.kind === 'gate' ? '🔓' : '✋'} {interact.label}</button>
      )}
      <div className="row">
        <button className="round-btn small" aria-label="Chat" onClick={() => store.set((s) => ({ chatOpen: !s.chatOpen }))}>💬</button>
        <button className="round-btn green" aria-label="Interact" disabled={!interact} onClick={() => currentGame?.interact()}>✋</button>
        <button className="round-btn" aria-label="Jump" onPointerDown={() => currentGame?.jump()}>⤒</button>
      </div>
    </div>
  );
}
