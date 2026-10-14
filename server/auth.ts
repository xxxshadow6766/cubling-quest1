// Anonymous guest identity: a random secret token lives ONLY in an HttpOnly cookie.
// The database stores a SHA-256 hash of it. The nickname is just a display name.
import crypto from 'node:crypto';

export const COOKIE_NAME = 'cq_guest';
const MAX_AGE_SEC = 400 * 24 * 3600; // browsers cap cookie lifetime at ~400 days

export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function newId(bytes = 9): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_SEC}${secure ? '; Secure' : ''}`;
}

export function tokenFromCookieHeader(header: string | undefined): string | null {
  const t = parseCookies(header)[COOKIE_NAME];
  return t && /^[A-Za-z0-9_-]{30,64}$/.test(t) ? t : null;
}

const NICK_RE = /^[\p{L}\p{N} _.\-]{2,16}$/u;
export function cleanNickname(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const n = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  return NICK_RE.test(n) ? n : null;
}
