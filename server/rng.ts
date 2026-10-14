import crypto from 'node:crypto';

// Cryptographically secure uniform [0,1) used for all reward/egg rolls (fair & not predictable).
const BUF_SIZE = 4096;
let buf = new Uint32Array(BUF_SIZE);
let idx = BUF_SIZE;

export function rand(): number {
  if (idx >= BUF_SIZE - 1) {
    crypto.getRandomValues(buf);
    idx = 0;
  }
  // 53-bit precision from two 32-bit words
  const hi = buf[idx++] >>> 5;
  const lo = buf[idx++] >>> 6;
  return (hi * 67108864 + lo) / 9007199254740992;
}

/** Rounds x up or down randomly so the expected value equals x. */
export function stochasticRound(x: number): number {
  const f = Math.floor(x);
  return f + (rand() < x - f ? 1 : 0);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function roomCode(len = 6): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}
