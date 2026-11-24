import { log } from './admin';
import { activeEnrollmentsFor, type EnrollmentWithLedger } from './offline';
import { notifyStudents } from './notifications';
import { longText, newId, text, type Result } from './ops-util';
import { addMonths, isYmd, parseTaka, schedule } from '../lib/offline';

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
export const BILL_HEAD_BN = { tuition: 'মাসিক টিউশন', session: 'সেশন ফি', books: 'বই', other: 'অন্যান্য' } as const;
type FeeHead = keyof typeof BILL_HEAD_BN;
export type BillInput = { title: string; amountMinor: number; dueDate: string; target: { kind: BillTargetKind; id: string }; useConcessions: boolean; feeHead?: FeeHead; billingPeriod?: string };

const billingPeriodOf = (v: BillInput) => v.billingPeriod || v.dueDate.slice(0, 7);
const billHeadOf = (v: BillInput) => v.feeHead ?? 'other';
const titleKeyOf = (title: string) => title.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
// Match old runs by their title and due month. New structured heads match independently of the display name.
const sameBill = `coalesce(nullif(r.billing_period, ''), substr(r.due_date, 1, 7)) = ?1
  AND (coalesce(nullif(r.title_key, ''), lower(trim(r.title))) = ?2 OR (?3 <> 'other' AND r.fee_head = ?3))`;
const duplicateArgs = (v: BillInput) => [billingPeriodOf(v), titleKeyOf(v.title), billHeadOf(v)] as const;


export function parseBillForm(form: FormData): Result<BillInput> {
  const title = text(form, 'title', 120);
  if (title.length < 2) return { ok: false, error: 'title' };
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 10_000_000) return { ok: false, error: 'amount' };
  const dueDate = text(form, 'dueDate', 10);
  if (!isYmd(dueDate)) return { ok: false, error: 'dueDate' };
  const feeHead = (text(form, 'feeHead') || 'other') as FeeHead;
  if (!Object.hasOwn(BILL_HEAD_BN, feeHead)) return { ok: false, error: 'head' };
  const billingPeriod = text(form, 'billingPeriod', 7) || dueDate.slice(0, 7);
  if (!isYmd(`${billingPeriod}-01`)) return { ok: false, error: 'period' };
  const kind = text(form, 'targetKind') as BillTargetKind;
  if (!['all', 'course', 'batch'].includes(kind)) return { ok: false, error: 'target' };
  const id = kind === 'course' ? text(form, 'courseId', 40) : kind === 'batch' ? text(form, 'batchId', 40) : '';
  if (kind !== 'all' && !id) return { ok: false, error: 'target' };
  return { ok: true, value: { title, amountMinor: amount * 100, dueDate, feeHead, billingPeriod, target: { kind, id }, useConcessions: form.get('useConcessions') !== 'off' } };
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
  skip: '' | 'free' | 'already' | 'tuition';
};

async function activeConcessions(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT student_id AS studentId, percent FROM fee_concessions WHERE status = 'active'").all<{ studentId: string; percent: number }>();
  return new Map(results.map((r) => [r.studentId, r.percent]));
}

/** Who would get the bill and how much, without writing anything. */
export async function billPreview(db: D1Database, v: BillInput, today: string): Promise<BillLine[]> {
  const [rows, conc, duplicates] = await Promise.all([
    activeEnrollmentsFor(db, today, v.target, 3001),
    v.useConcessions ? activeConcessions(db) : Promise.resolve(new Map<string, number>()),
    db.prepare(`SELECT DISTINCT x.enrollment_id AS id FROM offline_charges x
      JOIN fee_bill_runs r ON x.source_key = 'bill:' || r.id
      WHERE x.voided_at IS NULL AND r.status = 'posted' AND ${sameBill}`)
      .bind(...duplicateArgs(v)).all<{ id: string }>(),
  ]);
  const billed = new Set(duplicates.results.map((r) => r.id));
  return rows.map((e) => {
    const percent = conc.get(e.studentId) ?? 0;
    const amountMinor = afterConcession(v.amountMinor, percent);
    const tuition = billHeadOf(v) === 'tuition' && e.feeMinor > e.discountMinor && schedule(e).some((item, i) => {
      const start = item.dueDate.slice(0, 7);
      const next = scheduleEndMonth(e, i);
      return start <= billingPeriodOf(v) && billingPeriodOf(v) < next;
    });
    return {
      enrollmentId: e.id, studentId: e.studentId, studentName: e.studentName, studentNo: e.studentNo,
      courseTitle: e.courseTitle, batch: e.batch, percent, amountMinor,
      skip: billed.has(e.id) ? 'already' : tuition ? 'tuition' : amountMinor <= 0 ? 'free' : '',
    };
  });
}

function scheduleEndMonth(e: EnrollmentWithLedger, i: number): string {
  const endOffset = e.planMonths > 0 ? Math.min((i + 1) * e.planMonths, e.durationMonths) : e.durationMonths;
  return addMonths(e.startDate, endOffset).slice(0, 7);
}

/** Stable across request retries, and changes whenever the preview amounts or roster change. */
export async function billPreviewKey(v: BillInput, lines: BillLine[]): Promise<string> {
  const snapshot = JSON.stringify([v, lines.map((l) => [l.enrollmentId, l.amountMinor, l.skip])]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return Array.from(new Uint8Array(hash).slice(0, 16), (n) => n.toString(16).padStart(2, '0')).join('');
}

/** A run key from the preview form: the same key posts the same run once. */
export const isRunKey = (k: string) => /^[a-z0-9]{16,32}$/.test(k);

/**
 * Posts the bill. runKey comes from the preview page, so pressing twice (or
 * resending the form) posts one run; the unique charge index guards each
 * enrollment as well.
 */
export async function postBillRun(db: D1Database, actor: string, v: BillInput, runKey: string, today: string, verifyPreview = false): Promise<Result<{ runId: string; created: number; skipped: number }>> {
  if (!isRunKey(runKey)) return { ok: false, error: 'key' };
  const runId = `fbr_${runKey}`;
  const totals = () => db.prepare('SELECT created_count AS created, skipped_count AS skipped FROM fee_bill_runs WHERE id = ?').bind(runId).first<{ created: number; skipped: number }>();
  const existing = await totals();
  if (existing) return { ok: true, value: { runId, ...existing } };
  const lines = await billPreview(db, v, today);
  if (!lines.length) return { ok: false, error: 'nobody' };
  if (lines.length > 3000) return { ok: false, error: 'too_many' };
  if (!lines.some((l) => !l.skip)) return { ok: false, error: 'already' };
  if (verifyPreview && await billPreviewKey(v, lines) !== runKey) return { ok: false, error: 'changed' };
  const billable = lines.filter((l) => !l.skip);
  const snapshot = JSON.stringify(billable.map((l) => [l.enrollmentId, l.amountMinor]));
  const source = `bill:${runId}`;
  const [run] = await db.batch([
    db.prepare(`INSERT INTO fee_bill_runs (id, title, amount_minor, due_date, target_kind, target_id, use_concessions, created_by, billing_period, title_key, fee_head)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .bind(runId, v.title, v.amountMinor, v.dueDate, v.target.kind, v.target.id, v.useConcessions ? 1 : 0, actor, ...duplicateArgs(v)),
    db.prepare(`INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
      SELECT 'chg_' || lower(hex(randomblob(8))), e.id, 'other', ?4, json_extract(line.value, '$[1]'), ?5, ?6, ?7
      FROM json_each(?8) line JOIN offline_enrollments e ON e.id = json_extract(line.value, '$[0]')
      JOIN offline_students s ON s.id = e.student_id
      WHERE e.status = 'active' AND s.status = 'active'
      AND EXISTS (SELECT 1 FROM fee_bill_runs WHERE id = ?9 AND status = 'posted')
      AND NOT EXISTS (SELECT 1 FROM offline_charges x JOIN fee_bill_runs r ON x.source_key = 'bill:' || r.id
        WHERE x.enrollment_id = e.id AND x.voided_at IS NULL AND r.status = 'posted' AND ${sameBill})
      ON CONFLICT (enrollment_id, source_key) DO NOTHING`)
      .bind(...duplicateArgs(v), v.title, v.dueDate, source, actor, snapshot, runId),
    db.prepare(`UPDATE fee_bill_runs SET created_count = (SELECT count(*) FROM offline_charges WHERE source_key = ?1),
      skipped_count = ?2 - (SELECT count(*) FROM offline_charges WHERE source_key = ?1),
      total_minor = (SELECT coalesce(sum(amount_minor), 0) FROM offline_charges WHERE source_key = ?1)
      WHERE id = ?3 AND status = 'posted'`).bind(source, lines.length, runId),
  ]);
  const result = (await totals())!;
  if (run?.meta.changes && result.created) {
    const charged = await db.prepare(`SELECT DISTINCT e.student_id AS id FROM offline_charges x
      JOIN offline_enrollments e ON e.id = x.enrollment_id WHERE x.source_key = ?`).bind(source).all<{ id: string }>();
    await notifyStudents(db, actor, charged.results.map((l) => l.id), {
      title: `নতুন ফি: ${v.title}`, body: 'ফি ও রসিদ পাতায় পরিমাণ ও শেষ তারিখ দেখুন।', link: '/account/offline/fees', sourceKey: source,
    });
    await log(db, actor, 'fee_bill.post', `fee_bill:${runId}`, { title: v.title, billingPeriod: billingPeriodOf(v), target: v.target, ...result });
  }
  return { ok: true, value: { runId, ...result } };
}

/** Cancels the run and its charges together. */
export async function cancelBillRun(db: D1Database, actor: string, runId: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const [run, waived] = await db.batch([
    db.prepare(`UPDATE fee_bill_runs SET status = 'cancelled', cancelled_by = ?, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancel_reason = ?
      WHERE id = ? AND status = 'posted'`).bind(actor, why, runId),
    db.prepare(`UPDATE offline_charges SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ?
      WHERE source_key = ? AND voided_at IS NULL AND EXISTS (SELECT 1 FROM fee_bill_runs WHERE id = ? AND status = 'cancelled')`)
      .bind(actor, `বিল বাতিল: ${why}`, `bill:${runId}`, runId),
  ]);
  if (!run?.meta.changes) return false;
  await log(db, actor, 'fee_bill.cancel', `fee_bill:${runId}`, { reason: why, voided: waived?.meta.changes });
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
