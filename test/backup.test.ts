import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backupStatus, looksLikeDump, pruneBackups, runBackup, type BackupEnv } from '../src/server/backup';

const dump = `CREATE TABLE donations (id text);\nCREATE TABLE offline_students (id text);\n${'INSERT INTO donations VALUES (1);\n'.repeat(20)}`;
const base = (): BackupEnv => ({ DB: env.DB, BACKUPS: (env as unknown as { BACKUPS: R2Bucket }).BACKUPS, CF_BACKUP_TOKEN: 't', CF_ACCOUNT_ID: 'a', BACKUP_D1_ID: 'd' });
const json = (b: unknown, ok = true) => new Response(JSON.stringify(b), { status: ok ? 200 : 500 });
const okFetch = (sql = dump) =>
  vi.fn(async (u: string | URL | Request) => {
    const url = String(u);
    if (url.includes('/export')) return json({ success: true, result: { status: 'complete', result: { signed_url: 'https://signed/x' } } });
    return new Response(sql);
  }) as unknown as typeof fetch;
const noSleep = async () => {};

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM admin_events WHERE target = 'backup'`).run();
  const b = base().BACKUPS!;
  for (const o of (await b.list()).objects) await b.delete(o.key);
});

describe('nightly backup', () => {
  it('rejects dumps that are empty or have no tables', () => {
    expect(looksLikeDump('')).toBe(false);
    expect(looksLikeDump('x'.repeat(500))).toBe(false);
    expect(looksLikeDump(dump)).toBe(true);
  });

  it('stores the daily copy, a monthly copy on the 1st, and logs it', async () => {
    const r = await runBackup(base(), { fetcher: okFetch(), now: new Date('2026-12-01T18:15:00Z'), sleep: noSleep });
    expect(r.ok).toBe(true);
    const b = base().BACKUPS!;
    expect(await (await b.get('daily/2026-12-01.sql'))!.text()).toBe(dump);
    expect(await b.get('monthly/2026-12.sql')).not.toBeNull();
    expect((await backupStatus(env.DB)).state).toBe('ok');
  });

  it('polls until the export is ready', async () => {
    let n = 0;
    const f = vi.fn(async (u: string | URL | Request) => {
      if (String(u).includes('/export')) return json({ success: true, result: ++n < 3 ? { status: 'active', at_bookmark: 'bm' } : { status: 'complete', result: { signed_url: 'https://signed/x' } } });
      return new Response(dump);
    }) as unknown as typeof fetch;
    expect((await runBackup(base(), { fetcher: f, now: new Date('2026-12-02T18:15:00Z'), sleep: noSleep })).ok).toBe(true);
    expect(n).toBe(3);
  });

  it('records a failure and shows the warning when the dump is bad, without storing it', async () => {
    const r = await runBackup(base(), { fetcher: okFetch('tiny'), now: new Date('2026-12-03T18:15:00Z'), sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(await base().BACKUPS!.get('daily/2026-12-03.sql')).toBeNull();
    const s = await backupStatus(env.DB);
    expect(s.state).toBe('never');
    expect(s.lastError).toContain('incomplete');
  });

  it('fails loudly when it is not set up, and when Cloudflare refuses', async () => {
    const r1 = await runBackup({ ...base(), CF_BACKUP_TOKEN: undefined }, { fetcher: okFetch(), sleep: noSleep });
    expect(r1.ok).toBe(false);
    const refuse = vi.fn(async () => json({ success: false, errors: [{ message: 'denied' }] }, false)) as unknown as typeof fetch;
    const r2 = await runBackup(base(), { fetcher: refuse, sleep: noSleep });
    expect(r2.error).toContain('denied');
  });

  it('is stale after 26 hours without a good copy', async () => {
    await runBackup(base(), { fetcher: okFetch(), now: new Date('2026-12-04T18:15:00Z'), sleep: noSleep });
    const at = (await env.DB.prepare(`SELECT created_at AS at FROM admin_events WHERE action = 'backup.ok'`).first<{ at: string }>())!.at;
    const later = new Date(new Date(at).getTime() + 27 * 3600000);
    expect((await backupStatus(env.DB, later)).state).toBe('stale');
  });

  it('keeps 30 daily and 12 monthly copies and removes older ones', async () => {
    const b = base().BACKUPS!;
    for (const k of ['daily/2026-10-01.sql', 'daily/2026-11-20.sql', 'monthly/2025-10.sql', 'monthly/2025-12.sql']) await b.put(k, 'x');
    const removed = await pruneBackups(b, new Date('2026-12-04T00:00:00Z'));
    expect(removed).toBe(2);
    expect((await b.list()).objects.map((o) => o.key).sort()).toEqual(['daily/2026-11-20.sql', 'monthly/2025-12.sql']);
  });
});
