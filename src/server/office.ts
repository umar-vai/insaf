import { CLOSED_THROUGH_SQL, dayIsClosed, PeriodClosedError } from './acc-period';
import { log } from './admin';
import { DOC_TYPES, storeUpload } from './files';
import { isGmailish } from './offline';
import { ATTENDANCE, isTime, isYmd, parseDays, parseTaka, PAY_METHODS, weekday, type AttendanceStatus } from '../lib/offline';

// The office side of offline courses: teachers, batches and their weekly
// routine, attendance, the institute's expenses, notices, and the income
// and expense figures the owner looks at. Every change goes to admin_events.

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const text = (form: FormData, k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
const longText = (form: FormData, k: string, max = 2000) => String(form.get(k) ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
const PHONE = /^\+?[0-9০-৯ -]{6,20}$/;
const cleanPhone = (s: string) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[\s-]/g, '');

// ---- Teachers ---------------------------------------------------------------

export type Teacher = {
  id: string;
  name: string;
  phone: string;
  email: string;
  subject: string;
  basicPayMinor: number;
  joinedOn: string;
  /** teacher: teaches batches. staff: office staff, on the payroll only. */
  role: 'teacher' | 'staff';
  status: 'active' | 'inactive';
  note: string;
  createdAt: string;
  batches?: number;
  students?: number;
};
type TeacherInput = Omit<Teacher, 'id' | 'createdAt' | 'batches' | 'students' | 'role'> & { role?: Teacher['role'] };

export function parseTeacherForm(form: FormData): Result<TeacherInput> {
  const name = text(form, 'name');
  if (name.length < 2) return { ok: false, error: 'name' };
  const phone = text(form, 'phone', 30);
  if (!PHONE.test(phone)) return { ok: false, error: 'phone' };
  const email = text(form, 'email', 254).toLowerCase();
  if (email && !isGmailish(email)) return { ok: false, error: 'email' };
  const pay = text(form, 'basicPay') === '' ? 0 : parseTaka(form.get('basicPay'));
  if (pay === null || pay > 10_000_000) return { ok: false, error: 'basicPay' };
  const joinedOn = text(form, 'joinedOn', 10);
  if (joinedOn && !isYmd(joinedOn)) return { ok: false, error: 'joinedOn' };
  return {
    ok: true,
    value: {
      name,
      phone: cleanPhone(phone),
      email,
      subject: text(form, 'subject', 120),
      basicPayMinor: pay * 100,
      joinedOn,
      role: text(form, 'role') === 'staff' ? 'staff' : 'teacher',
      status: text(form, 'status') === 'inactive' ? 'inactive' : 'active',
      note: longText(form, 'note'),
    },
  };
}

/** SQL: batch b is taught by teacher <id> (its main teacher or a subject teacher). */
export const teaches = (id: string) => `(b.teacher_id = ${id} OR EXISTS (SELECT 1 FROM batch_teachers bt WHERE bt.batch_id = b.id AND bt.teacher_id = ${id}))`;

const TEACHER_SELECT = `SELECT t.id, t.name, t.phone, t.email, t.subject, t.basic_pay_minor AS basicPayMinor, t.joined_on AS joinedOn, t.role, t.status, t.note,
  t.created_at AS createdAt,
  (SELECT count(*) FROM offline_batches b WHERE ${teaches('t.id')} AND b.status = 'active') AS batches,
  (SELECT count(*) FROM offline_enrollments e JOIN offline_batches b ON b.id = e.batch_id WHERE ${teaches('t.id')} AND b.status = 'active' AND e.status = 'active') AS students
  FROM teachers t`;

export async function listTeachers(db: D1Database, activeOnly = false): Promise<Teacher[]> {
  const { results } = await db.prepare(`${TEACHER_SELECT} ${activeOnly ? "WHERE t.status = 'active'" : ''} ORDER BY t.status, t.name`).all<Teacher>();
  return results;
}

export const getTeacher = (db: D1Database, id: string) => db.prepare(`${TEACHER_SELECT} WHERE t.id = ?`).bind(id).first<Teacher>();

export async function saveTeacher(db: D1Database, actor: string, id: string | null, v: TeacherInput): Promise<string | null> {
  if (id) {
    const r = await db
      .prepare('UPDATE teachers SET name = ?, phone = ?, email = ?, subject = ?, basic_pay_minor = ?, joined_on = ?, role = ?, status = ?, note = ? WHERE id = ?')
      .bind(v.name, v.phone, v.email, v.subject, v.basicPayMinor, v.joinedOn, v.role ?? 'teacher', v.status, v.note, id)
      .run();
    if (!r.meta.changes) return null;
    await log(db, actor, 'teacher.update', `teacher:${id}`, { name: v.name, status: v.status, pay: v.basicPayMinor / 100 });
    return id;
  }
  const nid = newId('tch');
  await db
    .prepare('INSERT INTO teachers (id, name, phone, email, subject, basic_pay_minor, joined_on, role, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(nid, v.name, v.phone, v.email, v.subject, v.basicPayMinor, v.joinedOn, v.role ?? 'teacher', v.status, v.note)
    .run();
  await log(db, actor, 'teacher.create', `teacher:${nid}`, { name: v.name });
  return nid;
}

// ---- Batches and routine ------------------------------------------------------

export type Batch = {
  id: string;
  courseId: string;
  courseTitle: string;
  name: string;
  kind: string;
  days: string;
  startTime: string;
  endTime: string;
  teacherId: string | null;
  teacherName: string | null;
  teacherPhone: string | null;
  room: string;
  startDate: string;
  status: 'active' | 'archived';
  note: string;
  students: number;
};
type BatchInput = Omit<Batch, 'id' | 'courseTitle' | 'teacherName' | 'teacherPhone' | 'students'>;

export function parseBatchForm(form: FormData): Result<BatchInput> {
  const courseId = text(form, 'courseId', 40);
  if (!courseId) return { ok: false, error: 'course' };
  const name = text(form, 'name', 80);
  if (name.length < 1) return { ok: false, error: 'name' };
  const days = parseDays(form.getAll('days').map(String).join(','));
  const startTime = text(form, 'startTime', 5);
  const endTime = text(form, 'endTime', 5);
  if ((startTime && !isTime(startTime)) || (endTime && !isTime(endTime))) return { ok: false, error: 'time' };
  if (startTime && endTime && endTime <= startTime) return { ok: false, error: 'time' };
  const startDate = text(form, 'startDate', 10);
  if (startDate && !isYmd(startDate)) return { ok: false, error: 'startDate' };
  return {
    ok: true,
    value: {
      courseId,
      name,
      kind: text(form, 'kind', 60),
      days: days.join(','),
      startTime,
      endTime,
      teacherId: text(form, 'teacherId', 40) || null,
      room: text(form, 'room', 60),
      startDate,
      status: text(form, 'status') === 'archived' ? 'archived' : 'active',
      note: longText(form, 'note', 1000),
    },
  };
}

const BATCH_SELECT = `SELECT b.id, b.course_id AS courseId, c.title AS courseTitle, b.name, b.kind, b.days, b.start_time AS startTime, b.end_time AS endTime,
  b.teacher_id AS teacherId, t.name AS teacherName, t.phone AS teacherPhone, b.room, b.start_date AS startDate, b.status, b.note,
  (SELECT count(*) FROM offline_enrollments e WHERE e.status='active' AND
     coalesce((SELECT p.to_batch_id FROM academic_promotions p JOIN academic_sessions ses
       ON ses.id=p.to_session_id AND ses.status='active' WHERE p.enrollment_id=e.id LIMIT 1), e.batch_id)=b.id
   ) AS students
  FROM offline_batches b JOIN offline_courses c ON c.id = b.course_id LEFT JOIN teachers t ON t.id = b.teacher_id`;

export async function listBatches(db: D1Database, opts: { activeOnly?: boolean; teacherId?: string } = {}): Promise<Batch[]> {
  const where = [opts.activeOnly ? "b.status = 'active'" : '', opts.teacherId ? teaches('?1') : ''].filter(Boolean);
  const { results } = await db
    .prepare(`${BATCH_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.status, c.title, b.start_time, b.name`)
    .bind(...(opts.teacherId ? [opts.teacherId] : []))
    .all<Batch>();
  return results;
}

export const getBatch = (db: D1Database, id: string) => db.prepare(`${BATCH_SELECT} WHERE b.id = ?`).bind(id).first<Batch>();

export async function saveBatch(db: D1Database, actor: string, id: string | null, v: BatchInput): Promise<string | null> {
  const ok = await db.prepare('SELECT 1 AS ok FROM offline_courses WHERE id = ?').bind(v.courseId).first();
  if (!ok) return null;
  if (v.teacherId && !(await db.prepare('SELECT 1 AS ok FROM teachers WHERE id = ?').bind(v.teacherId).first())) return null;
  if (id) {
    // A batch with students cannot move to another course; their fees belong to this one.
    const before = await db.prepare('SELECT course_id AS courseId FROM offline_batches WHERE id = ?').bind(id).first<{ courseId: string }>();
    if (!before) return null;
    if (before.courseId !== v.courseId) {
      const has = await db.prepare('SELECT 1 AS ok FROM offline_enrollments WHERE batch_id = ? LIMIT 1').bind(id).first();
      if (has) return null;
    }
    await db
      .prepare(
        `UPDATE offline_batches SET course_id = ?, name = ?, kind = ?, days = ?, start_time = ?, end_time = ?, teacher_id = ?, room = ?, start_date = ?, status = ?, note = ?
         WHERE id = ?`,
      )
      .bind(v.courseId, v.name, v.kind, v.days, v.startTime, v.endTime, v.teacherId, v.room, v.startDate, v.status, v.note, id)
      .run();
    await log(db, actor, 'batch.update', `batch:${id}`, { name: v.name, teacherId: v.teacherId, days: v.days, status: v.status });
    return id;
  }
  const nid = newId('bat');
  await db
    .prepare(
      `INSERT INTO offline_batches (id, course_id, name, kind, days, start_time, end_time, teacher_id, room, start_date, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(nid, v.courseId, v.name, v.kind, v.days, v.startTime, v.endTime, v.teacherId, v.room, v.startDate, v.status, v.note)
    .run();
  await log(db, actor, 'batch.create', `batch:${nid}`, { name: v.name, courseId: v.courseId });
  return nid;
}

/** Active batches that meet on this date, by start time. */
export async function classesOn(db: D1Database, ymd: string): Promise<(Batch & { marked: number })[]> {
  const day = weekday(ymd);
  const { results } = await db
    .prepare(
      `${BATCH_SELECT.replace(
        ' FROM offline_batches b',
        ', (SELECT count(*) FROM offline_attendance a WHERE a.batch_id = b.id AND a.day = ?1) AS marked FROM offline_batches b',
      )} WHERE b.status = 'active' AND (',' || b.days || ',') LIKE ?2 ORDER BY b.start_time, b.name`,
    )
    .bind(ymd, `%,${day},%`)
    .all<Batch & { marked: number }>();
  return results;
}

// ---- Attendance ---------------------------------------------------------------

export type RosterRow = { enrollmentId: string; studentId: string; studentNo: number | null; name: string; phone: string; roll: string; status: AttendanceStatus | null };

/** Students of a batch with what was marked for them on that day. */
export async function roster(db: D1Database, batchId: string, ymd: string): Promise<RosterRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS enrollmentId, s.id AS studentId, s.student_no AS studentNo, s.name, s.phone,
          coalesce(nullif(p.next_roll,''),e.roll) AS roll, a.status
        FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
        LEFT JOIN academic_promotions p ON p.enrollment_id=e.id AND p.to_session_id=
            (SELECT id FROM academic_sessions WHERE status='active' LIMIT 1)
        LEFT JOIN offline_attendance a ON a.enrollment_id=e.id AND a.day=?2 AND a.batch_id=?1
        WHERE (coalesce(p.to_batch_id,e.batch_id)=?1 AND e.status='active') OR a.id IS NOT NULL
        ORDER BY CASE WHEN coalesce(nullif(p.next_roll,''),e.roll) GLOB '[0-9]*'
          THEN CAST(coalesce(nullif(p.next_roll,''),e.roll) AS INTEGER) ELSE 99999 END,
          coalesce(nullif(p.next_roll,''),e.roll), s.name`,
    )
    .bind(batchId, ymd)
    .all<RosterRow>();
  return results;
}

/** Saves the day's attendance for a batch. Unknown students are ignored. */
export async function saveAttendance(
  db: D1Database,
  actor: string,
  batchId: string,
  ymd: string,
  marks: Record<string, string>,
  today: string,
): Promise<number> {
  if (!isYmd(ymd) || ymd > today) return 0;
  const allowed = new Set((await roster(db, batchId, ymd)).map((r) => r.enrollmentId));
  const rows = Object.entries(marks).filter(([id, st]) => allowed.has(id) && (ATTENDANCE as readonly string[]).includes(st));
  if (!rows.length) return 0;
  await db.batch(
    rows.map(([enrollmentId, status]) =>
      db
        .prepare(
          `INSERT INTO offline_attendance (id, batch_id, enrollment_id, day, status, marked_by) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (enrollment_id, day) DO UPDATE SET status = excluded.status, batch_id = excluded.batch_id, marked_by = excluded.marked_by,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(newId('att'), batchId, enrollmentId, ymd, status, actor),
    ),
  );
  const present = rows.filter(([, s]) => s === 'present' || s === 'late').length;
  await log(db, actor, 'attendance.save', `batch:${batchId}`, { day: ymd, marked: rows.length, present });
  return rows.length;
}

export type AttendanceSummary = { enrollmentId: string; studentId: string; name: string; roll: string; present: number; late: number; absent: number; leave: number; days: number };

/** Per student counts for a batch in one month ("2026-11"). */
export async function attendanceMonth(db: D1Database, batchId: string, month: string): Promise<{ days: string[]; rows: AttendanceSummary[] }> {
  const [dayRows, rows] = await db.batch([
    db.prepare('SELECT DISTINCT day FROM offline_attendance WHERE batch_id = ? AND day LIKE ? ORDER BY day').bind(batchId, `${month}-%`),
    db
      .prepare(
        `SELECT e.id AS enrollmentId, s.id AS studentId, s.name, coalesce(nullif(p.next_roll,''),e.roll) AS roll,
           sum(a.status = 'present') AS present, sum(a.status = 'late') AS late, sum(a.status = 'absent') AS absent, sum(a.status = 'leave') AS leave,
           count(a.id) AS days
         FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
         LEFT JOIN academic_promotions p ON p.enrollment_id=e.id AND p.to_session_id =
           (SELECT id FROM academic_sessions WHERE status='active' LIMIT 1)
         LEFT JOIN offline_attendance a ON a.enrollment_id = e.id AND a.batch_id = ?1 AND a.day LIKE ?2
         WHERE coalesce(p.to_batch_id,e.batch_id)=?1 OR a.id IS NOT NULL
         GROUP BY e.id ORDER BY CASE WHEN coalesce(nullif(p.next_roll,''),e.roll) GLOB '[0-9]*'
           THEN CAST(coalesce(nullif(p.next_roll,''),e.roll) AS INTEGER) ELSE 99999 END, s.name`,
      )
      .bind(batchId, `${month}-%`),
  ]);
  return {
    days: (dayRows!.results as { day: string }[]).map((d) => d.day),
    rows: (rows!.results as AttendanceSummary[]).map((r) => ({ ...r, present: r.present ?? 0, late: r.late ?? 0, absent: r.absent ?? 0, leave: r.leave ?? 0 })),
  };
}

/** One student's attendance across batches, newest first. */
export async function studentAttendance(db: D1Database, studentId: string, limit = 60) {
  const { results } = await db
    .prepare(
      `SELECT a.day, a.status, b.name AS batchName FROM offline_attendance a JOIN offline_enrollments e ON e.id = a.enrollment_id
       JOIN offline_batches b ON b.id = a.batch_id WHERE e.student_id = ? ORDER BY a.day DESC LIMIT ?`,
    )
    .bind(studentId, limit)
    .all<{ day: string; status: AttendanceStatus; batchName: string }>();
  return results;
}

// ---- Expenses -------------------------------------------------------------------

export type Expense = {
  id: string;
  spentOn: string;
  category: string;
  amountMinor: number;
  description: string;
  method: string;
  voucherKey: string | null;
  recordedBy: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  status: 'approved' | 'pending' | 'rejected';
  decidedBy: string | null;
  /** DV number (0004); null for payroll expenses and ones saved before vouchers had numbers. */
  voucherNo: number | null;
  projectId: string | null;
  projectName: string | null;
  fundId: string | null;
  fundName: string | null;
  party: string;
  /** First step of a two step approval. */
  checkedBy: string | null;
  createdAt: string;
};
/** Counts in the accounts: approved and not voided. */
export const counts = (e: Pick<Expense, 'voidedAt' | 'status'>) => !e.voidedAt && e.status === 'approved';
type ExpenseInput = { spentOn: string; category: string; amountTaka: number; description: string; method: string; nonce: string | null; projectId?: string | null; fundId?: string | null; party?: string };

export function parseExpenseForm(form: FormData, today: string): Result<ExpenseInput> {
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 100_000_000) return { ok: false, error: 'amount' };
  const spentOn = text(form, 'spentOn', 10) || today;
  if (!isYmd(spentOn) || spentOn > today) return { ok: false, error: 'spentOn' };
  const category = text(form, 'category', 60);
  if (category.length < 2) return { ok: false, error: 'category' };
  const method = text(form, 'method');
  const nonce = text(form, 'nonce', 40);
  return {
    ok: true,
    value: {
      spentOn,
      category,
      amountTaka: amount,
      description: longText(form, 'description', 500),
      method: (PAY_METHODS as readonly string[]).includes(method) ? method : 'cash',
      nonce: /^[0-9a-f-]{36}$/.test(nonce) ? nonce : null,
      projectId: text(form, 'projectId', 40) || null,
      fundId: text(form, 'fundId', 40) || null,
      party: text(form, 'party', 120),
    },
  };
}

/**
 * Saves an expense with the next debit voucher number. With needsApproval
 * (true or 'pending') it waits and does not count in the accounts until
 * approved; 'checked' means the first of two approval steps is already given
 * by the person recording it (see newExpenseStage in accounts.ts).
 */
export async function recordExpense(db: D1Database, actor: string, v: ExpenseInput, voucherKey: string | null, needsApproval: boolean | 'pending' | 'checked' = false): Promise<string> {
  const seen = async () => (v.nonce ? await db.prepare('SELECT id FROM expenses WHERE nonce = ?').bind(v.nonce).first<{ id: string }>() : null);
  const before = await seen();
  if (before) return before.id;
  if (await dayIsClosed(db, v.spentOn)) throw new PeriodClosedError(v.spentOn);
  const waits = needsApproval !== false;
  const checked = needsApproval === 'checked';
  const id = newId('exp');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO expenses (id, spent_on, category, amount_minor, description, method, voucher_key, recorded_by, nonce, status, voucher_no, project_id, fund_id, party, checked_by, checked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, (SELECT coalesce(max(voucher_no), 0) + 1 FROM expenses), (SELECT id FROM acc_projects WHERE id = ?11),
                   (SELECT id FROM acc_funds WHERE id = ?12), ?13, ?14, CASE WHEN ?14 IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END)`,
        )
        .bind(id, v.spentOn, v.category, v.amountTaka * 100, v.description, v.method, voucherKey, actor, v.nonce, waits ? 'pending' : 'approved', v.projectId ?? '', v.fundId ?? '', v.party ?? '', checked ? actor : null)
        .run();
      break;
    } catch (e) {
      const again = await seen();
      if (again) return again.id;
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  await log(db, actor, 'expense.create', `expense:${id}`, { amount: v.amountTaka, category: v.category, day: v.spentOn, pending: waits, checked });
  return id;
}

export async function voidExpense(db: D1Database, actor: string, id: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE expenses SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL AND spent_on > ${CLOSED_THROUGH_SQL}
       RETURNING amount_minor AS amount`,
    )
    .bind(actor, why, id)
    .first<{ amount: number }>();
  if (!r) return false;
  await log(db, actor, 'expense.void', `expense:${id}`, { amount: r.amount / 100, reason: why });
  return true;
}

const EXPENSE_SELECT = `SELECT x.id, x.spent_on AS spentOn, x.category, x.amount_minor AS amountMinor, x.description, x.method, x.voucher_key AS voucherKey,
  x.recorded_by AS recordedBy, x.voided_at AS voidedAt, x.voided_by AS voidedBy, x.void_reason AS voidReason, x.status, x.decided_by AS decidedBy,
  x.voucher_no AS voucherNo, x.project_id AS projectId, p.name AS projectName, x.fund_id AS fundId, f.name AS fundName, x.party, x.checked_by AS checkedBy,
  x.created_at AS createdAt FROM expenses x LEFT JOIN acc_projects p ON p.id = x.project_id LEFT JOIN acc_funds f ON f.id = x.fund_id`;

export type DecideResult = 'approved' | 'rejected' | 'checked' | 'missing' | 'self' | 'owner' | 'forbidden' | 'closed';

/**
 * Approves or turns down an expense that waits. Two steps above the owner's
 * limit (ownerOverTaka > 0): someone with full accounts power checks it
 * first, then an owner approves. Nobody but an owner decides their own
 * expense. Owners may give both steps at once.
 */
export async function decideExpense(
  db: D1Database,
  actor: string,
  id: string,
  decision: 'approved' | 'rejected',
  who: { owner: boolean; full: boolean } = { owner: true, full: true },
  ownerOverTaka = 0,
): Promise<DecideResult> {
  const e = await getExpense(db, id);
  if (!e || e.status !== 'pending' || e.voidedAt) return 'missing';
  if (!who.owner && !who.full) return 'forbidden';
  if (!who.owner && e.recordedBy === actor) return 'self';
  if (await dayIsClosed(db, e.spentOn)) return 'closed';
  const needsOwner = ownerOverTaka > 0 && e.amountMinor > ownerOverTaka * 100;
  if (decision === 'approved' && needsOwner && !who.owner) {
    if (e.checkedBy) return 'owner';
    const r = await db
      .prepare(`UPDATE expenses SET checked_by = ?, checked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'pending' AND checked_by IS NULL AND voided_at IS NULL`)
      .bind(actor, id)
      .run();
    if (!r.meta.changes) return 'missing';
    await log(db, actor, 'expense.checked', `expense:${id}`, { amount: e.amountMinor / 100 });
    return 'checked';
  }
  const r = await db
    .prepare(
      `UPDATE expenses SET status = ?, decided_by = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       checked_by = coalesce(checked_by, ?), checked_at = coalesce(checked_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       WHERE id = ? AND status = 'pending' AND voided_at IS NULL RETURNING amount_minor AS amount`,
    )
    .bind(decision, actor, actor, id)
    .first<{ amount: number }>();
  if (!r) return 'missing';
  await log(db, actor, `expense.${decision}`, `expense:${id}`, { amount: r.amount / 100 });
  return decision;
}

export async function pendingExpenses(db: D1Database): Promise<Expense[]> {
  const { results } = await db.prepare(`${EXPENSE_SELECT} WHERE x.status = 'pending' AND x.voided_at IS NULL ORDER BY x.spent_on`).all<Expense>();
  return results;
}

export const getExpense = (db: D1Database, id: string) => db.prepare(`${EXPENSE_SELECT} WHERE x.id = ?`).bind(id).first<Expense>();

/** Expenses between two dates (inclusive), newest first, with totals by category. */
export async function expensesBetween(db: D1Database, from: string, to: string) {
  const { results } = await db.prepare(`${EXPENSE_SELECT} WHERE x.spent_on BETWEEN ? AND ? ORDER BY x.spent_on DESC, x.created_at DESC`).bind(from, to).all<Expense>();
  const valid = results.filter(counts);
  const byCategory = new Map<string, number>();
  for (const e of valid) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amountMinor);
  return {
    expenses: results,
    totalMinor: valid.reduce((a, e) => a + e.amountMinor, 0),
    byCategory: [...byCategory.entries()].map(([label, totalMinor]) => ({ label, totalMinor })).sort((a, b) => b.totalMinor - a.totalMinor),
  };
}

/** Names used before, so the same head is not spelled two ways. */
export async function usedCategories(db: D1Database): Promise<string[]> {
  const { results } = await db.prepare('SELECT category FROM expenses GROUP BY category ORDER BY count(*) DESC LIMIT 40').all<{ category: string }>();
  return results.map((r) => r.category);
}

// ---- Notices ----------------------------------------------------------------------

export const ONLINE_AUDIENCES = ['online', 'course'] as const;
export const OFFLINE_AUDIENCES = ['offline', 'offline_students', 'offline_teachers', 'batch', 'offline_student', 'teacher'] as const;
/** Audiences that name one course, batch, student or teacher in target_id. */
export const TARGETED: readonly Audience[] = ['course', 'batch', 'offline_student', 'teacher'];
export type Audience = (typeof ONLINE_AUDIENCES)[number] | (typeof OFFLINE_AUDIENCES)[number];
export const AUDIENCE_BN: Record<Audience, string> = {
  online: 'সব অনলাইন ছাত্র',
  course: 'একটি অনলাইন কোর্সের ছাত্র',
  offline: 'সবাই (ছাত্র ও শিক্ষক)',
  offline_students: 'সব ছাত্র',
  offline_teachers: 'সব শিক্ষক',
  batch: 'একটি ব্যাচ',
  offline_student: 'একজন ছাত্র',
  teacher: 'একজন শিক্ষক',
};

export type Notice = {
  id: string;
  title: string;
  body: string;
  audience: Audience;
  targetId: string;
  targetName: string | null;
  pinned: number;
  /** Name of the attached file, if any (downloaded through /api/notice-file/<id>). */
  fileName: string | null;
  status: 'published' | 'hidden';
  createdBy: string;
  createdAt: string;
};
type NoticeInput = { title: string; body: string; audience: Audience; targetId: string; pinned: boolean };

export function parseNoticeForm(form: FormData, allowed: readonly Audience[]): Result<NoticeInput> {
  const title = text(form, 'title', 160);
  if (title.length < 2) return { ok: false, error: 'title' };
  const audience = text(form, 'audience') as Audience;
  if (!allowed.includes(audience)) return { ok: false, error: 'audience' };
  const targeted = TARGETED.includes(audience);
  const targetId = targeted ? text(form, `target_${audience}`, 40) || text(form, 'targetId', 40) : '';
  if (targeted && !targetId) return { ok: false, error: 'target' };
  return { ok: true, value: { title, body: longText(form, 'body', 5000), audience, targetId, pinned: form.get('pinned') === 'on' } };
}

const TARGET_TABLE: Partial<Record<Audience, string>> = { batch: 'offline_batches', offline_student: 'offline_students', teacher: 'teachers' };

/**
 * Publishes a notice. An attached file (PDF, picture or office document, up
 * to 10 MB) goes to R2 under private/notices/ and is served only to the
 * people the notice is for. Returns null when the target does not exist or
 * the file is refused ('file_type', 'file_size' in error).
 */
export async function createNotice(
  db: D1Database,
  actor: string,
  v: NoticeInput,
  attach?: { bucket: R2Bucket; file: unknown },
): Promise<string | null> {
  const table = TARGET_TABLE[v.audience];
  if (v.audience === 'course') return null;
  if (table && !(await db.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?`).bind(v.targetId).first())) return null;
  let stored: { key: string; fileName: string; contentType: string } | null = null;
  if (attach && attach.file instanceof File && attach.file.size > 0) {
    const r = await storeUpload(attach.bucket, attach.file, 'private/notices', DOC_TYPES, 10 * 1024 * 1024);
    if (!r.ok) return null;
    stored = r.file;
  }
  const id = newId('ntc');
  await db
    .prepare('INSERT INTO notices (id, title, body, audience, target_id, pinned, file_key, file_name, content_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.title, v.body, v.audience, v.targetId, v.pinned ? 1 : 0, stored?.key ?? null, stored?.fileName ?? null, stored?.contentType ?? null, actor)
    .run();
  await log(db, actor, 'notice.create', `notice:${id}`, { title: v.title, audience: v.audience, file: stored?.fileName ?? null });
  return id;
}

/**
 * The attached file of a notice, if the asker may see the notice: staff of
 * that part, or the people it is for (only while it is published).
 */
export async function noticeFile(
  db: D1Database,
  id: string,
  who: { onlineStaff: boolean; offlineStaff: boolean; email: string | null; studentId: string | null },
): Promise<{ fileKey: string; fileName: string } | null> {
  const n = await db
    .prepare('SELECT audience, target_id AS targetId, status, file_key AS fileKey, file_name AS fileName FROM notices WHERE id = ?')
    .bind(id)
    .first<{ audience: Audience; targetId: string; status: string; fileKey: string | null; fileName: string | null }>();
  if (!n?.fileKey) return null;
  const file = { fileKey: n.fileKey, fileName: n.fileName ?? 'file' };
  const online = (ONLINE_AUDIENCES as readonly string[]).includes(n.audience);
  if (online ? who.onlineStaff : who.offlineStaff) return file;
  if (n.status !== 'published') return null;
  const one = async (sql: string, ...args: unknown[]) => Boolean(await db.prepare(sql).bind(...args).first());
  const email = who.email ?? '';
  const activeTeacher = `SELECT 1 FROM teachers t WHERE lower(t.email) = lower(?1) AND t.status = 'active'`;
  const activeStudent = `SELECT 1 FROM offline_students s JOIN offline_enrollments e ON e.student_id = s.id
    WHERE lower(s.email) = lower(?1) AND s.status = 'active' AND e.status = 'active'`;
  let ok = false;
  switch (n.audience) {
    case 'online':
      ok = Boolean(who.studentId);
      break;
    case 'course':
      ok = false;
      break;
    case 'offline':
      ok = Boolean(email) && ((await one(activeTeacher, email)) || (await one(activeStudent, email)));
      break;
    case 'offline_students':
      ok = Boolean(email) && (await one(activeStudent, email));
      break;
    case 'offline_teachers':
      ok = Boolean(email) && (await one(activeTeacher, email));
      break;
    case 'batch':
      ok =
        Boolean(email) &&
        ((await one(`SELECT 1 FROM offline_batches b JOIN teachers t ON ${teaches('t.id')} WHERE b.id = ?2 AND lower(t.email) = lower(?1) AND t.status = 'active'`, email, n.targetId)) ||
          (await one(`${activeStudent} AND e.batch_id = ?2`, email, n.targetId)));
      break;
    case 'offline_student':
      ok = Boolean(email) && (await one(`SELECT 1 FROM offline_students WHERE id = ?2 AND lower(email) = lower(?1) AND status = 'active'`, email, n.targetId));
      break;
    case 'teacher':
      ok = Boolean(email) && (await one(`SELECT 1 FROM teachers WHERE id = ?2 AND lower(email) = lower(?1) AND status = 'active'`, email, n.targetId));
      break;
  }
  return ok ? file : null;
}

/** Shows or hides a notice, only within the given audiences (the staff member's part). */
export async function setNoticeStatus(db: D1Database, actor: string, id: string, status: 'published' | 'hidden', allowed: readonly Audience[]): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE notices SET status = ? WHERE id = ? AND audience IN (${allowed.map(() => '?').join(',')})`)
    .bind(status, id, ...allowed)
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, `notice.${status}`, `notice:${id}`, {});
  return true;
}

export const NOTICE_SELECT = `SELECT n.id, n.title, n.body, n.audience, n.target_id AS targetId, coalesce(b.name, os.name, tt.name) AS targetName, n.pinned,
  n.file_name AS fileName, n.status, n.created_by AS createdBy, n.created_at AS createdAt
  FROM notices n LEFT JOIN offline_batches b ON n.audience = 'batch' AND b.id = n.target_id
  LEFT JOIN offline_students os ON n.audience = 'offline_student' AND os.id = n.target_id LEFT JOIN teachers tt ON n.audience = 'teacher' AND tt.id = n.target_id`;

export async function listNotices(db: D1Database, audiences: readonly Audience[], limit = 100): Promise<Notice[]> {
  const { results } = await db
    .prepare(`${NOTICE_SELECT} WHERE n.audience IN (${audiences.map(() => '?').join(',')}) ORDER BY n.created_at DESC LIMIT ?`)
    .bind(...audiences, limit)
    .all<Notice>();
  return results;
}

/** Published notices a website student should see: for everyone, or for a course they are in. */
export async function noticesForStudent(db: D1Database, studentId: string, limit = 5): Promise<Notice[]> {
  const { results } = await db
    .prepare(
      `${NOTICE_SELECT} WHERE n.status = 'published' AND n.audience = 'online' AND ? IS NOT NULL
       ORDER BY n.pinned DESC, n.created_at DESC LIMIT ?`,
    )
    .bind(studentId, limit)
    .all<Notice>();
  return results;
}

// ---- Money in and out ----------------------------------------------------------------

/** Donations (the "online" income here) are stored with a UTC time; Dhaka is six hours ahead. */
const ONLINE_DAY = `date(paid_at, '+6 hours')`;

export type MonthFigures = { month: string; onlineMinor: number; offlineMinor: number; expenseMinor: number };

/** Income (online, offline) and expense for each month in a range of "YYYY-MM". */
export async function monthlyFigures(db: D1Database, fromMonth: string, toMonth: string, parts: { online: boolean; offline: boolean }): Promise<MonthFigures[]> {
  const from = `${fromMonth}-01`;
  const to = `${toMonth}-31`;
  const [online, offline, spent] = await db.batch([
    db.prepare(`SELECT substr(${ONLINE_DAY}, 1, 7) AS m, sum(amount_minor) AS v FROM donations WHERE status = 'paid' AND voided_at IS NULL AND ${ONLINE_DAY} BETWEEN ? AND ? GROUP BY m`).bind(from, to),
    db.prepare(`SELECT substr(paid_on, 1, 7) AS m, sum(amount_minor) AS v FROM offline_payments WHERE voided_at IS NULL AND paid_on BETWEEN ? AND ? GROUP BY m`).bind(from, to),
    db.prepare(`SELECT substr(spent_on, 1, 7) AS m, sum(amount_minor) AS v FROM expenses WHERE voided_at IS NULL AND status = 'approved' AND spent_on BETWEEN ? AND ? GROUP BY m`).bind(from, to),
  ]);
  const map = (r: D1Result | undefined) => new Map((r!.results as { m: string; v: number }[]).map((x) => [x.m, x.v]));
  const [on, off, ex] = [map(online), map(offline), map(spent)];
  const out: MonthFigures[] = [];
  for (let m = fromMonth; m <= toMonth; ) {
    out.push({ month: m, onlineMinor: parts.online ? (on.get(m) ?? 0) : 0, offlineMinor: parts.offline ? (off.get(m) ?? 0) : 0, expenseMinor: ex.get(m) ?? 0 });
    const [y, mo] = m.split('-').map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

/** Totals between two dates: income by source and expenses by category. */
export async function profitAndLoss(db: D1Database, from: string, to: string) {
  const [online, onlineByCourse, offline, offlineByCourse] = await db.batch([
    db.prepare(`SELECT coalesce(sum(amount_minor), 0) AS v, count(*) AS n FROM donations WHERE status = 'paid' AND voided_at IS NULL AND ${ONLINE_DAY} BETWEEN ? AND ?`).bind(from, to),
    db
      .prepare(
        `SELECT f.title AS label, sum(d.amount_minor) AS totalMinor, count(*) AS count FROM donations d JOIN funds f ON f.id = d.fund_id
         WHERE d.status = 'paid' AND d.voided_at IS NULL AND date(d.paid_at, '+6 hours') BETWEEN ? AND ? GROUP BY f.id ORDER BY totalMinor DESC`,
      )
      .bind(from, to),
    db.prepare(`SELECT coalesce(sum(amount_minor), 0) AS v, count(*) AS n FROM offline_payments WHERE voided_at IS NULL AND paid_on BETWEEN ? AND ?`).bind(from, to),
    db
      .prepare(
        `SELECT c.title AS label, sum(p.amount_minor) AS totalMinor, count(*) AS count FROM offline_payments p JOIN offline_enrollments e ON e.id = p.enrollment_id
         JOIN offline_courses c ON c.id = e.course_id WHERE p.voided_at IS NULL AND p.paid_on BETWEEN ? AND ? GROUP BY c.id ORDER BY totalMinor DESC`,
      )
      .bind(from, to),
  ]);
  const one = (r: D1Result | undefined) => r!.results[0] as { v: number; n: number };
  const spent = await expensesBetween(db, from, to);
  return {
    onlineMinor: one(online).v,
    onlineCount: one(online).n,
    onlineByCourse: onlineByCourse!.results as { label: string; totalMinor: number; count: number }[],
    offlineMinor: one(offline).v,
    offlineCount: one(offline).n,
    offlineByCourse: offlineByCourse!.results as { label: string; totalMinor: number; count: number }[],
    expenseMinor: spent.totalMinor,
    expensesByCategory: spent.byCategory,
  };
}

/** Today's money for the office dashboard. */
export async function todayMoney(db: D1Database, today: string) {
  const r = await db
    .prepare(
      `SELECT (SELECT coalesce(sum(amount_minor), 0) FROM offline_payments WHERE voided_at IS NULL AND paid_on = ?1) AS collected,
              (SELECT count(*) FROM offline_payments WHERE voided_at IS NULL AND paid_on = ?1) AS payments,
              (SELECT coalesce(sum(amount_minor), 0) FROM expenses WHERE voided_at IS NULL AND status = 'approved' AND spent_on = ?1) AS spent,
              (SELECT coalesce(sum(amount_minor), 0) FROM expenses WHERE voided_at IS NULL AND status = 'approved' AND spent_on LIKE ?2) AS spentMonth,
              (SELECT count(*) FROM teachers WHERE status = 'active') AS teachers`,
    )
    .bind(today, `${today.slice(0, 7)}-%`)
    .first<{ collected: number; payments: number; spent: number; spentMonth: number; teachers: number }>();
  return r!;
}

/** Latest payments received offline, for the dashboard. */
export async function recentPayments(db: D1Database, limit = 6) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.receipt_no AS receiptNo, p.amount_minor AS amountMinor, p.paid_on AS paidOn, p.method, s.id AS studentId, s.name AS studentName, c.title AS courseTitle
       FROM offline_payments p JOIN offline_enrollments e ON e.id = p.enrollment_id JOIN offline_students s ON s.id = e.student_id
       JOIN offline_courses c ON c.id = e.course_id WHERE p.voided_at IS NULL ORDER BY p.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; receiptNo: number; amountMinor: number; paidOn: string; method: string; studentId: string; studentName: string; courseTitle: string }>();
  return results;
}
