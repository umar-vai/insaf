import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { issueLoginCode, normalizeEmail, verifyLoginCode } from '../src/server/login-code';
import { readSession, safeReturnTo, signSession } from '../src/server/session';
import { finishGoogleSignIn } from '../src/server/google';

const db = env.DB;
// Test-only values.
const auth = {
  SESSION_SECRET: 'test-only-session-secret-0123456789',
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
};
const email = 'student@example.org';

beforeEach(async () => {
  await db.prepare('DELETE FROM login_codes').run();
});

describe('session cookie', () => {
  it('round trips and rejects tampering, another secret or expiry', async () => {
    const now = Date.UTC(2026, 10, 4);
    const value = await signSession(auth, 'stu_1', now);
    expect(await readSession(auth, value, now)).toBe('stu_1');
    expect(await readSession(auth, value.replace('stu_1', 'stu_2'), now)).toBeNull();
    expect(await readSession({ SESSION_SECRET: 'another-test-secret-0123456789' }, value, now)).toBeNull();
    expect(await readSession(auth, value, now + 31 * 86400_000)).toBeNull();
    expect(await readSession(auth, undefined, now)).toBeNull();
  });

  it('only returns to paths on this site', () => {
    expect(safeReturnTo('/learn/সূরা-মূলক/les_1')).toBe('/learn/সূরা-মূলক/les_1');
    expect(safeReturnTo('//evil.example')).toBe('/account');
    expect(safeReturnTo('https://evil.example')).toBe('/account');
    expect(safeReturnTo(null)).toBe('/account');
  });
});

describe('email sign-in code', () => {
  it('accepts the right code once', async () => {
    const issued = await issueLoginCode(db, auth, email);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.code).toMatch(/^\d{6}$/);
    expect(await verifyLoginCode(db, auth, email, issued.code)).toEqual({ ok: true });
    expect(await verifyLoginCode(db, auth, email, issued.code)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('never stores the code itself', async () => {
    const issued = await issueLoginCode(db, auth, email);
    if (!issued.ok) throw new Error('not issued');
    const row = await db.prepare('SELECT code_hash AS h FROM login_codes').first<{ h: string }>();
    expect(row?.h).not.toContain(issued.code);
  });

  it('locks after five wrong tries, even for the right code', async () => {
    const issued = await issueLoginCode(db, auth, email);
    if (!issued.ok) throw new Error('not issued');
    const wrong = issued.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) expect(await verifyLoginCode(db, auth, email, wrong)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyLoginCode(db, auth, email, wrong)).toEqual({ ok: false, reason: 'locked' });
    expect(await verifyLoginCode(db, auth, email, issued.code)).toEqual({ ok: false, reason: 'locked' });
  });

  it('expires after ten minutes', async () => {
    const now = Date.now();
    const issued = await issueLoginCode(db, auth, email, now);
    if (!issued.ok) throw new Error('not issued');
    expect(await verifyLoginCode(db, auth, email, issued.code, now + 11 * 60_000)).toEqual({ ok: false, reason: 'expired' });
  });

  it('gives at most five codes an hour per email', async () => {
    for (let i = 0; i < 5; i++) expect((await issueLoginCode(db, auth, email)).ok).toBe(true);
    expect(await issueLoginCode(db, auth, email)).toEqual({ ok: false, reason: 'too_many' });
    expect((await issueLoginCode(db, auth, 'other@example.org')).ok).toBe(true);
  });

  it('only accepts real looking email addresses', () => {
    expect(normalizeEmail('  Student@Example.ORG ')).toBe('student@example.org');
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });
});

describe('Google sign-in', () => {
  const fakeGoogle = (profile: Record<string, unknown>) =>
    (async (url: string) =>
      new Response(JSON.stringify(String(url).includes('/token') ? { access_token: 'tok' } : profile), { status: 200 })) as unknown as typeof fetch;

  it('rejects a mismatched state', async () => {
    const r = await finishGoogleSignIn(auth, 'https://x.test', { code: 'c', state: 'a' }, 'b.verifier./account', fakeGoogle({}));
    expect(r).toEqual({ ok: false, reason: 'state' });
  });

  it('rejects an email Google has not verified', async () => {
    const r = await finishGoogleSignIn(
      auth,
      'https://x.test',
      { code: 'c', state: 's' },
      's.verifier./account',
      fakeGoogle({ sub: '1', email: 'a@example.org', email_verified: false }),
    );
    expect(r).toEqual({ ok: false, reason: 'email' });
  });
});
