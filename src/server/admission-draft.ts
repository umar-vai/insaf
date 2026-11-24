import { openSecret, sealSecret } from './config';
import { hmacHex, randomToken } from './crypto';
import { readCookie } from './session';

const COOKIE = 'mi_admission_draft';
const DAYS = 2;
const PATH = '/admission';
const MAX_AGE = DAYS * 86400;
const allowed = ['courseId', 'desiredClass', 'prevClass', 'prevInstitute', 'residence', 'studentName', 'birthDate', 'fatherName',
  'fatherOccupation', 'permVillage', 'permPost', 'permThana', 'permDistrict', 'curSame', 'curVillage', 'curPost', 'curThana',
  'curDistrict', 'guardianName', 'guardianOccupation', 'phone', 'pickupName', 'pickupPhone', 'pickupAddress'] as const;

const cookieFor = (token: string, secure: boolean, age: number) =>
  `${COOKIE}=${token}; Path=${PATH}; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;

function tokenOf(request: Request): string | undefined {
  const token = readCookie(request.headers.get('Cookie'), COOKIE);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
const draftId = (secret: string, token: string) => hmacHex(secret, `admission-draft:${token}`);
export const sanitizeDraftFields = (form: FormData) => Object.fromEntries(allowed.flatMap((key) => {
  const value = form.get(key);
  return typeof value === 'string' && !/[<>]/.test(value) ? [[key, value.slice(0, 200)]] : [];
}));

export async function readAdmissionDraft(db: D1Database, secret: string | undefined, request: Request): Promise<Record<string, string> | null> {
  const token = tokenOf(request);
  if (!token || !secret) return null;
  const row = await db.prepare('SELECT fields FROM admission_drafts WHERE id = ? AND expires_at > ?')
    .bind(await draftId(secret, token), Math.floor(Date.now() / 1000)).first<{ fields: string }>();
  const fields = row ? await openSecret(`admission-draft:${token}:${secret}`, row.fields) : null;
  return fields ? JSON.parse(fields) : null;
}

export async function saveAdmissionDraft(db: D1Database, secret: string, request: Request, form: FormData): Promise<string> {
  const token = tokenOf(request) ?? randomToken();
  await db.prepare(`INSERT INTO admission_drafts (id, fields, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET fields = excluded.fields, expires_at = excluded.expires_at`)
    .bind(await draftId(secret, token), await sealSecret(`admission-draft:${token}:${secret}`, JSON.stringify(sanitizeDraftFields(form))), Math.floor(Date.now() / 1000) + MAX_AGE).run();
  return cookieFor(token, request.url.startsWith('https:'), MAX_AGE);
}

export async function clearAdmissionDraft(db: D1Database, secret: string | undefined, request: Request): Promise<string> {
  const token = tokenOf(request);
  if (token && secret) await db.prepare('DELETE FROM admission_drafts WHERE id = ?').bind(await draftId(secret, token)).run();
  return cookieFor('', request.url.startsWith('https:'), 0);
}

export async function pruneAdmissionDrafts(db: D1Database) {
  await db.prepare('DELETE FROM admission_drafts WHERE expires_at <= ?').bind(Math.floor(Date.now() / 1000)).run();
}
