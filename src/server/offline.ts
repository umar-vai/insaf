import { log } from './admin';
import { bnDigits } from '../lib/format';
import { addDays, isYmd, lateInstallments, ledger, parseCharges, PAY_METHODS, PLAN_MONTHS, parseTaka, type Ledger, type PayMethod } from '../lib/offline';

// The offline course ledger: courses taught in person, the people in them,
// what each agreed to pay and every taka received. Kept apart from the
// website's students, orders and enrollments. Payments are never deleted;
// a wrong entry is voided with a reason. Every change goes to admin_events.

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const text = (form: FormData, k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
const longText = (form: FormData, k: string, max = 2000) => String(form.get(k) ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);

// ---- Courses ----------------------------------------------------------------

export type OfflineCourse = {
  id: string;
  title: string;
  feeMinor: number;
  admissionFeeMinor: number;
  durationMonths: number;
  note: string;
  status: 'active' | 'archived';
  createdAt: string;
  activeStudents?: number;
};

type CourseInput = { title: string; feeTaka: number; admissionTaka: number; durationMonths: number; note: string; status: 'active' | 'archived' };

export function parseOfflineCourseForm(form: FormData): Result<CourseInput> {
  const title = text(form, 'title');
  if (title.length < 2) return { ok: false, error: 'title' };
  const fee = parseTaka(form.get('fee'));
  if (fee === null || fee > 10_000_000) return { ok: false, error: 'fee' };
  const admission = text(form, 'admission') === '' ? 0 : parseTaka(form.get('admission'));
  if (admission === null || admission > 10_000_000) return { ok: false, error: 'admission' };
  const months = parseTaka(form.get('duration'));
  const unit = text(form, 'unit') === 'year' ? 12 : 1;
  if (months === null || months < 1 || months * unit > 120) return { ok: false, error: 'duration' };
  const status = text(form, 'status') === 'archived' ? 'archived' : 'active';
  return { ok: true, value: { title, feeTaka: fee, admissionTaka: admission, durationMonths: months * unit, note: longText(form, 'note'), status } };
}

const COURSE_SELECT = `SELECT c.id, c.title, c.fee_minor AS feeMinor, c.admission_fee_minor AS admissionFeeMinor, c.duration_months AS durationMonths,
  c.note, c.status, c.created_at AS createdAt,
  (SELECT count(*) FROM offline_enrollments e WHERE e.course_id = c.id AND e.status = 'active') AS activeStudents
  FROM offline_courses c`;

export async function listOfflineCourses(db: D1Database, includeArchived = true): Promise<OfflineCourse[]> {
  const { results } = await db
    .prepare(`${COURSE_SELECT} ${includeArchived ? '' : "WHERE c.status = 'active'"} ORDER BY c.status, c.title`)
    .all<OfflineCourse>();
  return results;
}

export const getOfflineCourse = (db: D1Database, id: string) => db.prepare(`${COURSE_SELECT} WHERE c.id = ?`).bind(id).first<OfflineCourse>();

export async function createOfflineCourse(db: D1Database, actor: string, v: CourseInput): Promise<string> {
  const id = newId('ofc');
  await db
    .prepare('INSERT INTO offline_courses (id, title, fee_minor, admission_fee_minor, duration_months, note, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.title, v.feeTaka * 100, v.admissionTaka * 100, v.durationMonths, v.note, v.status)
    .run();
  await log(db, actor, 'offline.course.create', `offline_course:${id}`, { title: v.title, fee: v.feeTaka, months: v.durationMonths });
  return id;
}

/** Changing a course's fee does not change what already enrolled students agreed. */
export async function updateOfflineCourse(db: D1Database, actor: string, id: string, v: CourseInput): Promise<boolean> {
  const r = await db
    .prepare('UPDATE offline_courses SET title = ?, fee_minor = ?, admission_fee_minor = ?, duration_months = ?, note = ?, status = ? WHERE id = ?')
    .bind(v.title, v.feeTaka * 100, v.admissionTaka * 100, v.durationMonths, v.note, v.status, id)
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'offline.course.update', `offline_course:${id}`, { title: v.title, fee: v.feeTaka, months: v.durationMonths, status: v.status });
  return true;
}

// ---- Students -------------------------------------------------------------

export type OfflineStudent = {
  id: string;
  studentNo: number | null;
  name: string;
  phone: string;
  guardianPhone: string;
  email: string;
  address: string;
  note: string;
  status: 'active' | 'blocked';
  blockedReason: string;
  createdAt: string;
};
type StudentInput = Omit<OfflineStudent, 'id' | 'createdAt' | 'studentNo' | 'status' | 'blockedReason'>;

const STUDENT_COLS = `id, student_no AS studentNo, name, phone, guardian_phone AS guardianPhone, email, address, note, status, blocked_reason AS blockedReason, created_at AS createdAt`;
export const isGmailish = (v: string) => /^[^\s@<>"',;]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/.test(v);

const PHONE = /^\+?[0-9০-৯ -]{6,20}$/;
const cleanPhone = (s: string) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[\s-]/g, '');

export function parseOfflineStudentForm(form: FormData): Result<StudentInput> {
  const name = text(form, 'name');
  if (name.length < 2) return { ok: false, error: 'name' };
  const phone = text(form, 'phone', 30);
  if (!PHONE.test(phone)) return { ok: false, error: 'phone' };
  const guardian = text(form, 'guardianPhone', 30);
  if (guardian && !PHONE.test(guardian)) return { ok: false, error: 'guardianPhone' };
  const email = text(form, 'email', 254).toLowerCase();
  if (email && !isGmailish(email)) return { ok: false, error: 'email' };
  return {
    ok: true,
    value: {
      name,
      phone: cleanPhone(phone),
      guardianPhone: guardian ? cleanPhone(guardian) : '',
      email,
      address: longText(form, 'address', 500),
      note: longText(form, 'note'),
    },
  };
}

export async function createOfflineStudent(db: D1Database, actor: string, v: StudentInput): Promise<string> {
  const id = newId('ofs');
  // The ID number is the next free one; two saves at the same moment retry.
  for (let attempt = 0; ; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO offline_students (id, student_no, name, phone, guardian_phone, email, address, note)
           VALUES (?1, (SELECT coalesce(max(student_no), 0) + 1 FROM offline_students), ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(id, v.name, v.phone, v.guardianPhone, v.email, v.address, v.note)
        .run();
      break;
    } catch (e) {
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  await log(db, actor, 'offline.student.create', `offline_student:${id}`, { name: v.name });
  return id;
}

export async function updateOfflineStudent(db: D1Database, actor: string, id: string, v: StudentInput): Promise<boolean> {
  const r = await db
    .prepare('UPDATE offline_students SET name = ?, phone = ?, guardian_phone = ?, email = ?, address = ?, note = ? WHERE id = ?')
    .bind(v.name, v.phone, v.guardianPhone, v.email, v.address, v.note, id)
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'offline.student.update', `offline_student:${id}`, { name: v.name });
  return true;
}

/**
 * Blocks or unblocks a student. A blocked student cannot open the student
 * panel; the record, fees and receipts stay as they are.
 */
export async function setStudentBlocked(db: D1Database, actor: string, id: string, blocked: boolean, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (blocked && why.length < 2) return false;
  const r = await db
    .prepare('UPDATE offline_students SET status = ?, blocked_reason = ? WHERE id = ? AND status != ?')
    .bind(blocked ? 'blocked' : 'active', blocked ? why : '', id, blocked ? 'blocked' : 'active')
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, blocked ? 'offline.student.block' : 'offline.student.unblock', `offline_student:${id}`, blocked ? { reason: why } : {});
  return true;
}

/** Other students with this phone number, to avoid entering someone twice. */
export async function studentsWithPhone(db: D1Database, phone: string, exceptId = ''): Promise<{ id: string; name: string }[]> {
  const { results } = await db
    .prepare('SELECT id, name FROM offline_students WHERE phone = ? AND id != ? LIMIT 5')
    .bind(cleanPhone(phone), exceptId)
    .all<{ id: string; name: string }>();
  return results;
}

// ---- Enrollments ----------------------------------------------------------

export type EnrollmentRow = {
  id: string;
  studentId: string;
  studentName: string;
  studentPhone: string;
  courseId: string;
  courseTitle: string;
  /** The batch's name, or the free text kept from before batches existed. */
  batch: string;
  batchId: string | null;
  roll: string;
  studentNo: number | null;
  startDate: string;
  feeMinor: number;
  admissionFeeMinor: number;
  discountMinor: number;
  durationMonths: number;
  planMonths: number;
  status: 'active' | 'completed' | 'dropped';
  note: string;
  paidMinor: number;
  /** Charges (exam fee, late fee, other) as a JSON array; read with parseCharges. */
  chargesJson: string;
};
export type EnrollmentWithLedger = EnrollmentRow & { ledger: Ledger };

const ENROLL_SELECT = `SELECT e.id, e.student_id AS studentId, s.name AS studentName, s.phone AS studentPhone, s.student_no AS studentNo, e.course_id AS courseId,
  c.title AS courseTitle, coalesce(b.name, e.batch) AS batch, e.batch_id AS batchId, e.roll, e.start_date AS startDate, e.fee_minor AS feeMinor, e.admission_fee_minor AS admissionFeeMinor,
  e.discount_minor AS discountMinor, e.duration_months AS durationMonths, e.plan_months AS planMonths, e.status, e.note,
  coalesce((SELECT sum(p.amount_minor) FROM offline_payments p WHERE p.enrollment_id = e.id AND p.voided_at IS NULL), 0) AS paidMinor,
  (SELECT json_group_array(json_object('id', x.id, 'kind', x.kind, 'label', x.label, 'amountMinor', x.amount_minor, 'dueDate', x.due_date))
     FROM offline_charges x WHERE x.enrollment_id = e.id AND x.voided_at IS NULL) AS chargesJson
  FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id JOIN offline_courses c ON c.id = e.course_id
  LEFT JOIN offline_batches b ON b.id = e.batch_id`;

/** The ledger of one enrollment row, with its charges. */
export const ledgerOf = (r: EnrollmentRow, paidMinor: number, today: string) => ledger(r, paidMinor, today, parseCharges(r.chargesJson));
const withLedger = (rows: EnrollmentRow[], today: string): EnrollmentWithLedger[] => rows.map((r) => ({ ...r, ledger: ledgerOf(r, r.paidMinor, today) }));

type EnrollInput = { courseId: string; batchId: string | null; roll: string; startDate: string; discountTaka: number; planMonths: number; note: string };

export function parseEnrollForm(form: FormData): Result<EnrollInput> {
  const courseId = text(form, 'courseId', 40);
  if (!courseId) return { ok: false, error: 'course' };
  const startDate = text(form, 'startDate', 10);
  if (!isYmd(startDate)) return { ok: false, error: 'startDate' };
  const discount = text(form, 'discount') === '' ? 0 : parseTaka(form.get('discount'));
  if (discount === null) return { ok: false, error: 'discount' };
  const plan = Number(text(form, 'plan'));
  if (!(PLAN_MONTHS as readonly number[]).includes(plan)) return { ok: false, error: 'plan' };
  return {
    ok: true,
    value: { courseId, batchId: text(form, 'batchId', 40) || null, roll: text(form, 'roll', 20), startDate, discountTaka: discount, planMonths: plan, note: longText(form, 'note') },
  };
}

/** Copies the course's current fee and length into the enrollment. */
export async function enrollOffline(db: D1Database, actor: string, studentId: string, v: EnrollInput): Promise<string | null> {
  const course = await db
    .prepare(`SELECT fee_minor AS fee, admission_fee_minor AS admission, duration_months AS months FROM offline_courses WHERE id = ? AND status = 'active'`)
    .bind(v.courseId)
    .first<{ fee: number; admission: number; months: number }>();
  const student = await db.prepare('SELECT 1 AS ok FROM offline_students WHERE id = ?').bind(studentId).first();
  if (!course || !student) return null;
  if (v.batchId && !(await batchOfCourse(db, v.batchId, v.courseId))) return null;
  const discount = Math.min(v.discountTaka * 100, course.fee + course.admission);
  const id = newId('ofe');
  await db
    .prepare(
      `INSERT INTO offline_enrollments (id, student_id, course_id, batch_id, roll, start_date, fee_minor, admission_fee_minor, discount_minor, duration_months, plan_months, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, studentId, v.courseId, v.batchId, v.roll, v.startDate, course.fee, course.admission, discount, course.months, v.planMonths, v.note)
    .run();
  await log(db, actor, 'offline.enroll', `offline_student:${studentId}`, { enrollmentId: id, courseId: v.courseId, plan: v.planMonths, discount: discount / 100 });
  return id;
}

type EnrollmentEdit = { status: EnrollmentRow['status']; planMonths: number; discountTaka: number; batchId: string | null; roll: string; startDate: string; note: string };

/** True when the batch belongs to that course. */
async function batchOfCourse(db: D1Database, batchId: string, courseId: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 AS ok FROM offline_batches WHERE id = ? AND course_id = ?').bind(batchId, courseId).first());
}

export function parseEnrollmentEdit(form: FormData): Result<EnrollmentEdit> {
  const status = text(form, 'status');
  if (!['active', 'completed', 'dropped'].includes(status)) return { ok: false, error: 'status' };
  const plan = Number(text(form, 'plan'));
  if (!(PLAN_MONTHS as readonly number[]).includes(plan)) return { ok: false, error: 'plan' };
  const discount = text(form, 'discount') === '' ? 0 : parseTaka(form.get('discount'));
  if (discount === null) return { ok: false, error: 'discount' };
  const startDate = text(form, 'startDate', 10);
  if (!isYmd(startDate)) return { ok: false, error: 'startDate' };
  return {
    ok: true,
    value: {
      status: status as EnrollmentEdit['status'],
      planMonths: plan,
      discountTaka: discount,
      batchId: text(form, 'batchId', 40) || null,
      roll: text(form, 'roll', 20),
      startDate,
      note: longText(form, 'note'),
    },
  };
}

export async function updateEnrollment(db: D1Database, actor: string, id: string, v: EnrollmentEdit): Promise<boolean> {
  const before = await db
    .prepare(
      'SELECT student_id AS studentId, course_id AS courseId, status, plan_months AS plan, discount_minor AS discount, fee_minor AS fee, admission_fee_minor AS admission FROM offline_enrollments WHERE id = ?',
    )
    .bind(id)
    .first<{ studentId: string; courseId: string; status: string; plan: number; discount: number; fee: number; admission: number }>();
  if (!before) return false;
  if (v.batchId && !(await batchOfCourse(db, v.batchId, before.courseId))) return false;
  const discount = Math.min(v.discountTaka * 100, before.fee + before.admission);
  await db
    .prepare('UPDATE offline_enrollments SET status = ?, plan_months = ?, discount_minor = ?, batch_id = ?, roll = ?, start_date = ?, note = ? WHERE id = ?')
    .bind(v.status, v.planMonths, discount, v.batchId, v.roll, v.startDate, v.note, id)
    .run();
  await log(db, actor, 'offline.enrollment.update', `offline_student:${before.studentId}`, {
    enrollmentId: id,
    before: { status: before.status, plan: before.plan, discount: before.discount / 100 },
    after: { status: v.status, plan: v.planMonths, discount: discount / 100 },
  });
  return true;
}

// ---- Payments -------------------------------------------------------------

export type OfflinePayment = {
  id: string;
  receiptNo: number;
  enrollmentId: string;
  amountMinor: number;
  paidOn: string;
  method: PayMethod;
  reference: string;
  note: string;
  recordedBy: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  createdAt: string;
};

const PAYMENT_SELECT = `SELECT p.id, p.receipt_no AS receiptNo, p.enrollment_id AS enrollmentId, p.amount_minor AS amountMinor, p.paid_on AS paidOn,
  p.method, p.reference, p.note, p.recorded_by AS recordedBy, p.voided_at AS voidedAt, p.voided_by AS voidedBy, p.void_reason AS voidReason,
  p.created_at AS createdAt FROM offline_payments p`;

type PaymentInput = { amountTaka: number; paidOn: string; method: PayMethod; reference: string; note: string; nonce: string | null };

export function parsePaymentForm(form: FormData, today: string): Result<PaymentInput> {
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 10_000_000) return { ok: false, error: 'amount' };
  const paidOn = text(form, 'paidOn', 10) || today;
  if (!isYmd(paidOn) || paidOn > today) return { ok: false, error: 'paidOn' };
  const method = text(form, 'method') as PayMethod;
  if (!(PAY_METHODS as readonly string[]).includes(method)) return { ok: false, error: 'method' };
  const nonce = text(form, 'nonce', 40);
  return {
    ok: true,
    value: { amountTaka: amount, paidOn, method, reference: text(form, 'reference', 80), note: longText(form, 'note', 500), nonce: /^[0-9a-f-]{36}$/.test(nonce) ? nonce : null },
  };
}

/**
 * Records money received and gives it the next receipt number. More than
 * what is still due is refused, so a typing slip (12000 for 1200) is caught.
 */
export async function recordPayment(
  db: D1Database,
  actor: string,
  enrollmentId: string,
  v: PaymentInput,
  today: string,
): Promise<{ ok: true; id: string; receiptNo: number } | { ok: false; error: 'missing' | 'too_much' }> {
  // The same form sent twice (double click, browser resend): show the first one again.
  if (v.nonce) {
    const seen = await db.prepare('SELECT id, receipt_no AS receiptNo FROM offline_payments WHERE nonce = ?').bind(v.nonce).first<{ id: string; receiptNo: number }>();
    if (seen) return { ok: true, ...seen };
  }
  const row = await db.prepare(`${ENROLL_SELECT} WHERE e.id = ?`).bind(enrollmentId).first<EnrollmentRow>();
  if (!row) return { ok: false, error: 'missing' };
  if (v.amountTaka * 100 > ledgerOf(row, row.paidMinor, today).dueMinor) return { ok: false, error: 'too_much' };
  const id = newId('ofp');
  // Two people saving at the same moment could pick the same number; the
  // unique index refuses the second, which then takes the next one.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // One statement, so the "not more than is due" check and the insert
      // happen together: two people saving at the same moment cannot both
      // pass the check with the same old balance.
      const r = await db
        .prepare(
          `INSERT INTO offline_payments (id, receipt_no, enrollment_id, amount_minor, paid_on, method, reference, note, recorded_by, nonce)
           SELECT ?1, (SELECT coalesce(max(receipt_no), 0) + 1 FROM offline_payments), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
           WHERE ?3 <= (SELECT max(0, e.fee_minor + e.admission_fee_minor - e.discount_minor) FROM offline_enrollments e WHERE e.id = ?2)
                     + (SELECT coalesce(sum(x.amount_minor), 0) FROM offline_charges x WHERE x.enrollment_id = ?2 AND x.voided_at IS NULL)
                     - (SELECT coalesce(sum(p.amount_minor), 0) FROM offline_payments p WHERE p.enrollment_id = ?2 AND p.voided_at IS NULL)
           RETURNING receipt_no AS receiptNo`,
        )
        .bind(id, enrollmentId, v.amountTaka * 100, v.paidOn, v.method, v.reference, v.note, actor, v.nonce)
        .first<{ receiptNo: number }>();
      if (!r) return { ok: false, error: 'too_much' };
      await log(db, actor, 'offline.payment', `offline_student:${row.studentId}`, { paymentId: id, receiptNo: r!.receiptNo, amount: v.amountTaka, method: v.method });
      // The digital receipt reaches the student's (and guardian's) portal at once.
      await db
        .prepare(
          `INSERT INTO portal_notifications (id, recipient_kind, offline_student_id, title, body, link, source_key, created_by)
           VALUES (?, 'student', ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
        .bind(newId('ntf'), row.studentId, `৳${v.amountTaka.toLocaleString('en-IN')} জমা হয়েছে, রসিদ নং ${r!.receiptNo}`, `${row.courseTitle}। রসিদ খুলে প্রিন্ট বা সংরক্ষণ করতে পারবেন।`, `/account/offline/receipt/${id}`, `receipt:${id}`, actor)
        .run();
      return { ok: true, id, receiptNo: r!.receiptNo };
    } catch (e) {
      if (v.nonce) {
        const seen = await db.prepare('SELECT id, receipt_no AS receiptNo FROM offline_payments WHERE nonce = ?').bind(v.nonce).first<{ id: string; receiptNo: number }>();
        if (seen) return { ok: true, ...seen };
      }
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('unreachable');
}

/** A wrong entry stays on record, marked void, and stops counting as paid. */
export async function voidPayment(db: D1Database, actor: string, paymentId: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE offline_payments SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ?
       WHERE id = ? AND voided_at IS NULL RETURNING enrollment_id AS enrollmentId, receipt_no AS receiptNo, amount_minor AS amount`,
    )
    .bind(actor, why, paymentId)
    .first<{ enrollmentId: string; receiptNo: number; amount: number }>();
  if (!r) return false;
  const e = await db.prepare('SELECT student_id AS studentId FROM offline_enrollments WHERE id = ?').bind(r.enrollmentId).first<{ studentId: string }>();
  await log(db, actor, 'offline.payment.void', `offline_student:${e?.studentId ?? ''}`, { paymentId, receiptNo: r.receiptNo, amount: r.amount / 100, reason: why });
  return true;
}

export async function getReceipt(db: D1Database, paymentId: string, today: string) {
  const payment = await db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).bind(paymentId).first<OfflinePayment>();
  if (!payment) return null;
  const enrollment = await db.prepare(`${ENROLL_SELECT} WHERE e.id = ?`).bind(payment.enrollmentId).first<EnrollmentRow>();
  if (!enrollment) return null;
  const student = await db.prepare('SELECT address, guardian_phone AS guardianPhone FROM offline_students WHERE id = ?').bind(enrollment.studentId).first<{ address: string; guardianPhone: string }>();
  // What was paid up to and including this receipt, so a reprint later shows the same balance.
  const upTo = await db
    .prepare('SELECT coalesce(sum(amount_minor), 0) AS paid FROM offline_payments WHERE enrollment_id = ? AND voided_at IS NULL AND receipt_no <= ?')
    .bind(payment.enrollmentId, payment.receiptNo)
    .first<{ paid: number }>();
  return { payment, enrollment, address: student?.address ?? '', ledger: ledgerOf(enrollment, upTo?.paid ?? 0, today) };
}

// ---- Lists and reports ------------------------------------------------------

export type StudentListRow = OfflineStudent & { courses: string; dueMinor: number; overdueMinor: number; nextDue: string | null };

/** Students, newest first, with what they still owe across their courses. */
export async function listOfflineStudents(db: D1Database, q: string, today: string, filter: 'all' | 'due' | 'overdue' = 'all'): Promise<StudentListRow[]> {
  const term = q.trim().toLowerCase().slice(0, 80).replace(/[%_]/g, '');
  const phone = cleanPhone(term);
  const no = parseStudentNo(term);
  const { results: students } = await db
    .prepare(
      `SELECT ${STUDENT_COLS} FROM offline_students
       ${term ? 'WHERE lower(name) LIKE ?1 OR phone LIKE ?2 OR guardian_phone LIKE ?2 OR lower(email) LIKE ?1 OR student_no = ?3' : ''} ORDER BY created_at DESC LIMIT 500`,
    )
    .bind(...(term ? [`%${term}%`, `%${phone || term}%`, no ?? -1] : []))
    .all<OfflineStudent>();
  if (!students.length) return [];
  const { results: rows } = await db.prepare(`${ENROLL_SELECT} WHERE e.status != 'dropped'`).all<EnrollmentRow>();
  const byStudent = new Map<string, EnrollmentWithLedger[]>();
  for (const e of withLedger(rows, today)) byStudent.set(e.studentId, [...(byStudent.get(e.studentId) ?? []), e]);
  return students
    .map((s) => {
      const es = byStudent.get(s.id) ?? [];
      const nexts = es.map((e) => e.ledger.next?.dueDate).filter((d): d is string => Boolean(d)).sort();
      return {
        ...s,
        courses: es.map((e) => e.courseTitle).join(', '),
        dueMinor: es.reduce((a, e) => a + e.ledger.dueMinor, 0),
        overdueMinor: es.reduce((a, e) => a + e.ledger.overdueMinor, 0),
        nextDue: nexts[0] ?? null,
      };
    })
    .filter((s) => (filter === 'due' ? s.dueMinor > 0 : filter === 'overdue' ? s.overdueMinor > 0 : true));
}

export async function getOfflineStudent(db: D1Database, id: string, today: string) {
  const student = await db
    .prepare(`SELECT ${STUDENT_COLS} FROM offline_students WHERE id = ?`)
    .bind(id)
    .first<OfflineStudent>();
  if (!student) return null;
  const [enrollments, payments] = await db.batch([
    db.prepare(`${ENROLL_SELECT} WHERE e.student_id = ? ORDER BY e.start_date DESC, e.created_at DESC`).bind(id),
    db.prepare(`${PAYMENT_SELECT} JOIN offline_enrollments e ON e.id = p.enrollment_id WHERE e.student_id = ? ORDER BY p.paid_on DESC, p.receipt_no DESC`).bind(id),
  ]);
  return {
    student,
    enrollments: withLedger(enrollments!.results as EnrollmentRow[], today),
    payments: payments!.results as OfflinePayment[],
  };
}

const monthOf = (ymd: string) => ymd.slice(0, 7);

/** "MI-0012", "mi12" or "12" (old "TI-0012" too) -> 12. Long digit strings are phone numbers, not IDs. */
export function parseStudentNo(term: string): number | null {
  const m = /^(?:[mt]i-?)?(\d{1,6})$/i.exec(term.trim().replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))));
  return m ? Number(m[1]) : null;
}

/** The overview page: totals, who is late, who is due this month. */
export async function offlineOverview(db: D1Database, today: string) {
  const month = monthOf(today);
  const [rows, collected, people] = await db.batch([
    db.prepare(`${ENROLL_SELECT} WHERE e.status != 'dropped'`),
    db.prepare(`SELECT coalesce(sum(amount_minor), 0) AS total, count(*) AS n FROM offline_payments WHERE voided_at IS NULL AND paid_on LIKE ?`).bind(`${month}-%`),
    db.prepare(
      `SELECT (SELECT count(DISTINCT student_id) FROM offline_enrollments WHERE status = 'active') AS activeStudents,
              (SELECT count(*) FROM offline_courses WHERE status = 'active') AS activeCourses`,
    ),
  ]);
  const all = withLedger(rows!.results as EnrollmentRow[], today);
  const endOfMonth = `${month}-31`;
  const c = collected!.results[0] as { total: number; n: number };
  const p = people!.results[0] as { activeStudents: number; activeCourses: number };
  return {
    activeStudents: p.activeStudents,
    activeCourses: p.activeCourses,
    collectedThisMonthMinor: c.total,
    paymentsThisMonth: c.n,
    totalDueMinor: all.reduce((a, e) => a + e.ledger.dueMinor, 0),
    totalOverdueMinor: all.reduce((a, e) => a + e.ledger.overdueMinor, 0),
    overdue: all.filter((e) => e.ledger.overdueMinor > 0).sort((a, b) => (a.ledger.next?.dueDate ?? '').localeCompare(b.ledger.next?.dueDate ?? '')),
    dueSoon: all
      .filter((e) => e.ledger.overdueMinor === 0 && e.ledger.next && e.ledger.next.dueDate <= endOfMonth)
      .sort((a, b) => a.ledger.next!.dueDate.localeCompare(b.ledger.next!.dueDate)),
  };
}

export type PaymentReportRow = OfflinePayment & { studentId: string; studentName: string; studentPhone: string; courseTitle: string };

/** Everything received in one month ("2026-11"), by course and by method. */
export async function monthReport(db: D1Database, month: string) {
  const { results } = await db
    .prepare(
      `${PAYMENT_SELECT.replace(' FROM offline_payments p', `, s.id AS studentId, s.name AS studentName, s.phone AS studentPhone, c.title AS courseTitle
        FROM offline_payments p`)}
       JOIN offline_enrollments e ON e.id = p.enrollment_id JOIN offline_students s ON s.id = e.student_id JOIN offline_courses c ON c.id = e.course_id
       WHERE p.paid_on LIKE ? ORDER BY p.paid_on, p.receipt_no`,
    )
    .bind(`${month}-%`)
    .all<PaymentReportRow>();
  const valid = results.filter((r) => !r.voidedAt);
  const group = (key: (r: PaymentReportRow) => string) => {
    const m = new Map<string, { label: string; totalMinor: number; count: number }>();
    for (const r of valid) {
      const k = key(r);
      const g = m.get(k) ?? { label: k, totalMinor: 0, count: 0 };
      g.totalMinor += r.amountMinor;
      g.count += 1;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.totalMinor - a.totalMinor);
  };
  return {
    payments: results,
    totalMinor: valid.reduce((a, r) => a + r.amountMinor, 0),
    byCourse: group((r) => r.courseTitle),
    byMethod: group((r) => r.method),
  };
}

/**
 * Active enrollments with their balance, for one course, one batch (its
 * current placement, so a promoted student is found in the new class) or
 * everyone. Used for bulk fee bills and printed due statements.
 */
export async function activeEnrollmentsFor(db: D1Database, today: string, target: { kind: 'all' | 'course' | 'batch'; id: string }, limit = 3000): Promise<EnrollmentWithLedger[]> {
  const filter =
    target.kind === 'course'
      ? 'AND e.course_id = ?'
      : target.kind === 'batch'
        ? `AND coalesce((SELECT p.to_batch_id FROM academic_promotions p JOIN academic_sessions ss ON ss.id = p.to_session_id AND ss.status = 'active' WHERE p.enrollment_id = e.id LIMIT 1), e.batch_id) = ?`
        : '';
  const { results } = await db
    .prepare(`${ENROLL_SELECT} WHERE e.status = 'active' AND s.status = 'active' ${filter} ORDER BY s.student_no, s.name, e.start_date LIMIT ?`)
    .bind(...(filter ? [target.id] : []), limit)
    .all<EnrollmentRow>();
  return withLedger(results, today);
}

/** Every enrollment with its balance, for the Excel export. */
export async function allEnrollments(db: D1Database, today: string): Promise<EnrollmentWithLedger[]> {
  const { results } = await db.prepare(`${ENROLL_SELECT} ORDER BY s.name, e.start_date`).all<EnrollmentRow>();
  return withLedger(results, today);
}

// ---- Charges: exam fees, late fees, anything else on top of the course fee ----

export type ChargeRow = {
  id: string;
  enrollmentId: string;
  kind: 'exam' | 'late' | 'other';
  label: string;
  amountMinor: number;
  dueDate: string;
  sourceKey: string;
  createdBy: string;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  createdAt: string;
};

const CHARGE_SELECT = `SELECT id, enrollment_id AS enrollmentId, kind, label, amount_minor AS amountMinor, due_date AS dueDate, source_key AS sourceKey,
  created_by AS createdBy, voided_at AS voidedAt, voided_by AS voidedBy, void_reason AS voidReason, created_at AS createdAt FROM offline_charges`;

export async function chargesOfStudent(db: D1Database, studentId: string): Promise<ChargeRow[]> {
  const { results } = await db
    .prepare(`${CHARGE_SELECT} WHERE enrollment_id IN (SELECT id FROM offline_enrollments WHERE student_id = ?) ORDER BY due_date DESC, created_at DESC`)
    .bind(studentId)
    .all<ChargeRow>();
  return results;
}

type ChargeInput = { label: string; amountTaka: number; dueDate: string };

export function parseChargeForm(form: FormData, today: string): Result<ChargeInput> {
  const label = text(form, 'label', 120);
  if (label.length < 2) return { ok: false, error: 'label' };
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 10_000_000) return { ok: false, error: 'amount' };
  const dueDate = text(form, 'dueDate', 10) || today;
  if (!isYmd(dueDate)) return { ok: false, error: 'dueDate' };
  return { ok: true, value: { label, amountTaka: amount, dueDate } };
}

/** A charge the office adds by hand (books, uniform, a fine). */
export async function addOtherCharge(db: D1Database, actor: string, enrollmentId: string, v: ChargeInput): Promise<boolean> {
  const e = await db.prepare('SELECT student_id AS studentId FROM offline_enrollments WHERE id = ?').bind(enrollmentId).first<{ studentId: string }>();
  if (!e) return false;
  const id = newId('chg');
  await db
    .prepare('INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, enrollmentId, 'other', v.label, v.amountTaka * 100, v.dueDate, `other:${id}`, actor)
    .run();
  await log(db, actor, 'offline.charge.add', `offline_student:${e.studentId}`, { chargeId: id, enrollmentId, label: v.label, amount: v.amountTaka });
  return true;
}

/** Waives a charge: it stays on record, marked void, and stops counting. */
export async function voidCharge(db: D1Database, actor: string, chargeId: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE offline_charges SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ?
       WHERE id = ? AND voided_at IS NULL RETURNING enrollment_id AS enrollmentId, label, amount_minor AS amount`,
    )
    .bind(actor, why, chargeId)
    .first<{ enrollmentId: string; label: string; amount: number }>();
  if (!r) return false;
  const e = await db.prepare('SELECT student_id AS studentId FROM offline_enrollments WHERE id = ?').bind(r.enrollmentId).first<{ studentId: string }>();
  await log(db, actor, 'offline.charge.void', `offline_student:${e?.studentId ?? ''}`, { chargeId, label: r.label, amount: r.amount / 100, reason: why });
  return true;
}

/**
 * Adds a late fee to each course fee installment of an active enrollment that
 * is still unpaid after the grace days. One late fee per installment, ever:
 * the unique source key ("late:<n>") stops a second one, even if two runs
 * happen at once. Waiving one (voiding it) does not bring it back.
 * Returns how many were added.
 */
export async function applyLateFees(db: D1Database, today: string, amountTaka: number, graceDays: number): Promise<number> {
  if (amountTaka <= 0) return 0;
  const { results } = await db.prepare(`${ENROLL_SELECT} WHERE e.status = 'active'`).all<EnrollmentRow>();
  const { results: done } = await db
    .prepare(`SELECT enrollment_id AS enrollmentId, source_key AS sourceKey FROM offline_charges WHERE kind = 'late'`)
    .all<{ enrollmentId: string; sourceKey: string }>();
  const doneBy = new Map<string, Set<number>>();
  for (const d of done) {
    const n = Number(d.sourceKey.slice(5));
    doneBy.set(d.enrollmentId, (doneBy.get(d.enrollmentId) ?? new Set()).add(n));
  }
  const inserts: D1PreparedStatement[] = [];
  for (const r of results) {
    for (const s of lateInstallments(ledgerOf(r, r.paidMinor, today), today, graceDays, doneBy.get(r.id) ?? new Set())) {
      inserts.push(
        db
          .prepare(
            `INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
             VALUES (?, ?, 'late', ?, ?, ?, ?, 'system') ON CONFLICT (enrollment_id, source_key) DO NOTHING`,
          )
          .bind(newId('chg'), r.id, `লেট ফি (কিস্তি ${bnDigits(s.n)})`, amountTaka * 100, addDays(s.dueDate, graceDays + 1), `late:${s.n}`),
      );
    }
  }
  let added = 0;
  for (let i = 0; i < inserts.length; i += 50) {
    const out = await db.batch(inserts.slice(i, i + 50));
    added += out.reduce((a, o) => a + (o.meta.changes ?? 0), 0);
  }
  if (added) await log(db, 'system', 'offline.late_fees', 'offline_charges', { added, amount: amountTaka, graceDays, day: today });
  return added;
}
