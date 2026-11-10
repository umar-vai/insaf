import { hmacHex, sameText } from './crypto';
import type { SessionEnv } from './session';

// Email sign-in: a 6 digit code, valid for 10 minutes and 5 tries. Only a
// keyed hash of the code is stored, and each email can ask for at most 5
// codes an hour.

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

export const normalizeEmail = (value: unknown) =>
  typeof value === 'string' && /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;

const codeHash = (env: SessionEnv, email: string, code: string) => hmacHex(env.SESSION_SECRET, `login:${email}:${code}`);

export type IssueResult = { ok: true; code: string } | { ok: false; reason: 'too_many' };

export async function issueLoginCode(db: D1Database, env: SessionEnv, email: string, now = Date.now()): Promise<IssueResult> {
  const hourAgo = new Date(now - 3600_000).toISOString();
  const recent = await db
    .prepare('SELECT count(*) AS n FROM login_codes WHERE email = ? AND created_at > ?')
    .bind(email, hourAgo)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) return { ok: false, reason: 'too_many' };

  // Codes that ran out are of no use to anyone; clear them as new ones are made.
  await db.prepare('DELETE FROM login_codes WHERE expires_at < ?').bind(new Date(now).toISOString()).run();
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  const code = String(n).padStart(6, '0');
  await db
    .prepare('INSERT INTO login_codes (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(
      `lc_${crypto.randomUUID()}`,
      email,
      await codeHash(env, email, code),
      new Date(now + CODE_MINUTES * 60_000).toISOString(),
      new Date(now).toISOString(),
    )
    .run();
  return { ok: true, code };
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'invalid' | 'expired' | 'locked' };

/** Checks the newest code for this email. A used code is deleted. */
export async function verifyLoginCode(
  db: D1Database,
  env: SessionEnv,
  email: string,
  code: string,
  now = Date.now(),
): Promise<VerifyResult> {
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'invalid' };
  const row = await db
    .prepare('SELECT id, code_hash AS hash, attempts, expires_at AS expiresAt FROM login_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1')
    .bind(email)
    .first<{ id: string; hash: string; attempts: number; expiresAt: string }>();
  if (!row) return { ok: false, reason: 'invalid' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked' };
  if (Date.parse(row.expiresAt) < now) return { ok: false, reason: 'expired' };

  if (!sameText(row.hash, await codeHash(env, email, code))) {
    await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').bind(row.id).run();
    return { ok: false, reason: row.attempts + 1 >= MAX_ATTEMPTS ? 'locked' : 'invalid' };
  }
  await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
  return { ok: true };
}
