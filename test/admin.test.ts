import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { addStaff, removeStaff } from '../src/server/admin';
import { isStaffEmail, staffEmail } from '../src/server/staff';
import { signSession, SESSION_COOKIE } from '../src/server/session';
import { isTestSite } from '../src/lib/envs';

const db = env.DB;
const owners = { DB: db, ADMIN_EMAILS: 'owner@example.org' };

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM admin_events'),
    db.prepare('DELETE FROM staff'),
    db.prepare('DELETE FROM students'),
    db.prepare(`INSERT INTO students (id, email, name, phone) VALUES ('stu_a', 'amina@example.org', 'Amina', '01711111111')`),
  ]);
});

describe('who may use the admin', () => {
  const req = (host: string) => new Request(`http://${host}/admin/dashboard`);

  it('lets nobody in without Access, owners or staff', async () => {
    expect(await staffEmail(req('tamrin.example'), { DB: db })).toBeNull();
  });

  it('allows the local bypass only on localhost', async () => {
    expect(await staffEmail(req('localhost:4322'), { DB: db, ADMIN_DEV_BYPASS: '1' })).toBe('dev@localhost');
    expect(await staffEmail(req('tamrininstitute.com'), { DB: db, ADMIN_DEV_BYPASS: '1' })).toBeNull();
  });

  it('ignores a forged Access header when Access is not configured', async () => {
    const r = new Request('https://tamrininstitute.com/admin', { headers: { 'Cf-Access-Jwt-Assertion': 'a.b.c' } });
    expect(await staffEmail(r, owners)).toBeNull();
  });

  it('counts owners and added staff, case insensitively', async () => {
    expect(await isStaffEmail(owners, 'Owner@Example.org')).toBe(true);
    expect(await isStaffEmail(owners, 'teacher@example.org')).toBe(false);
    expect(await addStaff(db, owners, 'owner@example.org', 'Teacher@Example.org')).toBe('added');
    expect(await isStaffEmail(owners, 'teacher@example.org')).toBe(true);
  });

  it('lets an owner in through the normal sign-in, but not other students', async () => {
    const env = { ...owners, SESSION_SECRET: 'test-only-session-secret-0123456789' };
    await db.prepare(`INSERT INTO students (id, email) VALUES ('stu_owner', 'Owner@Example.org')`).run();
    const as = async (id: string) =>
      new Request('https://preview.tamrin.test/admin/dashboard', { headers: { Cookie: `${SESSION_COOKIE}=${await signSession(env, id)}` } });
    expect(await staffEmail(await as('stu_owner'), env)).toBe('owner@example.org');
    expect(await staffEmail(await as('stu_a'), env)).toBeNull();
    // A cookie signed with another secret is worthless.
    const forged = new Request('https://preview.tamrin.test/admin', {
      headers: { Cookie: `${SESSION_COOKIE}=${await signSession({ SESSION_SECRET: 'attacker-secret-0123456789abcdef' }, 'stu_owner')}` },
    });
    expect(await staffEmail(forged, env)).toBeNull();
  });

  it('never treats preview or the real site as a test site', () => {
    expect(isTestSite({ ENVIRONMENT: 'local' })).toBe(true);
    expect(isTestSite({ ENVIRONMENT: 'staging' })).toBe(true);
    expect(isTestSite({ ENVIRONMENT: 'preview' })).toBe(false);
    expect(isTestSite({ ENVIRONMENT: 'production' })).toBe(false);
    expect(isTestSite({})).toBe(false);
  });

  it('never removes owners or yourself', async () => {
    await addStaff(db, owners, 'owner@example.org', 'teacher@example.org');
    expect(await removeStaff(db, owners, 'teacher@example.org', 'teacher@example.org')).toBe(false);
    expect(await removeStaff(db, owners, 'teacher@example.org', 'owner@example.org')).toBe(false);
    expect(await removeStaff(db, owners, 'owner@example.org', 'teacher@example.org')).toBe(true);
    expect(await addStaff(db, owners, 'owner@example.org', 'not an email')).toBe('invalid');
  });
});

