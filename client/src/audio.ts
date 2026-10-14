// Procedural sound effects and music with the Web Audio API (no audio files, all original).
import { store } from './store';

let ctx: AudioContext | null = null;
let sfxGain: GainNode;
let musicGain: GainNode;
let musicTimer: number | null = null;
let nextNoteTime = 0;
let step = 0;
let transpose = 0;

function ensure(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  sfxGain = ctx.createGain();
  musicGain = ctx.createGain();
  const comp = ctx.createDynamicsCompressor();
  sfxGain.connect(comp);
  musicGain.connect(comp);
  comp.connect(ctx.destination);
  applyVolumes();
  return ctx;
}

export function applyVolumes() {
  if (!ctx) return;
  const s = store.get().settings;
  sfxGain.gain.value = s.sfx * 0.6;
  musicGain.gain.value = s.music * 0.22;
}

/** Must be called from a user gesture (browser autoplay rules). */
export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
  if (musicTimer === null) startMusic();
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; at?: number; slide?: number; out?: GainNode; attack?: number } = {}) {
  const c = ctx;
  if (!c) return;
  const t = opts.at ?? c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * opts.slide), t + dur);
  const v = opts.vol ?? 0.3;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(v, t + (opts.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(opts.out ?? sfxGain);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol = 0.2, freq = 1200) {
  const c = ctx;
  if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(f);
  f.connect(g);
  g.connect(sfxGain);
  src.start();
}

let lastHit = 0;
const throttle: Record<string, number> = {};

export function sfx(name: string) {
  if (!ctx || store.get().settings.sfx <= 0) return;
  const now = ctx.currentTime;
  const gap: Record<string, number> = { hit: 0.06, coin: 0.04, gem: 0.06, pop: 0.05 };
  if (gap[name] && now - (throttle[name] ?? 0) < gap[name]) return;
  throttle[name] = now;
  switch (name) {
    case 'hit':
      if (now - lastHit < 0.05) return;
      lastHit = now;
      tone(180 + Math.random() * 60, 0.07, { type: 'square', vol: 0.06, slide: 0.6 });
      break;
    case 'break':
      noise(0.18, 0.25, 900);
      tone(520, 0.12, { type: 'triangle', vol: 0.18, slide: 1.8 });
      tone(780, 0.16, { type: 'sine', vol: 0.12, at: now + 0.05 });
      break;
    case 'bigbreak':
      noise(0.4, 0.35, 500);
      [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.25, { type: 'triangle', vol: 0.16, at: now + i * 0.06 }));
      break;
    case 'coin':
      tone(1318 + Math.random() * 80, 0.09, { type: 'square', vol: 0.05 });
      tone(1760, 0.12, { type: 'sine', vol: 0.07, at: now + 0.04 });
      break;
    case 'gem':
      tone(1568, 0.15, { type: 'sine', vol: 0.12 });
      tone(2093, 0.2, { type: 'sine', vol: 0.09, at: now + 0.06 });
      break;
    case 'click':
      tone(660, 0.05, { type: 'triangle', vol: 0.1 });
      break;
    case 'pop':
      tone(400, 0.08, { type: 'sine', vol: 0.15, slide: 2.2 });
      break;
    case 'error':
      tone(200, 0.15, { type: 'sawtooth', vol: 0.08, slide: 0.7 });
      break;
    case 'wobble':
      tone(300, 0.12, { type: 'triangle', vol: 0.1, slide: 1.4 });
      break;
    case 'hatch':
      noise(0.25, 0.3, 1500);
      [523, 659, 784].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.14, at: now + i * 0.07 }));
      break;
    case 'rare':
      [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.35, { type: 'triangle', vol: 0.15, at: now + i * 0.08 }));
      break;
    case 'legendary':
      [392, 523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.5, { type: 'square', vol: 0.07, at: now + i * 0.07 }));
      tone(130, 1.2, { type: 'sine', vol: 0.2, at: now });
      break;
    case 'unlock':
      [392, 494, 587, 784].forEach((f, i) => tone(f, 0.45, { type: 'triangle', vol: 0.14, at: now + i * 0.1 }));
      break;
    case 'buy':
      tone(880, 0.08, { type: 'square', vol: 0.06 });
      tone(1320, 0.14, { type: 'square', vol: 0.06, at: now + 0.07 });
      break;
    case 'jump':
      tone(300, 0.14, { type: 'sine', vol: 0.08, slide: 2 });
      break;
    case 'rankup':
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.13, at: now + i * 0.09 }));
      break;
  }
}

// ---------------------------------------------------------------- music: a gentle looping pentatonic tune
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
const MELODY = [0, 2, 4, 2, 5, 4, 2, -1, 3, 4, 5, 7, 5, 4, 2, -1, 0, 2, 4, 5, 4, 2, 1, -1, 2, 1, 0, 1, 2, 0, -1, -1];
const CHORDS = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [5, 9, 12]];
const BPM = 104;
const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

function startMusic() {
  if (!ctx) return;
  nextNoteTime = ctx.currentTime + 0.1;
  musicTimer = window.setInterval(scheduler, 50);
}

function scheduler() {
  if (!ctx || ctx.state !== 'running') return;
  if (store.get().settings.music <= 0) {
    nextNoteTime = ctx.currentTime + 0.1;
    return;
  }
  const spb = 60 / BPM / 2; // eighth notes
  while (nextNoteTime < ctx.currentTime + 0.2) {
    const base = 60 + transpose;
    const m = MELODY[step % MELODY.length];
    if (m >= 0) tone(midi(base + 12 + SCALE[m]), spb * 1.6, { type: 'triangle', vol: 0.12, at: nextNoteTime, out: musicGain });
    if (step % 8 === 0) {
      const ch = CHORDS[Math.floor(step / 8) % CHORDS.length];
      for (const n of ch) tone(midi(base + n), spb * 7.5, { type: 'sine', vol: 0.06, at: nextNoteTime, out: musicGain, attack: 0.08 });
      tone(midi(base - 12 + ch[0]), spb * 3, { type: 'sine', vol: 0.12, at: nextNoteTime, out: musicGain });
    }
    if (step % 8 === 4) {
      const ch = CHORDS[Math.floor(step / 8) % CHORDS.length];
      tone(midi(base - 12 + ch[0] + 7), spb * 3, { type: 'sine', vol: 0.1, at: nextNoteTime, out: musicGain });
    }
    nextNoteTime += spb;
    step++;
  }
}

/** Shift the music key with the area theme for a bit of variety. */
export function setMusicTheme(themeIndex: number) {
  transpose = [0, 2, -3, 5, -1, -5, 3, -2, 7, -4, 1, -6, 4, 0, -3, 2, -1, 5, -2, 3][themeIndex % 20];
}
