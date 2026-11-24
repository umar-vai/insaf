import { log } from './admin';
import { recordPayment, type EnrollmentWithLedger } from './offline';
import type { Validation } from './sslcommerz';
import { dayBn, todayDhaka } from '../lib/offline';

// Offline course fees paid online through SSLCommerz, by a student signed in
// with the Gmail the office saved for them.
//
// The amount always comes from the server: the student only picks one of the
// choices worked out from their own ledger. The money counts only after
// SSLCommerz's validation API says the payment is valid, for this reference,
// for the full amount, in Taka and not risky. It then becomes an ordinary
// offline payment with a receipt number, exactly once (the reference is the
// payment's nonce). Anything that does not match waits in 'review' for staff.

export type FeeChoice = { key: string; amountMinor: number; label: string; allocationKey?: string };

/** What the student may pay now: what is late, the next installment, or everything still due. */
export function feeChoices(e: Pick<EnrollmentWithLedger, 'ledger' | 'status'>, specific = false): FeeChoice[] {
  if (e.status !== 'active' || e.ledger.dueMinor <= 0) return [];
  const out: FeeChoice[] = [];
  const add = (c: FeeChoice) => c.amountMinor > 0 && !out.some((x) => x.amountMinor === c.amountMinor) && out.push(c);
  if (e.ledger.overdueMinor > 0) add({ key: 'overdue', amountMinor: e.ledger.overdueMinor, label: 'তারিখ পার হওয়া বকেয়া' });
  else if (e.ledger.next) add({ key: 'next', amountMinor: e.ledger.next.amountMinor, label: 'পরের কিস্তি' });
  add({ key: 'all', amountMinor: e.ledger.dueMinor, label: 'পুরো বাকি টাকা' });
  if (specific) for (const item of e.ledger.installments.filter((i) => i.paidMinor < i.amountMinor)) {
    out.push({ key: item.key, allocationKey: item.key, amountMinor: item.amountMinor - item.paidMinor, label: `${item.label} · ${dayBn(item.dueDate)}` });
  }
  return out;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newFeeReference(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `TF-${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}
export const isFeeReference = (ref: string | undefined | null) => Boolean(ref?.startsWith('TF-'));

export type FeePayment = {
  id: string;
  reference: string;
  enrollmentId: string;
  studentId: string;
  amountMinor: number;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'review' | 'resolved';
  paymentId: string | null;
  allocationKey: string;
  resolutionKind: string;
  resolutionReference: string;
  reviewReason: string | null;
  createdAt: string;
};

const SELECT = `SELECT id, reference, enrollment_id AS enrollmentId, student_id AS studentId, amount_minor AS amountMinor, status, payment_id AS paymentId,
  review_reason AS reviewReason, allocation_key AS allocationKey, resolution_kind AS resolutionKind, resolution_reference AS resolutionReference, created_at AS createdAt FROM offline_online_payments`;

export const feePaymentByReference = (db: D1Database, reference: string) => db.prepare(`${SELECT} WHERE reference = ?`).bind(reference).first<FeePayment>();

/** Starts a payment for a choice from the student's own enrollment. The amount is worked out here. */
export async function createFeePayment(
  db: D1Database,
  account: { id: string; email: string },
  enrollments: EnrollmentWithLedger[],
  enrollmentId: string,
  choice: string,
): Promise<{ ok: true; payment: FeePayment; title: string; phone: string; name: string } | { ok: false; reason: 'not_found' | 'nothing_due' }> {
  // Only enrollments of offline students with this account's email are passed in.
  const e = enrollments.find((x) => x.id === enrollmentId);
  if (!e) return { ok: false, reason: 'not_found' };
  const c = feeChoices(e, true).find((x) => x.key === choice);
  if (!c) return { ok: false, reason: 'nothing_due' };
  const id = `ofop_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const reference = newFeeReference();
  await db
    .prepare('INSERT INTO offline_online_payments (id, reference, enrollment_id, student_id, amount_minor, allocation_key) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, reference, e.id, account.id, c.amountMinor, c.allocationKey ?? '')
    .run();
  await log(db, account.email, 'fee_online.start', `offline_student:${e.studentId}`, { reference, amount: c.amountMinor / 100, choice });
  return {
    ok: true,
    payment: { id, reference, enrollmentId: e.id, studentId: account.id, amountMinor: c.amountMinor, status: 'pending', paymentId: null, reviewReason: null, allocationKey: c.allocationKey ?? '', resolutionKind: '', resolutionReference: '', createdAt: '' },
    title: `${e.courseTitle} কোর্সের ফি`,
    phone: e.studentPhone,
    name: e.studentName,
  };
}

async function event(db: D1Database, kind: string, detail: unknown) {
  await db.prepare('INSERT INTO donation_events (id, donation_id, kind, detail_json) VALUES (?, NULL, ?, ?)').bind(`dev_${crypto.randomUUID()}`, `fee.${kind}`, JSON.stringify(detail).slice(0, 4000)).run();
}

/** Applies SSLCommerz's validation answer. Safe to call many times (browser return and IPN). */
export async function applyFeeValidation(db: D1Database, v: Validation | null, expectedReference: string, today = todayDhaka()): Promise<FeePayment['status'] | 'unknown'> {
  const reference = v?.tran_id ?? expectedReference;
  const p = await feePaymentByReference(db, reference);
  await event(db, 'validation', { reference, v: v ?? { error: 'unreachable' } });
  if (!p) return 'unknown';
  if (p.status === 'paid' || p.status === 'resolved') return p.status;
  if (!v || !(v.status === 'VALID' || v.status === 'VALIDATED')) return p.status;

  const matches =
    v.tran_id === p.reference && expectedReference === p.reference && (v.currency ?? '').toUpperCase() === 'BDT' && v.amount !== undefined && Math.round(Number(v.amount) * 100) === p.amountMinor;
  const setGateway = (status: string, reason: string | null, paymentId: string | null) =>
    db
      .prepare(
        `UPDATE offline_online_payments SET status = ?, review_reason = ?, payment_id = coalesce(?, payment_id), val_id = ?, bank_tran_id = ?, card_type = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status NOT IN ('paid', 'resolved')`,
      )
      .bind(status, reason, paymentId, v.val_id ?? null, v.bank_tran_id ?? null, v.card_type ?? null, p.id)
      .run();

  if (!matches || v.risk_level === '1') {
    await setGateway('review', matches ? 'risky' : 'mismatch', null);
    return 'review';
  }
  // The reference is the receipt's nonce, so a second call finds the same receipt.
  const r = await recordPayment(
    db,
    'sslcommerz',
    p.enrollmentId,
    { amountTaka: Math.round(p.amountMinor / 100), paidOn: today, method: 'online', reference: v.bank_tran_id ?? p.reference, note: `অনলাইন পেমেন্ট ${p.reference}`, nonce: p.reference, allocationKey: p.allocationKey },
    today,
  );
  if (!r.ok) {
    // Paid at the office meanwhile, so this is more than is due now: staff decide.
    await setGateway('review', r.error, null);
    return 'review';
  }
  await setGateway('paid', null, r.id);
  return 'paid';
}

export async function markFeeUnpaid(db: D1Database, reference: string, status: 'failed' | 'cancelled', detail: unknown) {
  await event(db, status, { reference, detail });
  await db
    .prepare(`UPDATE offline_online_payments SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reference = ? AND status = 'pending'`)
    .bind(status, reference)
    .run();
}

/** Payments that need a person: money arrived but something did not match. */
export async function feePaymentsToReview(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.reference, p.amount_minor AS amountMinor, p.review_reason AS reviewReason, p.bank_tran_id AS bankTranId, p.created_at AS createdAt,
         s.id AS offlineStudentId, s.name AS studentName, c.title AS courseTitle
       FROM offline_online_payments p JOIN offline_enrollments e ON e.id = p.enrollment_id JOIN offline_students s ON s.id = e.student_id
       JOIN offline_courses c ON c.id = e.course_id WHERE p.status = 'review' ORDER BY p.created_at`,
    )
    .all<{ id: string; reference: string; amountMinor: number; reviewReason: string | null; bankTranId: string | null; createdAt: string; offlineStudentId: string; studentName: string; courseTitle: string }>();
  return results;
}

export const FEE_RESOLUTIONS = { receipt: 'রসিদে জমা হয়েছে', refund: 'ফেরত দেওয়া হয়েছে', no_funds: 'ব্যাংকে টাকা আসেনি' } as const;

/** Link the receipt or retain the external reference for the reviewed decision. */
export async function resolveFeeReview(db: D1Database, actor: string, id: string, note: string, kind: string, evidence: string): Promise<boolean> {
  const why = note.trim().slice(0, 300);
  const reference = evidence.trim().slice(0, 120);
  if (why.length < 2 || !reference || !Object.hasOwn(FEE_RESOLUTIONS, kind)) return false;
  const receiptNo = Number(reference.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/^#/, ''));
  const r = await db.prepare(`UPDATE offline_online_payments AS op SET status = 'resolved',
      review_reason = coalesce(review_reason, '') || ' | ' || ?1, resolution_kind = ?2, resolution_reference = ?3,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      payment_id = CASE WHEN ?2 = 'receipt' THEN (SELECT id FROM offline_payments WHERE receipt_no = ?4) ELSE op.payment_id END
      WHERE op.id = ?5 AND op.status = 'review' AND (?2 <> 'receipt' OR EXISTS (
        SELECT 1 FROM offline_payments p WHERE p.receipt_no = ?4 AND p.enrollment_id = op.enrollment_id
        AND p.amount_minor = op.amount_minor AND p.voided_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM offline_online_payments other WHERE other.payment_id = p.id AND other.id <> op.id)
      ))`)
    .bind(`${actor}: ${why}`, kind, reference, Number.isSafeInteger(receiptNo) ? receiptNo : null, id).run();
  if (r.meta.changes) await log(db, actor, 'fee_online.resolve', `fee_online:${id}`, { note: why, kind, reference });
  return r.meta.changes > 0;
}
