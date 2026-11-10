import { hmacHex, sameText } from './crypto';

// The student session is a signed cookie holding only the student id and
// its expiry. Nothing else about the student is in the cookie.

export type SessionEnv = { SESSION_SECRET?: string };

export const SESSION_COOKIE = 'tm_session';
const SESSION_DAYS = 30;

export async function signSession(env: SessionEnv, studentId: string, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  const payload = `${studentId}.${exp}`;
  return `${payload}.${await hmacHex(env.SESSION_SECRET, `session:${payload}`)}`;
}

export async function readSession(env: SessionEnv, cookie: string | undefined, now = Date.now()): Promise<string | null> {
  if (!cookie || !env.SESSION_SECRET) return null;
  const [id, exp, sig] = cookie.split('.');
  if (!id || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  const expected = await hmacHex(env.SESSION_SECRET, `session:${id}.${exp}`);
  return sameText(sig, expected) ? id : null;
}

export const sessionCookie = (value: string, secure: boolean) =>
  `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;

export const clearCookie = (name: string, secure: boolean, path = '/') =>
  `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;

export function readCookie(header: string | null | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

/** Only same-site paths are allowed as the place to return to after sign-in. */
export const safeReturnTo = (value: string | null | undefined) =>
  value && /^\/(?!\/)[\p{L}\p{M}\p{N}/_?=&.%-]{0,300}$/u.test(value) ? value : '/account';

/** State changing requests must come from this site's own pages. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin !== null && origin === new URL(request.url).origin;
}
