import { log } from './admin';
import { normalizePhone } from './account';
import { sameText } from './crypto';

// Signing in with a mobile number (or email) and a password.
//
// Many guardians have no Gmail, so the office can switch on a password login
// for an offline student or a teacher. The person's sign-in identity is then
// "<mobile>@phone.madrasatulinsaf.org", written into the record's email field
// when it was empty, so every panel that finds people by the account's email
// (server/panels.ts) works unchanged. Brothers and sisters share the guardian's
// number and so share one login, which shows all of them.
//
// Passwords are stored as PBKDF2-SHA256 (100,000 rounds, the most Workers
// allow) with a random salt. The office sees a new password once, to hand over.

const ROUNDS = 100_000;
const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const PHONE_DOMAIN = 'phone.madrasatulinsaf.org';
export const phoneEmail = (phone: string) => `${phone}@${PHONE_DOMAIN}`;
export const isPhoneEmail = (email: string) => email.toLowerCase().endsWith(`@${PHONE_DOMAIN}`);
/** What to show for an account's sign-in name: the number for phone logins. */
export const loginLabel = (email: string) => (isPhoneEmail(email) ? (email.split('@')[0] ?? email) : email);

async function derive(password: string, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: rounds }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ROUNDS}$${b64(salt)}$${b64(await derive(password, salt, ROUNDS))}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [tag, rounds, salt, hash] = (stored ?? '').split('$');
  if (tag !== 'pbkdf2' || !rounds || !salt || !hash) return false;
  const n = Number(rounds);
  if (!Number.isInteger(n) || n < 1000 || n > ROUNDS) return false;
  return sameText(b64(await derive(password, unb64(salt), n)), hash);
}

/** Easy to read out over the phone: no 0/O, 1/l. */
export function newPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export const passwordOk = (p: string) => p.length >= 6 && p.length <= 100;

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Finds the account for a mobile number or email and checks the password. Returns its id or null. */
export async function signInWithPassword(db: D1Database, identifier: string, password: string): Promise<string | null> {
  const raw = identifier.trim().replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
  const phone = normalizePhone(raw);
  const email = phone ? phoneEmail(phone) : raw.toLowerCase();
  if (!email.includes('@') || !password) return null;
  let row = await db.prepare('SELECT id, password_hash AS hash FROM students WHERE lower(email) = ?').bind(email).first<{ id: string; hash: string | null }>();
  if (!row?.hash && phone) {
    // An account that signs in with a Gmail but was also given a password and this number.
    const { results } = await db
      .prepare('SELECT id, password_hash AS hash FROM students WHERE phone = ? AND password_hash IS NOT NULL LIMIT 2')
      .bind(phone)
      .all<{ id: string; hash: string }>();
    row = results.length === 1 ? results[0]! : null;
  }
  if (!row?.hash || !(await verifyPassword(password, row.hash))) return null;
  await db.prepare(`UPDATE students SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).bind(row.id).run();
  return row.id;
}

export async function changePassword(db: D1Database, accountId: string, current: string, next: string): Promise<'ok' | 'wrong' | 'weak'> {
  if (!passwordOk(next)) return 'weak';
  const row = await db.prepare('SELECT password_hash AS hash FROM students WHERE id = ?').bind(accountId).first<{ hash: string | null }>();
  // Someone who signed in with Google and never had a password may set one without the old one.
  if (row?.hash && !(await verifyPassword(current, row.hash))) return 'wrong';
  await db.prepare('UPDATE students SET password_hash = ? WHERE id = ?').bind(await hashPassword(next), accountId).run();
  return 'ok';
}

export type LoginGrant = { ok: true; login: string; password: string } | { ok: false; reason: 'not_found' | 'phone' };

/**
 * Gives an offline student (kind 'student') or a teacher a password login,
 * or a new password if they had one. Returns the password to hand over once.
 */
export async function grantPasswordLogin(db: D1Database, actor: string, kind: 'student' | 'teacher', recordId: string): Promise<LoginGrant> {
  const table = kind === 'student' ? 'offline_students' : 'teachers';
  const rec = await db.prepare(`SELECT id, name, phone, email${kind === 'student' ? ', guardian_phone AS guardianPhone' : ''} FROM ${table} WHERE id = ?`).bind(recordId).first<{
    id: string;
    name: string;
    phone: string;
    email: string;
    guardianPhone?: string;
  }>();
  if (!rec) return { ok: false, reason: 'not_found' };
  const phone = normalizePhone(rec.phone) ?? normalizePhone(rec.guardianPhone ?? '');
  let email = rec.email.trim();
  if (!email) {
    if (!phone) return { ok: false, reason: 'phone' };
    email = phoneEmail(phone);
    await db.prepare(`UPDATE ${table} SET email = ? WHERE id = ?`).bind(email, rec.id).run();
  }
  const password = newPassword();
  const hash = await hashPassword(password);
  await db
    .prepare(
      `INSERT INTO students (id, email, name, phone, password_hash) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (lower(email)) DO UPDATE SET password_hash = excluded.password_hash,
         phone = coalesce(students.phone, excluded.phone), name = CASE WHEN students.name = '' THEN excluded.name ELSE students.name END`,
    )
    .bind(`stu_${crypto.randomUUID()}`, email, rec.name, phone, hash)
    .run();
  await log(db, actor, 'login.password', `${kind}:${rec.id}`, { login: loginLabel(email) });
  return { ok: true, login: phone && isPhoneEmail(email) ? phone : email, password };
}
