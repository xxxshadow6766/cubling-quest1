import { useEffect, useState } from 'react';
import { BALANCE } from '../../../../shared/config';
import { fmt, petPower } from '../../../../shared/formulas';
import type { PetInstance } from '../../../../shared/types';
import { applyVolumes, sfx } from '../../audio';
import { act, leaveRoom, saveNickname } from '../../net';
import { openPanel, serverNow, setSettings, toast, useStore } from '../../store';
import { copyText, inviteLink } from '../actions';
import { Modal, Panel, PetCard, useNow } from '../common';

export function PlayersPanel() {
  const players = useStore((s) => s.players);
  const room = useStore((s) => s.room)!;
  const me = useStore((s) => s.me)!;
  const trade = useStore((s) => s.trade);
  const [kick, setKick] = useState<{ id: string; name: string } | null>(null);
  const list = Object.values(players).sort((a, b) => Number(b.id === room.ownerId) - Number(a.id === room.ownerId) || a.name.localeCompare(b.name));
  const isOwner = room.ownerId === me.id;
  return (
    <Panel narrow title={`👥 Players · ${list.filter((p) => p.connected).length}/${room.capacity}`}>
      {room.mode === 'friends' ? (
        <div className="card" style={{ marginBottom: 10 }}>
          <div className="row">
            <div className="grow">
              <div style={{ fontWeight: 900 }}>Room code: <span style={{ letterSpacing: 3, fontSize: 22 }}>{room.code}</span></div>
              <div className="muted" style={{ wordBreak: 'break-all' }}>{inviteLink(room.code)}</div>
            </div>
            <button className="btn blue" onClick={async () => {
              const ok = await copyText(inviteLink(room.code));
              toast(ok ? '📋 Invite link copied!' : 'Copy failed — select the link above.', ok ? 'success' : 'error');
            }}>📋 Copy Invite Link</button>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>Friends open the link (or enter the code), pick a nickname and play. No accounts needed.</div>
        </div>
      ) : (
        <div className="info-box" style={{ marginBottom: 10 }}>You're in a private solo room. To play with friends, leave and choose “Create Friends Room”.</div>
      )}
      <div className="list">
        {list.map((p) => (
          <div className="list-row" key={p.id}>
            <div style={{ width: 16, height: 16, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
            <div className="grow">
              <div className="title">{p.id === room.ownerId ? '👑 ' : ''}{p.name}{p.id === me.id ? ' (you)' : ''}</div>
              <div className="sub">⭐ Rank {p.rank} · Area {p.zone}{p.rebirths ? ` · 🔄 ${p.rebirths}` : ''} · {p.pets.length} pets · {p.connected ? '🟢 online' : '🟠 reconnecting…'}</div>
            </div>
            {p.id !== me.id && p.connected && (
              <button className="btn small green" disabled={!!trade} onClick={() => act('tradeRequest', { to: p.id }).then((r) => r.ok && toast(`🤝 Trade request sent to ${p.name}`, 'info'))}>🤝 Trade</button>
            )}
            {isOwner && p.id !== me.id && <button className="btn small red" onClick={() => setKick({ id: p.id, name: p.name })}>Remove</button>}
          </div>
        ))}
      </div>
      <button className="btn grey wide" style={{ marginTop: 12 }} onClick={() => leaveRoom()}>🚪 Leave room</button>
      {kick && (
        <Modal title={`Remove ${kick.name}?`} danger confirmText="Remove" onCancel={() => setKick(null)} onConfirm={async () => {
          const r = await act('kick', { id: kick.id });
          setKick(null);
          if (r.ok) toast(`${kick.name} was removed from the room.`, 'info');
        }}>
          They will be disconnected from this room and can't rejoin it. Their progress is not affected.
        </Modal>
      )}
    </Panel>
  );
}

export function TradePanel() {
  const trade = useStore((s) => s.trade);
  const save = useStore((s) => s.save)!;
  const me = useStore((s) => s.me)!;
  const [picking, setPicking] = useState(false);
  const [gems, setGems] = useState('0');
  useNow(250);
  const myOffer = trade?.offers[me.id];
  useEffect(() => {
    if (myOffer) setGems(String(myOffer.gems));
  }, [myOffer?.gems, trade?.id]);
  if (!trade || !myOffer) {
    return <Panel narrow title="🤝 Trade"><div className="muted">No active trade. Open 👥 Players and press Trade next to a friend.</div></Panel>;
  }
  const partnerId = trade.a === me.id ? trade.b : trade.a;
  const partnerName = trade.a === me.id ? trade.bName : trade.aName;
  const theirs = trade.offers[partnerId];
  const eq = new Set(save.equipped);
  const send = (pets: string[], g: number) => act('tradeOffer', { tradeId: trade.id, pets, gems: g });
  const toggle = (id: string) => {
    const has = myOffer.pets.includes(id);
    if (!has && myOffer.pets.length >= BALANCE.maxTradePets) return toast(`Max ${BALANCE.maxTradePets} pets per trade.`, 'error');
    send(has ? myOffer.pets.filter((x) => x !== id) : [...myOffer.pets, id], myOffer.gems);
  };
  const commitGems = () => {
    const n = Math.max(0, Math.floor(Number(gems) || 0));
    if (n !== myOffer.gems) send(myOffer.pets, Math.min(n, save.gems));
  };
  const cancel = () => act('tradeCancel', { tradeId: trade.id });
  const myReady = !!trade.ready[me.id];
  const theirReady = !!trade.ready[partnerId];
  const left = trade.state === 'countdown' ? Math.max(0, Math.ceil((trade.countdownEnd - serverNow()) / 1000)) : 0;
  const myPets = myOffer.pets.map((id) => save.pets.find((p) => p.id === id) ?? trade.petInfo[id]).filter(Boolean) as PetInstance[];
  const theirPets = theirs.pets.map((id) => trade.petInfo[id]).filter(Boolean) as PetInstance[];
  const sum = (ps: PetInstance[]) => ps.reduce((a, p) => a + petPower(p), 0);

  return (
    <Panel title={`🤝 Trading with ${partnerName}`} onClose={cancel}
      footer={
        <>
          <button className="btn red" onClick={cancel}>Cancel trade</button>
          <span className="spacer" />
          {trade.state === 'countdown' ? <div className="countdown">Trading in {left}…</div> : <span className="muted">{myReady && !theirReady ? `Waiting for ${partnerName} to confirm…` : 'Both players must review and confirm.'}</span>}
          <button className={`btn big ${myReady ? 'grey' : 'green'}`} onClick={() => {
            sfx('click');
            act('tradeReady', { tradeId: trade.id, version: trade.version, ready: !myReady });
          }}>{myReady ? 'Unconfirm' : '✅ Confirm offer'}</button>
        </>
      }>
      <div className="warn-box" style={{ marginBottom: 10 }}>Any change to either offer resets both confirmations. After both confirm there is a {BALANCE.tradeCountdownSec}-second countdown; the swap happens all at once on the server.</div>
      <div className="trade-cols">
        <div className={`trade-side${myReady ? ' ready' : ''}`}>
          <h3>You give {myReady ? '✅' : ''}</h3>
          <div className="mini-cards">
            {myPets.map((p) => <PetCard key={p.id} pet={p} mini onClick={() => toggle(p.id)} note={eq.has(p.id) ? 'equipped' : undefined} />)}
          </div>
          {myPets.length === 0 && <div className="muted">No pets offered.</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <span style={{ fontWeight: 900 }}>💎</span>
            <input className="input" style={{ width: 120, padding: '6px 10px' }} inputMode="numeric" value={gems} onChange={(e) => setGems(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitGems} onKeyDown={(e) => e.key === 'Enter' && commitGems()} aria-label="Gems to offer" />
            <span className="muted">of {fmt(save.gems)}</span>
            <span className="spacer" />
            <button className="btn small blue" onClick={() => setPicking(!picking)}>{picking ? 'Done' : '+ Add pets'}</button>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>Offer power: ⚔️ {fmt(sum(myPets))}</div>
        </div>
        <div className={`trade-side${theirReady ? ' ready' : ''}`}>
          <h3>{partnerName} gives {theirReady ? '✅' : ''}</h3>
          <div className="mini-cards">{theirPets.map((p) => <PetCard key={p.id} pet={p} mini />)}</div>
          {theirPets.length === 0 && <div className="muted">No pets offered.</div>}
          <div style={{ fontWeight: 900, marginTop: 8 }}>💎 {fmt(theirs.gems)} gems</div>
          <div className="muted">Offer power: ⚔️ {fmt(sum(theirPets))}</div>
        </div>
      </div>
      {picking && (
        <>
          <div className="section-title">Tap pets to add/remove · 🔒 locked pets can't be traded · equipped pets are unequipped when the trade completes</div>
          <div className="grid-cards">
            {[...save.pets].sort((a, b) => petPower(b) - petPower(a)).map((p) => (
              <PetCard key={p.id} pet={p} equipped={eq.has(p.id)} selected={myOffer.pets.includes(p.id)} disabled={!!p.lk}
                note={p.lk ? '🔒 locked' : eq.has(p.id) ? 'equipped' : undefined} onClick={() => toggle(p.id)} />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

export function SettingsPanel() {
  const s = useStore((st) => st.settings);
  const me = useStore((st) => st.me);
  const devCheats = useStore((st) => st.devCheats);
  const [nick, setNick] = useState(me?.nickname ?? '');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const upd = (patch: Partial<typeof s>) => {
    setSettings(patch);
    setTimeout(applyVolumes, 0);
  };
  return (
    <Panel narrow title="⚙️ Settings">
      <div className="settings-grid">
        <label className="setting">🎵 Music<input type="range" min={0} max={1} step={0.05} value={s.music} onChange={(e) => upd({ music: +e.target.value })} /></label>
        <label className="setting">🔊 Sound effects<input type="range" min={0} max={1} step={0.05} value={s.sfx} onChange={(e) => upd({ sfx: +e.target.value })} /></label>
        <label className="setting">✨ Reduced effects (fewer particles, no shadows)<input type="checkbox" checked={s.reducedEffects} onChange={(e) => upd({ reducedEffects: e.target.checked })} /></label>
        <label className="setting">⏩ Skip long hatch animations<input type="checkbox" checked={s.skipHatch} onChange={(e) => upd({ skipHatch: e.target.checked })} /></label>
        <label className="setting">🏷 Show other players' names<input type="checkbox" checked={s.showNames} onChange={(e) => upd({ showNames: e.target.checked })} /></label>
        <label className="setting">🎥 Camera sensitivity<input type="range" min={0.3} max={2.5} step={0.1} value={s.camSens} onChange={(e) => upd({ camSens: +e.target.value })} /></label>
        <label className="setting">🖥 Graphics quality
          <select className="select" value={s.quality} onChange={(e) => upd({ quality: e.target.value as any })}>
            <option value="auto">Auto</option>
            <option value="low">Low (phones)</option>
            <option value="high">High</option>
          </select>
        </label>
        <div className="setting">
          <span>✏️ Nickname</span>
          <span className="row">
            <input className="input" style={{ width: 150, padding: '6px 10px', fontSize: 15 }} maxLength={16} value={nick} onChange={(e) => setNick(e.target.value)} />
            <button className="btn small" onClick={async () => {
              const r = await saveNickname(nick);
              toast(r.ok ? 'Nickname updated!' : r.error || 'Could not update nickname', r.ok ? 'success' : 'error');
            }}>Save</button>
          </span>
        </div>
        <div className="info-box">
          <b>💾 About your save</b><br />
          You play as a guest — no account, email or password. Your progress is stored on the game server and linked to this browser by a private, secure cookie.
          Your nickname is only a display name.<br /><br />
          ⚠️ <b>Clearing this browser's cookies/site data, using private browsing, or switching to another browser or device will make this guest save inaccessible.</b>
          There is currently no cross-device recovery.
        </div>
        <div className="info-box">
          <b>🎮 Controls</b><br />
          Desktop: WASD / arrows to move · drag mouse to look · wheel to zoom · click objects to send pets · E interact · Space jump · F auto farm · P pets · Q quests · T teleport · Enter chat · Esc close.<br />
          Mobile: left joystick to move · drag the screen to look · pinch to zoom · tap objects to send pets · ✋ to interact.
        </div>
        {devCheats && (
          <div className="warn-box">
            🛠 Developer cheats are enabled on this server (ENABLE_DEV_CHEATS=1, never in production).
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn small" onClick={() => act('cheat', { coins: 1e9, gems: 1e5 })}>+ coins & gems</button>
              <button className="btn small" onClick={() => act('cheat', { zone: 30 })}>Unlock to area 30</button>
              <button className="btn small" onClick={() => act('cheat', { rank: 12 })}>Rank 12</button>
            </div>
          </div>
        )}
        <button className="btn grey" onClick={() => setConfirmLeave(true)}>🚪 Leave room (back to menu)</button>
      </div>
      {confirmLeave && (
        <Modal title="Leave this room?" confirmText="Leave" onCancel={() => setConfirmLeave(false)} onConfirm={() => { setConfirmLeave(false); openPanel(null); leaveRoom(); }}>
          Your progress is already saved. You can come back any time.
        </Modal>
      )}
    </Panel>
  );
}
