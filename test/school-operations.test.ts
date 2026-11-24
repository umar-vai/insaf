import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { createExam } from '../src/server/academic';
import { configureAssessment, publishAssessment, recordExamMark } from '../src/server/assessment';
import { matchBankStatement, parseBankStatement, saveBankStatement, statementLineKey } from '../src/server/bank-statement';
import { approveAssistance, revokeAssistance } from '../src/server/enrollment-assistance';
import { billPreview } from '../src/server/fee-bills';
import { getOfflineStudent, getReceipt, monthReport, parsePaymentForm, receiptAllocations, recordPayment, voidPayment } from '../src/server/offline';
import { billResidence, placeResident, releaseResident, residenceView, saveRoom } from '../src/server/residence';
import { approveResultPromotions, eligibleForResultPromotion, resultPromotionPreview } from '../src/server/result-promotions';

const db = env.DB;
const actor = 'owner@example.org';
const today = '2026-11-24';
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const take = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

beforeEach(async () => {
  await db.batch([
    ...['acc_cleared_items', 'portal_notifications', 'assessment_marks', 'assessment_examinees', 'assessment_policies',
      'academic_promotions', 'academic_batch_sessions', 'enrollment_assistance', 'residential_stays', 'residential_rooms', 'offline_exams',
      'offline_charges', 'offline_payments', 'offline_enrollments', 'offline_students', 'offline_batches', 'offline_courses', 'academic_sessions',
    ].map((name) => db.prepare(`DELETE FROM ${name}`)),
    db.prepare("DELETE FROM acc_funds WHERE id = 'aid-zakat'"),
    db.prepare("INSERT INTO acc_funds(id,name,kind,restricted,created_by) VALUES('aid-zakat','Test Zakat','zakat',1,'test')"),
    db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('test-course','Test Course',600000,6)"),
    db.prepare("INSERT INTO offline_batches(id,course_id,name) VALUES('b1','test-course','Class One'),('b2','test-course','Class Two')"),
    db.prepare("INSERT INTO offline_students(id,name,phone,student_no) VALUES('s1','Test One','01700000001',1),('s2','Test Two','01700000002',2),('s3','Test Three','01700000003',3)"),
    db.prepare(`INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,start_date,fee_minor,admission_fee_minor,duration_months,plan_months)
      VALUES('e1','s1','test-course','b1','2026-08-01',600000,150000,6,1),('e2','s2','test-course','b1','2026-08-01',600000,150000,6,1),
        ('e3','s3','test-course','b1','2026-08-01',600000,150000,6,1)`),
  ]);
});

it('records one receipt in two fee heads, shows both in the report, and unwinds a void', async () => {
  const data = form({ amount: '700', method: 'cash', allocationKey: 'split', 'split:admission': '400', 'split:fee:2': '300', nonce: '80000000-1111-4222-8999-810000000001' });
  const payment = take(parsePaymentForm(data, today));
  const r = await recordPayment(db, actor, 'e1', payment, today);
  if (!r.ok) throw new Error(r.error);
  expect(await recordPayment(db, actor, 'e1', payment, today)).toEqual(r);
  const receipt = (await getReceipt(db, r.id, today))!;
  expect(receiptAllocations(receipt.payment).map((a) => [a.key, a.amountMinor]).sort()).toEqual([['admission', 40000], ['fee:2', 30000]]);
  expect(receipt.ledger.installments.find((i) => i.key === 'fee:1')?.paidMinor).toBe(0);
  expect(receipt.ledger.installments.find((i) => i.key === 'fee:2')?.paidMinor).toBe(30000);
  expect((await monthReport(db, '2026-11')).byHead.map((head) => head.totalMinor)).toEqual([40000, 30000]);
  expect(await recordPayment(db, actor, 'e1', { ...payment, nonce: null, amountTaka: 1600, allocations: [{ key: 'admission', amountMinor: 130000 }, { key: 'fee:2', amountMinor: 30000 }] }, today)).toEqual({ ok: false, error: 'allocation' });
  data.set('amount', '601');
  expect(parsePaymentForm(data, today)).toEqual({ ok: false, error: 'allocation' });
  expect(await voidPayment(db, actor, r.id, 'Test reversal')).toBe(true);
  expect((await monthReport(db, '2026-11')).byHead).toEqual([]);
  expect((await getOfflineStudent(db, 's1', today))!.enrollments[0]!.ledger.paidMinor).toBe(0);
});

it('matches only the exact bank account and amount, ignores duplicates, and safely replays', async () => {
  const paid = await recordPayment(db, actor, 'e1', { amountTaka: 1000, paidOn: today, method: 'bank', reference: 'TEST-123', note: '', nonce: null }, today);
  expect(paid.ok).toBe(true);
  const raw = 'date,reference,credit,debit\n2026-11-24,TEST-123,1000.00,\n2026-11-24,TEST-456,200.01,';
  const lines = take(parseBankStatement(raw, today));
  expect(take(await matchBankStatement(db, 'acct_mobile', lines)).map((l) => l.state)).toEqual(['missing', 'missing']);
  expect(take(await matchBankStatement(db, 'acct_bank', [lines[0]!, lines[0]!])).map((l) => l.state)).toEqual(['duplicate', 'duplicate']);
  const preview = take(await matchBankStatement(db, 'acct_bank', lines));
  expect(preview.map((l) => l.state)).toEqual(['match', 'missing']);
  expect(take(await saveBankStatement(db, actor, 'acct_bank', lines, [statementLineKey(preview[0]!)]))).toBe(1);
  expect(take(await matchBankStatement(db, 'acct_bank', lines)).map((l) => l.state)).toEqual(['cleared', 'missing']);
  expect(await saveBankStatement(db, actor, 'acct_bank', lines, [statementLineKey(preview[0]!)] )).toEqual({ ok: false, error: 'changed' });
});

it('applies verified sibling and Zakat assistance by fee head with no fictional cash receipt', async () => {
  const sibling = form({ enrollmentId: 'e2', kind: 'sibling', siblingNo: 'MI-0001', reason: 'Reviewed test family', confirm: 'yes' });
  const grantId = take(await approveAssistance(db, actor, 's2', sibling));
  expect((await approveAssistance(db, actor, 's2', sibling)).ok).toBe(false);
  const l = (await getOfflineStudent(db, 's2', today))!.enrollments[0]!.ledger;
  expect(l.byKind.admission.totalMinor).toBe(75000);
  expect(l.byKind.fee.totalMinor).toBe(300000);
  expect((await revokeAssistance(db, actor, 's2', form({ grantId, reason: 'Test correction' }))).ok).toBe(true);
  expect((await getOfflineStudent(db, 's2', today))!.enrollments[0]!.ledger.totalMinor).toBe(750000);
  expect((await approveAssistance(db, actor, 's2', sibling)).ok).toBe(true);
  const grant = form({ enrollmentId: 'e3', kind: 'zakat', fundId: 'aid-zakat', reason: 'Test authorization', confirm: 'yes' });
  expect((await approveAssistance(db, actor, 's3', grant)).ok).toBe(false);
  grant.set('guardianConsent', 'yes');
  expect((await approveAssistance(db, actor, 's3', grant)).ok).toBe(true);
  expect((await getOfflineStudent(db, 's3', today))!.enrollments[0]!.ledger).toMatchObject({ paidMinor: 0, dueMinor: 0 });
  const preview = await billPreview(db, { title: 'Books', feeHead: 'books', amountMinor: 20000, dueDate: today, target: { kind: 'all', id: '' }, useConcessions: false }, today);
  expect(preview.find((l) => l.enrollmentId === 'e3')).toMatchObject({ skip: 'free', amountMinor: 0 });
  expect(preview.find((l) => l.enrollmentId === 'e2')).toMatchObject({ skip: '', amountMinor: 20000 });
  expect(await createExam(db, actor, { batchId: 'b1', title: 'Test Exam', subject: 'Test', examDate: today, startTime: '', feeTaka: 100, note: '' })).toMatchObject({ charged: 2, examinees: 3 });
});

it('enforces capacity, one active stay, and only one monthly residential bill across rooms', async () => {
  const room = take(await saveRoom(db, actor, form({ name: 'Room A', capacity: '1' })));
  const other = take(await saveRoom(db, actor, form({ name: 'Room B', capacity: '2' })));
  const id = take(await placeResident(db, actor, form({ studentNo: '1', roomId: room }), today));
  expect((await placeResident(db, actor, form({ studentNo: '2', roomId: room }), today)).ok).toBe(false);
  expect((await placeResident(db, actor, form({ studentNo: '1', roomId: other }), today)).ok).toBe(false);
  const charge = { enrollmentId: 'e1', stayId: id, period: '2026-11', dueDate: today, amount: '600', confirm: 'yes' };
  expect((await billResidence(db, actor, form(charge), today)).ok).toBe(true);
  expect((await releaseResident(db, actor, id, today)).ok).toBe(true);
  const second = take(await placeResident(db, actor, form({ studentNo: '1', roomId: other }), today));
  expect((await billResidence(db, actor, form({ ...charge, stayId: second }), today)).ok).toBe(false);
  expect((await residenceView(db)).stays.map((s) => s.endsOn)).toEqual([null, today]);
});

it('previews published results and promotes all chosen eligible students or nobody', async () => {
  await db.batch([
    db.prepare("INSERT INTO academic_sessions(id,name,starts_on,ends_on,status,created_by) VALUES('next','2027','2027-01-01','2027-12-31','planned','test')"),
    db.prepare("INSERT INTO academic_batch_sessions(batch_id,session_id,added_by) VALUES('b2','next','test')"),
  ]);
  const exam = (await createExam(db, actor, { batchId: 'b1', title: 'Final', subject: 'General', examDate: today, startTime: '', feeTaka: 0, note: '' }))!;
  const v = { examId: exam.id, batchId: 'b2', sessionId: 'next' };
  expect((await resultPromotionPreview(db, v)).ok).toBe(false);
  await configureAssessment(db, actor, exam.id, '100', '50', true);
  await recordExamMark(db, actor, exam.id, 'e1', '75', false, '');
  await recordExamMark(db, actor, exam.id, 'e2', '45', false, '');
  await recordExamMark(db, actor, exam.id, 'e3', '', true, '');
  expect((await publishAssessment(db, actor, exam.id)).ok).toBe(true);
  expect(take(await resultPromotionPreview(db, v)).filter(eligibleForResultPromotion).map((r) => r.enrollmentId)).toEqual(['e1']);
  expect((await approveResultPromotions(db, actor, v, ['e1', 'e2'])).ok).toBe(false);
  expect(take(await approveResultPromotions(db, actor, v, ['e1']))).toBe(1);
  expect((await approveResultPromotions(db, actor, v, ['e1'])).ok).toBe(false);
  expect(await db.prepare('SELECT qualifying_exam_id, reviewed_application FROM academic_promotions').first()).toEqual({ qualifying_exam_id: exam.id, reviewed_application: 1 });
});
