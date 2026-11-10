import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { addTeamMember, listTeam, parseAccessForm, setTeamAccess } from '../src/server/admin';
import { grantsFromForm, grantsText, homeFor, mayDo, parseGrants, roleGrants, staffAccess, staffModules } from '../src/server/staff';
import { signSession, SESSION_COOKIE } from '../src/server/session';

const db = env.DB;
const ACTOR = 'owner@example.org';
const staffEnv = () => ({ DB: db, ADMIN_EMAILS: 'owner@example.org', SESSION_SECRET: 'test-session-secret-0123456789' });

beforeEach(async () => {
  await db.batch(['staff', 'admin_events', 'teachers', 'students'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('levels', () => {
  it('reads levels, and a bare module (saved before levels) as daily work', () => {
    expect(parseGrants('accounts:full,office:view,finance,bogus:full,hr:boss')).toEqual({ accounts: 'full', office: 'view', finance: 'edit' });
    expect(grantsText({ office: 'view', accounts: 'full' })).toBe('office:view,accounts:full');
  });

  it('view < edit < full; owners may do everything', () => {
    const a = { grants: parseGrants('accounts:edit,office:view') };
    expect(mayDo(a, 'accounts', 'view')).toBe(true);
    expect(mayDo(a, 'accounts', 'edit')).toBe(true);
    expect(mayDo(a, 'accounts', 'full')).toBe(false);
    expect(mayDo(a, 'office', 'edit')).toBe(false);
    expect(mayDo(a, 'hr', 'view')).toBe(false);
    expect(mayDo({ owner: true }, 'hr', 'full')).toBe(true);
  });
});

describe('roles', () => {
  it('a role fills levels only in the chosen part', () => {
    expect(roleGrants('admin', 'online')).toEqual({ online_sales: 'full', online_content: 'full' });
    expect(roleGrants('admin', 'offline')).toEqual({ office: 'full', academic: 'full', hr: 'full', accounts: 'full' });
    expect(roleGrants('admin', 'both').finance).toBe('full');
    expect(roleGrants('accountant', 'offline')).toEqual({ office: 'view', hr: 'full', accounts: 'full' });
    expect(roleGrants('viewer', 'online')).toEqual({ online_sales: 'view', online_content: 'view' });
    expect(roleGrants('custom', 'both')).toEqual({});
  });

  it('reads the team form, levels as chosen by hand', () => {
    const f = form({ name: 'Karim', role: 'accountant', area: 'offline', level_accounts: 'full', level_office: 'view', level_hr: '', level_finance: 'boss' });
    expect(parseAccessForm(f, grantsFromForm(f))).toMatchObject({ name: 'Karim', role: 'accountant', area: 'offline', grants: { accounts: 'full', office: 'view' } });
    expect(parseAccessForm(form({ role: 'king', area: 'moon' }), {})).toMatchObject({ role: 'custom', area: 'both' });
  });
});

describe('appointing team members', () => {
  it('an accountant for offline gets exactly those levels and signs in with them', async () => {
    const v = { name: 'Karim', role: 'accountant' as const, area: 'offline' as const, grants: roleGrants('accountant', 'offline') };
    expect(await addTeamMember(db, staffEnv(), ACTOR, 'karim@gmail.com', v)).toBe('added');
    expect(await addTeamMember(db, staffEnv(), ACTOR, 'karim@gmail.com', v)).toBe('exists');
    const m = (await staffModules(staffEnv(), 'karim@gmail.com'))!;
    expect(m).toMatchObject({ scope: 'offline', owner: false, grants: { office: 'view', hr: 'full', accounts: 'full' } });
    await db.prepare(`INSERT INTO students (id, email) VALUES ('stu_k', 'karim@gmail.com')`).run();
    const req = new Request('https://tamrin.test/admin', { headers: { Cookie: `${SESSION_COOKIE}=${await signSession(staffEnv(), 'stu_k')}` } });
    const a = (await staffAccess(req, staffEnv()))!;
    expect(mayDo(a, 'accounts', 'full')).toBe(true);
    expect(mayDo(a, 'office', 'edit')).toBe(false);
    expect(mayDo(a, 'online_sales', 'view')).toBe(false);
  });

  it('a teacher is added to the teachers list once and lands on the teacher panel', async () => {
    const v = { name: 'Ustaz Hasan', role: 'teacher' as const, area: 'offline' as const, grants: {}, phone: '01811111111' };
    expect(await addTeamMember(db, staffEnv(), ACTOR, 'hasan@gmail.com', v)).toBe('added');
    const t = await db.prepare(`SELECT name, phone, role FROM teachers WHERE email = 'hasan@gmail.com'`).first();
    expect(t).toEqual({ name: 'Ustaz Hasan', phone: '01811111111', role: 'teacher' });
    expect(homeFor((await staffModules(staffEnv(), 'hasan@gmail.com'))!)).toBe('/teacher');
    await setTeamAccess(db, staffEnv(), ACTOR, 'hasan@gmail.com', { ...v, grants: { academic: 'view' } });
    expect((await db.prepare(`SELECT count(*) AS n FROM teachers`).first<{ n: number }>())!.n).toBe(1);
    expect((await staffModules(staffEnv(), 'hasan@gmail.com'))!.grants).toEqual({ academic: 'view' });
  });

  it('anyone but a teacher needs at least one part; owners cannot be changed', async () => {
    expect(await addTeamMember(db, staffEnv(), ACTOR, 'x@gmail.com', { name: '', role: 'custom', area: 'both', grants: {} })).toBe('invalid');
    expect(await addTeamMember(db, staffEnv(), ACTOR, 'owner@example.org', { name: '', role: 'admin', area: 'both', grants: roleGrants('admin', 'both') })).toBe('exists');
    await addTeamMember(db, staffEnv(), ACTOR, 'y@gmail.com', { name: '', role: 'viewer', area: 'online', grants: roleGrants('viewer', 'online') });
    expect(await setTeamAccess(db, staffEnv(), ACTOR, 'y@gmail.com', { name: '', role: 'custom', area: 'both', grants: {} })).toBe(false);
    expect(await setTeamAccess(db, staffEnv(), ACTOR, 'owner@example.org', { name: '', role: 'viewer', area: 'both', grants: { office: 'view' } })).toBe(false);
  });

  it('changing access is logged with before and after, and the list shows it', async () => {
    await addTeamMember(db, staffEnv(), ACTOR, 'z@gmail.com', { name: 'Z', role: 'viewer', area: 'online', grants: roleGrants('viewer', 'online') });
    await setTeamAccess(db, staffEnv(), ACTOR, 'z@gmail.com', { name: 'Z', role: 'manager', area: 'both', grants: roleGrants('manager', 'both') });
    const { staff } = await listTeam(db, staffEnv());
    expect(staff[0]).toMatchObject({ email: 'z@gmail.com', role: 'manager', area: 'both', name: 'Z' });
    expect(staff[0]!.grants.finance).toBe('view');
    const { results } = await db.prepare(`SELECT action FROM admin_events ORDER BY created_at`).all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(['staff.add', 'staff.access']);
  });
});
