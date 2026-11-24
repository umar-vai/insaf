import { log } from './admin';
import { parseStudentNo } from './offline';
import { newId, text, type Result } from './ops-util';

type Assistance = {
  id: string; enrollmentId: string; kind: 'sibling' | 'zakat'; siblingId: string | null; siblingName: string | null; fundId: string | null;
  revokedAt: string | null; revokeReason: string; fundName: string | null; admissionWaiverMinor: number; tuitionWaiverMinor: number; approvedBy: string; reason: string;
};

export async function assistanceForStudent(db: D1Database, studentId: string): Promise<Assistance[]> {
  return (await db.prepare(`SELECT a.id, a.revoked_at AS revokedAt, a.revoke_reason AS revokeReason, a.enrollment_id AS enrollmentId, a.kind, a.sibling_id AS siblingId, s.name AS siblingName, a.fund_id AS fundId,
    f.name AS fundName, a.admission_waiver_minor AS admissionWaiverMinor, a.tuition_waiver_minor AS tuitionWaiverMinor, a.approved_by AS approvedBy, a.reason
    FROM enrollment_assistance a JOIN offline_enrollments e ON e.id = a.enrollment_id
    LEFT JOIN offline_students s ON s.id = a.sibling_id LEFT JOIN acc_funds f ON f.id = a.fund_id
    WHERE e.student_id = ? ORDER BY a.approved_at DESC`).bind(studentId).all<Assistance>()).results;
}

/** Staff attest the family relationship or Zakat eligibility. The grant itself is never a cash receipt or an expense. */
export async function approveAssistance(db: D1Database, actor: string, studentId: string, form: FormData): Promise<Result<string>> {
  const enrollmentId = text(form, 'enrollmentId', 40);
  const kind = text(form, 'kind', 10);
  const reason = text(form, 'reason', 250);
  if (!['sibling', 'zakat'].includes(kind) || reason.length < 3 || form.get('confirm') !== 'yes') return { ok: false, error: 'assistance_input' };

  const siblingNo = kind === 'sibling' ? parseStudentNo(text(form, 'siblingNo', 24)) : null;
  const fundId = kind === 'zakat' ? text(form, 'fundId', 40) : '';
  if (kind === 'sibling' && !siblingNo) return { ok: false, error: 'assistance_sibling' };
  if (kind === 'zakat' && (!fundId || form.get('guardianConsent') !== 'yes')) return { ok: false, error: 'assistance_fund' };
  const id = newId('aid');
  const [grant] = await db.batch([
    db.prepare(`INSERT INTO enrollment_assistance (id, enrollment_id, kind, sibling_id, fund_id, original_admission_minor, original_discount_minor,
        admission_waiver_minor, tuition_waiver_minor, reason, approved_by)
      SELECT ?1, e.id, ?2, sibling.id, f.id, e.admission_fee_minor, e.discount_minor,
        CASE WHEN ?2 = 'sibling' THEN (e.admission_fee_minor / 100 - e.admission_fee_minor / 200) * 100 ELSE e.admission_fee_minor END,
        CASE WHEN ?2 = 'sibling' THEN max(0, (e.fee_minor / 100 - e.fee_minor / 200) * 100 - e.discount_minor)
          ELSE e.fee_minor - e.discount_minor END, ?3, ?4
      FROM offline_enrollments e JOIN offline_students s ON s.id = e.student_id
      LEFT JOIN offline_students sibling ON sibling.student_no = ?5 AND sibling.id <> s.id AND sibling.status = 'active'
        AND sibling.student_no < s.student_no AND EXISTS (SELECT 1 FROM offline_enrollments x WHERE x.student_id = sibling.id AND x.status = 'active')
      LEFT JOIN acc_funds f ON f.id = ?6 AND f.kind = 'zakat' AND f.restricted = 1 AND f.status = 'active'
      WHERE e.id = ?7 AND s.id = ?8 AND s.status = 'active' AND e.status = 'active'
      AND ((?2 = 'sibling' AND sibling.id IS NOT NULL) OR (?2 = 'zakat' AND f.id IS NOT NULL))
      AND e.discount_minor <= e.fee_minor
      AND NOT EXISTS (SELECT 1 FROM offline_payments p WHERE p.enrollment_id = e.id)
      ON CONFLICT (enrollment_id) WHERE revoked_at IS NULL DO NOTHING`).bind(id, kind, reason, actor, siblingNo, fundId, enrollmentId, studentId),
    db.prepare(`UPDATE offline_enrollments SET
      admission_fee_minor = admission_fee_minor - (SELECT admission_waiver_minor FROM enrollment_assistance WHERE id = ?1),
      discount_minor = discount_minor + (SELECT tuition_waiver_minor FROM enrollment_assistance WHERE id = ?1)
      WHERE id = ?2 AND EXISTS (SELECT 1 FROM enrollment_assistance WHERE id = ?1)`).bind(id, enrollmentId),
  ]);
  if (!grant?.meta.changes) return { ok: false, error: kind === 'sibling' ? 'assistance_sibling_or_locked' : 'assistance_grant_locked' };
  await log(db, actor, 'school.assistance.approve', `offline_student:${studentId}`, { id, enrollmentId, kind });
  return { ok: true, value: id };
}

export async function revokeAssistance(db: D1Database, actor: string, studentId: string, form: FormData): Promise<Result<string>> {
  const id = text(form, 'grantId', 40);
  const reason = text(form, 'reason', 250);
  if (reason.length < 3) return { ok: false, error: 'assistance_input' };
  const [revoked] = await db.batch([
    db.prepare(`UPDATE enrollment_assistance SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revoked_by = ?1, revoke_reason = ?2
      WHERE id = ?3 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM offline_enrollments e
        WHERE e.id = enrollment_assistance.enrollment_id AND e.student_id = ?4
        AND NOT EXISTS (SELECT 1 FROM offline_payments p WHERE p.enrollment_id = e.id))`).bind(actor, reason, id, studentId),
    db.prepare(`UPDATE offline_enrollments SET (admission_fee_minor, discount_minor) = (
      SELECT original_admission_minor, original_discount_minor FROM enrollment_assistance WHERE id = ?1
    ) WHERE id = (SELECT enrollment_id FROM enrollment_assistance WHERE id = ?1) AND changes() = 1`).bind(id),
  ]);
  if (!revoked?.meta.changes) return { ok: false, error: 'assistance_revoke' };
  await log(db, actor, 'school.assistance.revoke', `offline_student:${studentId}`, { id, reason });
  return { ok: true, value: id };
}
