import { log } from './admin';
import { newId, type Result } from './ops-util';
import { isYmd } from '../lib/offline';

// Closed accounting periods (migration 0009). Once the books are closed
// through a day, nothing dated on or before it can be added, approved or
// voided, so a statement already given to an auditor cannot change. Only an
// owner reopens, with a reason. Verified online fee payments are never
// refused: the money has arrived and must be on record.

/** The last closed day, '' when none. For use inside other statements. */
export const CLOSED_THROUGH_SQL = `(SELECT coalesce(max(through_day), '') FROM acc_period_closes WHERE reopened_at IS NULL)`;

export class PeriodClosedError extends Error {
  constructor(day: string) {
    super(`period_closed:${day}`);
  }
}

export async function closedThrough(db: D1Database): Promise<string> {
  const r = await db.prepare(`SELECT ${CLOSED_THROUGH_SQL} AS day`).first<{ day: string }>();
  return r?.day ?? '';
}

export const dayIsClosed = async (db: D1Database, day: string) => {
  const through = await closedThrough(db);
  return Boolean(through) && day <= through;
};

export type PeriodClose = { id: string; throughDay: string; note: string; closedBy: string; closedAt: string; reopenedBy: string | null; reopenedAt: string | null; reopenReason: string | null };

export async function listCloses(db: D1Database, limit = 24): Promise<PeriodClose[]> {
  const { results } = await db
    .prepare(
      `SELECT id, through_day AS throughDay, note, closed_by AS closedBy, closed_at AS closedAt, reopened_by AS reopenedBy, reopened_at AS reopenedAt, reopen_reason AS reopenReason
       FROM acc_period_closes ORDER BY closed_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<PeriodClose>();
  return results;
}

/** Closes the books through a past day. Today stays open, so daily work never stops. */
export async function closePeriod(db: D1Database, actor: string, through: string, today: string, note: string): Promise<Result<string>> {
  if (!isYmd(through) || through >= today) return { ok: false, error: 'day' };
  const current = await closedThrough(db);
  if (current && through <= current) return { ok: false, error: 'already' };
  const waiting = await db.prepare(`SELECT count(*) AS n FROM expenses WHERE status = 'pending' AND voided_at IS NULL AND spent_on <= ?`).bind(through).first<{ n: number }>();
  if (waiting?.n) return { ok: false, error: 'pending' };
  const id = newId('pcl');
  await db.prepare('INSERT INTO acc_period_closes (id, through_day, note, closed_by) VALUES (?, ?, ?, ?)').bind(id, through, note.trim().slice(0, 300), actor).run();
  await log(db, actor, 'accounts.period.close', `period:${through}`, { note: note.trim().slice(0, 300) });
  return { ok: true, value: id };
}

/** Reopens the latest close. Owners only (checked by the page), with a reason. */
export async function reopenPeriod(db: D1Database, actor: string, reason: string): Promise<Result<string>> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 3) return { ok: false, error: 'reason' };
  const r = await db
    .prepare(
      `UPDATE acc_period_closes SET reopened_by = ?, reopened_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), reopen_reason = ?
       WHERE id = (SELECT id FROM acc_period_closes WHERE reopened_at IS NULL ORDER BY through_day DESC LIMIT 1) RETURNING through_day AS day`,
    )
    .bind(actor, why)
    .first<{ day: string }>();
  if (!r) return { ok: false, error: 'none' };
  await log(db, actor, 'accounts.period.reopen', `period:${r.day}`, { reason: why });
  return { ok: true, value: r.day };
}
