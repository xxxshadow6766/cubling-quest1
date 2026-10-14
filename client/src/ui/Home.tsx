import { useEffect, useMemo, useState } from 'react';
import { SPECIES } from '../../../shared/config';
import { unlockAudio, sfx } from '../audio';
import { loadAssets } from '../game/assets';
import { enterRoom, fetchSession, roomInfo, saveNickname } from '../net';
import { store, useStore } from '../store';
import { PetImg } from './common';

const NICK_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;

export function Home() {
  const homeError = useStore((s) => s.homeError);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [session, setSession] = useState<{ ok: boolean; nickname?: string; zone?: number; rebirths?: number } | null>(null);
  const [assets, setAssets] = useState(false);
  const [invite, setInvite] = useState<{ code: string; exists: boolean; players: number; capacity: number } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const inv = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    if (inv) {
      setCode(inv);
      roomInfo(inv).then((r) => setInvite({ code: inv, exists: !!r.exists, players: r.players ?? 0, capacity: r.capacity ?? 12 }));
    }
    fetchSession().then((s) => {
      setSession(s);
      if (s.ok && s.nickname) setName(s.nickname);
    });
    loadAssets().then(() => setAssets(true)).catch(() => setErr('Could not load game models. Please refresh the page.'));
  }, []);

  const floaters = useMemo(() => {
    const pool = SPECIES.filter((s) => s.r !== 'common');
    return Array.from({ length: 7 }, (_, i) => ({ s: pool[(i * 13 + 5) % pool.length].id, left: [4, 82, 12, 74, 2, 88, 40][i], top: [8, 6, 70, 76, 40, 42, 88][i], delay: i * 0.7 }));
  }, []);

  const lastRoom = (() => {
    try {
      return sessionStorage.getItem('cq_room');
    } catch {
      return null;
    }
  })();

  async function start(kind: 'solo' | 'create' | 'join', codeOverride?: string) {
    setErr('');
    store.set({ homeError: '' });
    const n = name.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!NICK_RE.test(n)) {
      setErr('Pick a nickname with 2–16 letters, numbers, spaces, dots, dashes or underscores.');
      sfx('error');
      return;
    }
    const c = (codeOverride ?? code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (kind === 'join' && c.length < 4) {
      setErr('Enter the room code your friend shared (6 characters).');
      return;
    }
    unlockAudio();
    sfx('click');
    setBusy(true);
    const r = await saveNickname(n);
    if (!r.ok) {
      setErr(r.error || 'Could not start your guest session.');
      setBusy(false);
      return;
    }
    store.set({ screen: 'loading', loadingText: 'Loading the world…' });
    try {
      await loadAssets();
    } catch {
      store.set({ screen: 'home', homeError: 'Could not load game models. Please refresh.' });
      setBusy(false);
      return;
    }
    if (kind === 'join' && !codeOverride) history.replaceState(null, '', `/?room=${c}`);
    await enterRoom(kind, c);
    setBusy(false);
  }

  const shownErr = err || homeError;
  return (
    <div className="home">
      {assets && floaters.map((f, i) => (
        <div key={i} className="home-float" style={{ left: `${f.left}%`, top: `${f.top}%`, animationDelay: `${f.delay}s` }}>
          <PetImg pet={{ s: f.s, v: i === 2 ? 'golden' : i === 5 ? 'rainbow' : 'normal' }} className="thumb" />
        </div>
      ))}
      <div className="home-card">
        <h1 className="logo">Cubling Quest</h1>
        <div className="tagline">Hatch cute cubes · Smash treasure · Play with friends</div>
        {shownErr && <div className="error-box">{shownErr}</div>}
        {invite && (
          <div className="invite-box">
            {invite.exists ? (
              <>🎉 You're invited to room <b>{invite.code}</b>! <div className="muted">{invite.players}/{invite.capacity} players online</div></>
            ) : (
              <>Room <b>{invite.code}</b> was not found. It may have expired — ask your friend for a new link.</>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="nick">Your nickname</label>
          <input id="nick" className="input" maxLength={16} value={name} placeholder="e.g. PixelPaws" autoComplete="nickname"
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && start(invite?.exists ? 'join' : 'solo')} />
        </div>
        {session?.ok && (
          <div className="muted" style={{ marginBottom: 10, textAlign: 'center' }}>
            👋 Welcome back! Your save: Area {session.zone}{session.rebirths ? ` · Rebirth ${session.rebirths}` : ''}
          </div>
        )}
        <div className="home-actions">
          {session?.ok && lastRoom && !invite && (
            <button className="btn gold big" disabled={busy} onClick={() => start('join', lastRoom)}>↩ Rejoin your last room</button>
          )}
          {invite?.exists && (
            <button className="btn pink big" disabled={busy} onClick={() => start('join')}>🎉 Join {invite.code}</button>
          )}
          <button className="btn green big" disabled={busy} onClick={() => start('solo')}>▶ Play Solo</button>
          <button className="btn blue big" disabled={busy} onClick={() => start('create')}>👥 Create Friends Room</button>
          <div className="join-row">
            <input className="input" aria-label="Room code" placeholder="ROOM CODE" maxLength={8} value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && start('join')} />
            <button className="btn" disabled={busy} onClick={() => start('join')}>Join</button>
          </div>
        </div>
        <div className="note">
          No account needed — your progress is saved automatically on the game server and linked to this browser.
          Up to 12 friends per room, from any device or network.
        </div>
      </div>
    </div>
  );
}
