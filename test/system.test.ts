import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { gatewayEnv, institute, openSecret, saveConfig, savedConfig, sealSecret } from '../src/server/config';
import { fillTemplate, sendReminders, smsNumber } from '../src/server/reminders';
import { addStaff, addStaffWithModules, log, setStaffModules, setStaffScope } from '../src/server/admin';
import { adminModule, homeFor, inArea, mayOpen, staffModules } from '../src/server/staff';
import { auditLog } from '../src/server/audit';
import { withRequest } from '../src/server/request-context';
import { allEnrollments, createOfflineCourse, createOfflineStudent, enrollOffline } from '../src/server/offline';

const db = env.DB;
const ACTOR = 'owner@example.org';
const SECRET = 'test-session-secret-0123456789';
const cfgEnv = { SESSION_SECRET: SECRET, SSLCZ_STORE_ID: 'cf_store', SSLCZ_STORE_PASSWORD: 'cf_pass', SSLCZ_SANDBOX: '1' };
const today = '2026-11-08';

beforeEach(async () => {
  await db.batch(
    ['settings', 'staff', 'admin_events', 'offline_charges', 'offline_payments', 'offline_enrollments', 'offline_students', 'offline_courses'].map((t) => db.prepare(`DELETE FROM ${t}`)),
  );
});

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe('system settings', () => {
  it('seals secrets so only the same secret opens them', async () => {
    const sealed = await sealSecret(SECRET, 'p@ss');
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain('p@ss');
    expect(await openSecret(SECRET, sealed)).toBe('p@ss');
    expect(await openSecret('another-secret', sealed)).toBeNull();
  });

  it('uses the Cloudflare keys until the owner saves others, and stores secrets encrypted', async () => {
    expect(await gatewayEnv(db, cfgEnv)).toEqual({ SSLCZ_STORE_ID: 'cf_store', SSLCZ_STORE_PASSWORD: 'cf_pass', SSLCZ_SANDBOX: '1' });
    const r = await saveConfig(db, cfgEnv, ACTOR, form({ sslczStoreId: 'mine', sslczStorePassword: 'secret-pass', sslczSandbox: 'live', smsSenderId: 'Tamrin', smsApiKey: 'k123' }));
    expect(r.ok && r.changed.sort()).toEqual(['smsApiKey', 'smsSenderId', 'sslczSandbox', 'sslczStoreId', 'sslczStorePassword']);
    expect(await gatewayEnv(db, cfgEnv)).toEqual({ SSLCZ_STORE_ID: 'mine', SSLCZ_STORE_PASSWORD: 'secret-pass', SSLCZ_SANDBOX: '0' });
    const raw = await db.prepare(`SELECT value FROM settings WHERE key = 'cfg.sslczStorePassword'`).first<{ value: string }>();
    expect(raw!.value).not.toContain('secret-pass');
    const logged = await db.prepare(`SELECT detail_json AS d FROM admin_events WHERE action = 'config.update'`).first<{ d: string }>();
    expect(logged!.d).not.toContain('secret-pass');
    expect(logged!.d).not.toContain('k123');
  });

  it('keeps a secret when the box is left empty, and clears it when asked', async () => {
    await saveConfig(db, cfgEnv, ACTOR, form({ sslczStorePassword: 'one' }));
    await saveConfig(db, cfgEnv, ACTOR, form({ sslczStorePassword: '' }));
    expect((await savedConfig(db, cfgEnv)).sslczStorePassword).toBe('one');
    await saveConfig(db, cfgEnv, ACTOR, form({ clear_sslczStorePassword: 'on' }));
    expect((await savedConfig(db, cfgEnv)).sslczStorePassword).toBe('');
    expect((await gatewayEnv(db, cfgEnv)).SSLCZ_STORE_PASSWORD).toBe('cf_pass');
  });

  it('refuses to save without a session secret', async () => {
    expect(await saveConfig(db, {}, ACTOR, form({ smsApiKey: 'x' }))).toEqual({ ok: false, error: 'no_secret' });
  });

  it('prints the saved institute details, else the built-in ones', async () => {
    const before = await institute(db);
    expect(before.logo).toBe('/logo-wide.png');
    await saveConfig(db, cfgEnv, ACTOR, form({ instituteName: 'Tamrin Test', instituteAddress: 'Dhaka' }));
    const after = await institute(db);
    expect(after).toMatchObject({ name: 'Tamrin Test', address: 'Dhaka', phone: before.phone });
  });
});

describe('due reminders', () => {
  async function owing(phone = '01711111111') {
    const courseId = await createOfflineCourse(db, ACTOR, { title: 'Hifz', feeTaka: 1200, admissionTaka: 0, durationMonths: 12, note: '', status: 'active' });
    const sid = await createOfflineStudent(db, ACTOR, { name: 'Rahim', phone, guardianPhone: '', email: 'rahim@gmail.com', address: '', note: '' });
    return (await enrollOffline(db, ACTOR, sid, { courseId, batchId: null, roll: '', startDate: '2026-09-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  }

  it('fills the message from the ledger', async () => {
    const id = await owing();
    const [e] = (await allEnrollments(db, today)).filter((x) => x.id === id);
    expect(fillTemplate('{name}, {course}: {amount} {unknown}', e!, 'overdue')).toBe('Rahim, Hifz: ৩০০ টাকা {unknown}');
  });

  it('reads Bangladeshi mobile numbers only', () => {
    expect(smsNumber('01711-111111')).toBe('8801711111111');
    expect(smsNumber('+8801911111111')).toBe('8801911111111');
    expect(smsNumber('02-9999999')).toBeNull();
  });

  it('sends SMS only when the owner saved a key, and only to people who owe', async () => {
    const id = await owing();
    const opts = { enrollmentIds: [id, 'ofe_missing'], template: 'Dear {name}, {amount} due', channel: 'sms' as const, kind: 'overdue' as const, today };
    expect(await sendReminders(db, cfgEnv, ACTOR, opts)).toEqual({ error: 'sms_off' });
    await saveConfig(db, cfgEnv, ACTOR, form({ smsSenderId: '8809600000000', smsApiKey: 'KEY' }));
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ response_code: 202 }));
    }) as unknown as typeof fetch;
    const r = await sendReminders(db, cfgEnv, ACTOR, opts, fake);
    expect(r).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0]!);
    expect(u.searchParams.get('number')).toBe('8801711111111');
    expect(u.searchParams.get('api_key')).toBe('KEY');
    expect(u.searchParams.get('message')).toBe('Dear Rahim, ৩০০ টাকা due');
  });

  it('counts a refused SMS as failed and refuses empty or huge sends', async () => {
    const id = await owing();
    await saveConfig(db, cfgEnv, ACTOR, form({ smsSenderId: 'S', smsApiKey: 'KEY' }));
    const no = (async () => new Response(JSON.stringify({ response_code: 1007 }))) as unknown as typeof fetch;
    const base = { template: 'Pay {amount}', channel: 'sms' as const, kind: 'all' as const, today };
    expect(await sendReminders(db, cfgEnv, ACTOR, { ...base, enrollmentIds: [id] }, no)).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await sendReminders(db, cfgEnv, ACTOR, { ...base, enrollmentIds: [] })).toEqual({ error: 'none' });
    expect(await sendReminders(db, cfgEnv, ACTOR, { ...base, enrollmentIds: Array.from({ length: 201 }, (_, i) => `e${i}`) })).toEqual({ error: 'too_many' });
  });

  it('email needs the email service on the site', async () => {
    const id = await owing();
    expect(await sendReminders(db, cfgEnv, ACTOR, { enrollmentIds: [id], template: 'Pay {amount}', channel: 'email', kind: 'all', today })).toEqual({ error: 'email_off' });
  });
});

describe('modules', () => {
  const staffEnv = () => ({ DB: db, ADMIN_EMAILS: 'owner@example.org' });

  it('sorts admin pages into modules, with owner only pages', () => {
    expect(adminModule('/admin/offline/expenses')).toBe('accounts');
    expect(adminModule('/admin/offline/voucher/x')).toBe('accounts');
    expect(adminModule('/admin/offline/payroll')).toBe('hr');
    expect(adminModule('/admin/offline/batches/b1')).toBe('academic');
    expect(adminModule('/admin/offline/tickets')).toBe('office');
    expect(adminModule('/admin/offline')).toBe('office');
    expect(adminModule('/admin/blog/b1')).toBe('online_content');
    expect(adminModule('/admin/donations')).toBe('online_sales');
    expect(adminModule('/admin/funds/f1')).toBe('online_sales');
    expect(adminModule('/admin/finance/pnl.csv')).toBe('finance');
    expect(adminModule('/admin/system')).toBe('owner');
    expect(adminModule('/admin/audit')).toBe('owner');
    expect(adminModule('/admin/team')).toBe('shared');
  });

  it('an accounts only member opens accounts and nothing else; owners open everything', async () => {
    expect(await addStaffWithModules(db, staffEnv(), ACTOR, 'acc@example.org', ['accounts'])).toBe('added');
    const a = (await staffModules(staffEnv(), 'acc@example.org'))!;
    expect(a).toMatchObject({ modules: ['accounts'], owner: false, scope: 'offline' });
    expect(mayOpen(a, 'accounts')).toBe(true);
    expect(mayOpen(a, 'office')).toBe(false);
    expect(mayOpen(a, 'owner')).toBe(false);
    expect(inArea(a, 'offline')).toBe(true);
    expect(inArea(a, 'online')).toBe(false);
    expect(homeFor(a)).toBe('/admin/offline/expenses');
    const o = (await staffModules(staffEnv(), 'owner@example.org'))!;
    expect(mayOpen(o, 'owner')).toBe(true);
  });

  it('members from before modules keep the modules of their part; changing modules is logged', async () => {
    await addStaff(db, staffEnv(), ACTOR, 'old@example.org', 'online');
    expect((await staffModules(staffEnv(), 'old@example.org'))!.modules).toEqual(['online_sales', 'online_content']);
    expect(await setStaffModules(db, staffEnv(), ACTOR, 'old@example.org', ['finance', 'bogus'])).toBe(true);
    expect((await staffModules(staffEnv(), 'old@example.org'))!.modules).toEqual(['finance']);
    expect(await setStaffModules(db, staffEnv(), ACTOR, 'old@example.org', [])).toBe(false);
    expect(await setStaffModules(db, staffEnv(), ACTOR, 'owner@example.org', ['finance'])).toBe(false);
    // Picking a part again goes back to that part's modules.
    await setStaffScope(db, staffEnv(), ACTOR, 'old@example.org', 'offline');
    expect((await staffModules(staffEnv(), 'old@example.org'))!.modules).toEqual(['office', 'academic', 'hr', 'accounts']);
    const { results } = await db.prepare(`SELECT action FROM admin_events WHERE target = 'staff:old@example.org' ORDER BY created_at`).all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual(['staff.add', 'staff.modules', 'staff.scope']);
  });
});

describe('audit log', () => {
  it('records the address of the request a change came from', async () => {
    const req = new Request('https://example.org/admin', { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    await withRequest(req, () => log(db, ACTOR, 'offline.payment.void', 'offline_student:s1', { receiptNo: 102 }));
    await log(db, 'system', 'offline.late_fees', 'offline_charges', {});
    const rows = await auditLog(db, {});
    expect(rows.map((r) => [r.action, r.ip])).toEqual([
      ['offline.late_fees', ''],
      ['offline.payment.void', '203.0.113.7'],
    ]);
    expect((await auditLog(db, { q: '203.0.113' })).map((r) => r.action)).toEqual(['offline.payment.void']);
    expect((await auditLog(db, { actor: 'system' })).map((r) => r.action)).toEqual(['offline.late_fees']);
    expect((await auditLog(db, { action: 'offline.payment' })).map((r) => r.action)).toEqual(['offline.payment.void']);
  });
});
