// Nightly copy of the whole database to a separate R2 bucket (BACKUPS).
//
// How: Cloudflare's D1 export API makes a full SQL dump (outside our Worker, so a
// big database does not hit Worker limits); we download it, check it, store it as
// daily/YYYY-MM-DD.sql, and on the 1st of a month also as monthly/YYYY-MM.sql.
// Daily copies are kept 30 days, monthly copies 12 months. Every run, good or bad,
// is written to the audit log (actions backup.ok and backup.failed), which is the
// backup history. The owner sees a red warning when no good copy exists for 26 hours.
//
// Needs: the BACKUPS bucket, secrets CF_BACKUP_TOKEN (D1 read and export only) and
// CF_ACCOUNT_ID, and BACKUP_D1_ID (the database id, not secret). Without them a
// run is recorded as failed so the warning shows, never silently skipped.
// This is a second copy beside D1 Time Travel (30 days), not a replacement for it.

export type BackupEnv = {
  DB: D1Database;
  BACKUPS?: R2Bucket;
  CF_BACKUP_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  BACKUP_D1_ID?: string;
  ENVIRONMENT?: string;
};

export const DAILY_KEEP_DAYS = 30;
export const MONTHLY_KEEP_MONTHS = 12;
export const STALE_HOURS = 26;

type Deps = { fetcher?: typeof fetch; now?: Date; sleep?: (ms: number) => Promise<void> };

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

async function audit(db: D1Database, action: string, detail: Record<string, unknown>) {
  await db
    .prepare('INSERT INTO admin_events (id, actor, action, target, detail_json) VALUES (?, ?, ?, ?, ?)')
    .bind(`ae_${crypto.randomUUID()}`, 'system', action, 'backup', JSON.stringify(detail).slice(0, 1500))
    .run();
}

/** Asks Cloudflare for a dump and waits for its download address. */
async function exportDump(env: BackupEnv, fetcher: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<string> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/d1/database/${env.BACKUP_D1_ID}/export`;
  const headers = { Authorization: `Bearer ${env.CF_BACKUP_TOKEN}`, 'Content-Type': 'application/json' };
  let bookmark: string | undefined;
  for (let i = 0; i < 30; i++) {
    const res = await fetcher(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bookmark ? { output_format: 'polling', current_bookmark: bookmark } : { output_format: 'polling' }),
      signal: AbortSignal.timeout(20000),
    });
    const j = (await res.json().catch(() => null)) as { success?: boolean; errors?: { message?: string }[]; result?: { status?: string; error?: string; at_bookmark?: string; result?: { signed_url?: string } } } | null;
    if (!res.ok || !j?.success) throw new Error(`export request failed (${res.status}) ${j?.errors?.[0]?.message ?? ''}`.trim());
    const r = j.result;
    if (r?.status === 'complete' && r.result?.signed_url) return r.result.signed_url;
    if (r?.status === 'error') throw new Error(`export failed: ${r.error ?? 'unknown'}`);
    bookmark = r?.at_bookmark ?? bookmark;
    await sleep(2000);
  }
  throw new Error('export did not finish in time');
}

/** A dump that is empty or has no tables must never replace trust in the last good one. */
export function looksLikeDump(sql: string): boolean {
  return sql.length > 200 && sql.includes('CREATE TABLE') && /CREATE TABLE\s+[`"']?donations[`"']?/i.test(sql) && /CREATE TABLE\s+[`"']?offline_students[`"']?/i.test(sql);
}

export async function pruneBackups(bucket: R2Bucket, now: Date): Promise<number> {
  const dailyCut = dayOf(new Date(now.getTime() - DAILY_KEEP_DAYS * 86400000));
  const m = new Date(now);
  m.setUTCMonth(m.getUTCMonth() - MONTHLY_KEEP_MONTHS);
  const monthlyCut = dayOf(m).slice(0, 7);
  let removed = 0;
  for (const [prefix, cut, len] of [['daily/', dailyCut, 10], ['monthly/', monthlyCut, 7]] as const) {
    const list = await bucket.list({ prefix });
    for (const o of list.objects) {
      const stamp = o.key.slice(prefix.length, prefix.length + len);
      if (/^\d{4}-\d{2}(-\d{2})?$/.test(stamp) && stamp < cut) {
        await bucket.delete(o.key);
        removed++;
      }
    }
  }
  return removed;
}

/** One backup run. Never throws: the result is recorded in the audit log. */
export async function runBackup(env: BackupEnv, deps: Deps = {}): Promise<{ ok: boolean; key?: string; bytes?: number; error?: string }> {
  const now = deps.now ?? new Date();
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    if (!env.BACKUPS || !env.CF_BACKUP_TOKEN || !env.CF_ACCOUNT_ID || !env.BACKUP_D1_ID) throw new Error('backup is not set up (bucket, token, account id or database id missing)');
    const signed = await exportDump(env, fetcher, sleep);
    const res = await fetcher(signed, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const sql = await res.text();
    if (!looksLikeDump(sql)) throw new Error('the dump looks incomplete, not stored');
    const key = `daily/${dayOf(now)}.sql`;
    await env.BACKUPS.put(key, sql, { httpMetadata: { contentType: 'application/sql' } });
    if (dayOf(now).endsWith('-01')) await env.BACKUPS.put(`monthly/${dayOf(now).slice(0, 7)}.sql`, sql, { httpMetadata: { contentType: 'application/sql' } });
    const bytes = new TextEncoder().encode(sql).length;
    let removed = 0;
    try {
      removed = await pruneBackups(env.BACKUPS, now);
    } catch {
      // A cleanup problem must not hide a good backup.
    }
    await audit(env.DB, 'backup.ok', { key, bytes, removed });
    return { ok: true, key, bytes };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    await audit(env.DB, 'backup.failed', { error }).catch(() => {});
    return { ok: false, error };
  }
}

export type BackupStatus = { state: 'ok' | 'stale' | 'never'; lastOkAt: string | null; lastError: string | null };

/** For the owner's warning: ok, or no good copy within 26 hours, or none ever. */
export async function backupStatus(db: D1Database, now = new Date()): Promise<BackupStatus> {
  const ok = await db.prepare(`SELECT created_at AS at FROM admin_events WHERE action = 'backup.ok' ORDER BY created_at DESC LIMIT 1`).first<{ at: string }>();
  const bad = await db.prepare(`SELECT detail_json AS d, created_at AS at FROM admin_events WHERE action = 'backup.failed' ORDER BY created_at DESC LIMIT 1`).first<{ d: string; at: string }>();
  let lastError: string | null = null;
  if (bad && (!ok || bad.at > ok.at)) {
    try {
      lastError = (JSON.parse(bad.d) as { error?: string }).error ?? null;
    } catch {
      lastError = null;
    }
  }
  if (!ok) return { state: 'never', lastOkAt: null, lastError };
  const age = now.getTime() - new Date(ok.at).getTime();
  return { state: age > STALE_HOURS * 3600000 ? 'stale' : 'ok', lastOkAt: ok.at, lastError };
}
