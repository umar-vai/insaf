import { log } from './admin';
import { activeEnrollmentsFor, type EnrollmentWithLedger } from './offline';
import { notifyStudents } from './notifications';
import { longText, newId, runBatches, text, type Result } from './ops-util';
import { isYmd, parseTaka } from '../lib/offline';

// Fee bills made for many students at once (a monthly fee, a book fee, a
// hostel or exam fee): the office picks who (everyone, one department or one
// class), the amount and the due date, looks at the preview, then posts it.
// Each bill becomes an ordinary charge on the student's enrollment
// (offline_charges, kind "other", source_key "bill:<run id>"), so dues,
// fee collection, receipts, reminders and reports work as before. The unique
// (enrollment, source_key) index makes posting idempotent: a double click or
// a second run of the same bill adds nothing. A wrong run is cancelled with a
// reason (its charges are voided, never deleted).
//
// Concessions: a student may have one active percentage off bills (an
// orphan, a teacher's child...), with the reason written down. They apply
// only to these bills, never to the course fee agreed at admission (that
// has its own discount on the enrollment).

export type BillTargetKind = 'all' | 'course' | 'batch';
export type BillInput = { title: string; amountMinor: number; dueDate: string; target: { kind: BillTargetKind; id: string }; useConcessions: boolean };

export function parseBillForm(form: FormData): Result<BillInput> {
  const title = text(form, 'title', 120);
  if (title.length < 2) return { ok: false, error: 'title' };
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 10_000_000) return { ok: false, error: 'amount' };
  const dueDate = text(form, 'dueDate', 10);
  if (!isYmd(dueDate)) return { ok: false, error: 'dueDate' };
  const kind = text(form, 'targetKind') as BillTargetKind;
  if (!['all', 'course', 'batch'].includes(kind)) return { ok: false, error: 'target' };
  const id = kind === 'course' ? text(form, 'courseId', 40) : kind === 'batch' ? text(form, 'batchId', 40) : '';
  if (kind !== 'all' && !id) return { ok: false, error: 'target' };
  return { ok: true, value: { title, amountMinor: amount * 100, dueDate, target: { kind, id }, useConcessions: form.get('useConcessions') !== 'off' } };
}

/** The bill after a concession, in whole taka (rounded down). */
export const afterConcession = (amountMinor: number, percent: number) => Math.floor((amountMinor * (100 - Math.min(100, Math.max(0, percent)))) / 100 / 100) * 100;

export type BillLine = {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  studentNo: number | null;
  courseTitle: string;
  batch: string;
  percent: number;
  amountMinor: number;
  /** Why no charge is made: a 100% concession, or this bill is already on the enrollment. */
  skip: '' | 'free' | 'already';
};

async function activeConcessions(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT student_id AS studentId, percent FROM fee_concessions WHERE status = 'active'").all<{ studentId: string; percent: number }>();
  return new Map(results.map((r) => [r.studentId, r.percent]));
}

/** Who would get the bill and how much, without writing anything. */
export async function billPreview(db: D1Database, v: BillInput, today: string, runId = ''): Promise<BillLine[]> {
  const [rows, conc] = await Promise.all([activeEnrollmentsFor(db, today, v.target), v.useConcessions ? activeConcessions(db) : Promise.resolve(new Map<string, number>())]);
  const done = new Set<string>();
  if (runId) {
    const { results } = await db.prepare('SELECT enrollment_id AS id FROM offline_charges WHERE source_key = ?').bind(`bill:${runId}`).all<{ id: string }>();
    for (const r of results) done.add(r.id);
  }
  return rows.map((e) => {
    const percent = conc.get(e.studentId) ?? 0;
    const amountMinor = afterConcession(v.amountMinor, percent);
    return {
      enrollmentId: e.id,
      studentId: e.studentId,
      studentName: e.studentName,
      studentNo: e.studentNo,
      courseTitle: e.courseTitle,
      batch: e.batch,
      percent,
      amountMinor,
      skip: done.has(e.id) ? 'already' : amountMinor <= 0 ? 'free' : '',
    };
  });
}

/** A run key from the preview form: the same key posts the same run once. */
export const isRunKey = (k: string) => /^[a-z0-9]{16,32}$/.test(k);

/**
 * Posts the bill. runKey comes from the preview page, so pressing twice (or
 * resending the form) posts one run; the unique charge index guards each
 * enrollment as well.
 */
export async function postBillRun(db: D1Database, actor: string, v: BillInput, runKey: string, today: string): Promise<Result<{ runId: string; created: number; skipped: number }>> {
  if (!isRunKey(runKey)) return { ok: false, error: 'key' };
  const runId = `fbr_${runKey}`;
  const existing = await db.prepare('SELECT id, created_count AS created, skipped_count AS skipped FROM fee_bill_runs WHERE id = ?').bind(runId).first<{ id: string; created: number; skipped: number }>();
  if (existing) return { ok: true, value: { runId, created: existing.created, skipped: existing.skipped } };
  const lines = await billPreview(db, v, today);
  if (!lines.length) return { ok: false, error: 'nobody' };
  try {
    await db
      .prepare(
        `INSERT INTO fee_bill_runs (id, title, amount_minor, due_date, target_kind, target_id, use_concessions, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(runId, v.title, v.amountMinor, v.dueDate, v.target.kind, v.target.id, v.useConcessions ? 1 : 0, actor)
      .run();
  } catch {
    // Another request posted this run at the same moment.
    return { ok: true, value: { runId, created: 0, skipped: 0 } };
  }
  const billable = lines.filter((l) => !l.skip);
  const created = await runBatches(
    db,
    billable.map((l) =>
      db
        .prepare(
          `INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
           VALUES (?, ?, 'other', ?, ?, ?, ?, ?) ON CONFLICT (enrollment_id, source_key) DO NOTHING`,
        )
        .bind(newId('chg'), l.enrollmentId, v.title, l.amountMinor, v.dueDate, `bill:${runId}`, actor),
    ),
  );
  const total = await db.prepare('SELECT coalesce(sum(amount_minor), 0) AS t FROM offline_charges WHERE source_key = ? AND voided_at IS NULL').bind(`bill:${runId}`).first<{ t: number }>();
  const skipped = lines.length - created;
  await db.prepare('UPDATE fee_bill_runs SET created_count = ?, skipped_count = ?, total_minor = ? WHERE id = ?').bind(created, skipped, total?.t ?? 0, runId).run();
  await notifyStudents(db, actor, [...new Set(billable.map((l) => l.studentId))], {
    title: `নতুন ফি: ${v.title}`,
    body: 'ফি ও রসিদ পাতায় পরিমাণ ও শেষ তারিখ দেখুন।',
    link: '/account/offline/fees',
    sourceKey: `bill:${runId}`,
  });
  await log(db, actor, 'fee_bill.post', `fee_bill:${runId}`, { title: v.title, amount: v.amountMinor / 100, dueDate: v.dueDate, target: v.target, created, skipped });
  return { ok: true, value: { runId, created, skipped } };
}

/** Cancels a run: every charge it made is voided with the reason (kept on record). */
export async function cancelBillRun(db: D1Database, actor: string, runId: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE fee_bill_runs SET status = 'cancelled', cancelled_by = ?, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancel_reason = ?
       WHERE id = ? AND status = 'posted'`,
    )
    .bind(actor, why, runId)
    .run();
  if (!r.meta.changes) return false;
  const voided = await db
    .prepare(
      `UPDATE offline_charges SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ?
       WHERE source_key = ? AND voided_at IS NULL`,
    )
    .bind(actor, `বিল বাতিল: ${why}`, `bill:${runId}`)
    .run();
  await log(db, actor, 'fee_bill.cancel', `fee_bill:${runId}`, { reason: why, voided: voided.meta.changes });
  return true;
}

export type BillRun = {
  id: string;
  title: string;
  amountMinor: number;
  dueDate: string;
  targetKind: BillTargetKind;
  targetId: string;
  targetName: string;
  useConcessions: number;
  createdCount: number;
  skippedCount: number;
  totalMinor: number;
  status: 'posted' | 'cancelled';
  createdBy: string;
  createdAt: string;
  cancelReason: string | null;
};

const RUN_SELECT = `SELECT r.id, r.title, r.amount_minor AS amountMinor, r.due_date AS dueDate, r.target_kind AS targetKind, r.target_id AS targetId,
  coalesce(c.title, b.name, '') AS targetName, r.use_concessions AS useConcessions, r.created_count AS createdCount, r.skipped_count AS skippedCount,
  r.total_minor AS totalMinor, r.status, r.created_by AS createdBy, r.created_at AS createdAt, r.cancel_reason AS cancelReason
  FROM fee_bill_runs r LEFT JOIN offline_courses c ON r.target_kind = 'course' AND c.id = r.target_id
  LEFT JOIN offline_batches b ON r.target_kind = 'batch' AND b.id = r.target_id`;

export async function listBillRuns(db: D1Database, limit = 60): Promise<BillRun[]> {
  const { results } = await db.prepare(`${RUN_SELECT} ORDER BY r.created_at DESC LIMIT ?`).bind(limit).all<BillRun>();
  return results;
}

export const getBillRun = (db: D1Database, id: string) => db.prepare(`${RUN_SELECT} WHERE r.id = ?`).bind(id).first<BillRun>();

export type BillCharge = { chargeId: string; studentId: string; studentName: string; studentNo: number | null; courseTitle: string; amountMinor: number; voidedAt: string | null };

export async function billRunCharges(db: D1Database, runId: string): Promise<BillCharge[]> {
  const { results } = await db
    .prepare(
      `SELECT x.id AS chargeId, s.id AS studentId, s.name AS studentName, s.student_no AS studentNo, c.title AS courseTitle, x.amount_minor AS amountMinor, x.voided_at AS voidedAt
       FROM offline_charges x JOIN offline_enrollments e ON e.id = x.enrollment_id JOIN offline_students s ON s.id = e.student_id
       JOIN offline_courses c ON c.id = e.course_id WHERE x.source_key = ? ORDER BY s.student_no, s.name LIMIT 3000`,
    )
    .bind(`bill:${runId}`)
    .all<BillCharge>();
  return results;
}

// ---- Concessions --------------------------------------------------------------

export type Concession = { id: string; studentId: string; studentName: string; studentNo: number | null; percent: number; reason: string; status: 'active' | 'ended'; createdBy: string; createdAt: string };

export async function listConcessions(db: D1Database, activeOnly = true): Promise<Concession[]> {
  const { results } = await db
    .prepare(
      `SELECT f.id, f.student_id AS studentId, s.name AS studentName, s.student_no AS studentNo, f.percent, f.reason, f.status, f.created_by AS createdBy, f.created_at AS createdAt
       FROM fee_concessions f JOIN offline_students s ON s.id = f.student_id ${activeOnly ? "WHERE f.status = 'active'" : ''} ORDER BY s.student_no, s.name LIMIT 1000`,
    )
    .all<Concession>();
  return results;
}

export function parseConcessionForm(form: FormData): Result<{ studentId: string; percent: number; reason: string }> {
  const studentId = text(form, 'studentId', 40);
  if (!studentId) return { ok: false, error: 'student' };
  const percent = Number(String(form.get('percent') ?? '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))));
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) return { ok: false, error: 'percent' };
  const reason = longText(form, 'reason', 300);
  if (reason.length < 2) return { ok: false, error: 'reason' };
  return { ok: true, value: { studentId, percent, reason } };
}

/** Gives a student a concession, ending any earlier one (both stay on record). */
export async function setConcession(db: D1Database, actor: string, v: { studentId: string; percent: number; reason: string }): Promise<boolean> {
  const s = await db.prepare("SELECT 1 AS ok FROM offline_students WHERE id = ? AND status = 'active'").bind(v.studentId).first();
  if (!s) return false;
  const id = newId('fcn');
  await db.batch([
    db.prepare(`UPDATE fee_concessions SET status = 'ended', ended_by = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE student_id = ? AND status = 'active'`).bind(actor, v.studentId),
    db.prepare('INSERT INTO fee_concessions (id, student_id, percent, reason, created_by) VALUES (?, ?, ?, ?, ?)').bind(id, v.studentId, v.percent, v.reason, actor),
  ]);
  await log(db, actor, 'fee_concession.set', `offline_student:${v.studentId}`, { percent: v.percent, reason: v.reason });
  return true;
}

export async function endConcession(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE fee_concessions SET status = 'ended', ended_by = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'active' RETURNING student_id AS studentId`)
    .bind(actor, id)
    .first<{ studentId: string }>();
  if (!r) return false;
  await log(db, actor, 'fee_concession.end', `offline_student:${r.studentId}`, { concessionId: id });
  return true;
}

/** Due statements to print: one per student, every unpaid item of their active enrollments. */
export async function dueStatements(db: D1Database, today: string, target: { kind: BillTargetKind; id: string }, onlyDue = true) {
  const rows = await activeEnrollmentsFor(db, today, target);
  const byStudent = new Map<string, { studentId: string; studentName: string; studentNo: number | null; phone: string; enrollments: EnrollmentWithLedger[] }>();
  for (const e of rows) {
    if (onlyDue && e.ledger.dueMinor <= 0) continue;
    const s = byStudent.get(e.studentId) ?? { studentId: e.studentId, studentName: e.studentName, studentNo: e.studentNo, phone: e.studentPhone, enrollments: [] };
    s.enrollments.push(e);
    byStudent.set(e.studentId, s);
  }
  return [...byStudent.values()];
}
