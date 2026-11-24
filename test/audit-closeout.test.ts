import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { addBatchTeacher } from '../src/server/academic';
import { admissionQueue } from '../src/server/admission-queue';
import { clearAdmissionDraft, readAdmissionDraft, saveAdmissionDraft } from '../src/server/admission-draft';
import { assignExamAssessor, configureAssessment, publishAssessment, reviewAssessment, saveExamMarks, submitAssessment, teacherCanGrade } from '../src/server/assessment';
import { bankDeliveries, receiveBankDelivery } from '../src/server/bank-feed';
import { hmacHex } from '../src/server/crypto';
import { createInquiry } from '../src/server/inquiries';
import { archiveMedia, restoreArchivedObject } from '../src/server/media-backup';
import { admitOfflineStudent } from '../src/server/offline';
import { getExpense, recordExpense } from '../src/server/office';
import { allocateStudentCosts, costPreview, costsOfStudent } from '../src/server/student-costs';
import { clearanceKey, transferClearance } from '../src/server/transfer-clearance';

const db = env.DB;
const actor = 'office-audit@example.org';
const day = '2026-11-24';
const secrets = 'synthetic test key for isolated repository tests';
const insert = (sql: string) => db.prepare(sql).run();

it('saves an opt-in draft without ID or signatures and binds it to the browser', async () => {
  const request = new Request('https://local.test/admission/draft');
  const form = new FormData();
  for (const [k, v] of Object.entries({ studentName: 'Test child', guardianNid: '1234567890', phone: '01900000001', guardianSignName: 'Signature', curSame: 'on' })) form.set(k, v);
  const cookie = await saveAdmissionDraft(db, secrets, request, form);
  const row = await db.prepare('SELECT fields FROM admission_drafts').first<{ fields: string }>();
  expect(row?.fields).not.toContain('Test child');
  expect(cookie).toContain('HttpOnly; SameSite=Strict; Max-Age=172800; Secure');
  const next = new Request('https://local.test/admission/apply', { headers: { Cookie: cookie.split(';')[0]! } });
  expect(await readAdmissionDraft(db, secrets, request)).toBeNull();
  expect(await readAdmissionDraft(db, secrets, next)).toEqual({ studentName: 'Test child', phone: '01900000001', curSame: 'on' });
  await clearAdmissionDraft(db, secrets, next);
  expect(await readAdmissionDraft(db, secrets, next)).toBeNull();
});

it('converts an inquiry once and keeps a single linked row in the intake queue', async () => {
  await insert("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('audit-intake','Intake',50000,1)");
  await insert("INSERT INTO offline_batches(id,course_id,name) VALUES('audit-intake-b','audit-intake','Group')");
  const id = await createInquiry(db, { studentName: 'Intake test', guardianName: '', phone: '01901010001', desiredClass: '', message: '' });
  const student = { name: 'Intake test', phone: '01901010001', guardianPhone: '', email: '', address: '', note: '' };
  const enrollment = { courseId: 'audit-intake', batchId: 'audit-intake-b', roll: '', startDate: day, discountTaka: 0, planMonths: 1, note: '' };
  const first = await admitOfflineStudent(db, actor, student, enrollment, id);
  expect(first).not.toBeNull();
  expect(await admitOfflineStudent(db, actor, student, enrollment, id)).toBeNull();
  const entries = await admissionQueue(db, '', student.phone);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ source: 'inquiry', studentId: first, status: 'admitted' });
});

it('restricts subject marking and enforces submit, review and publish in order', async () => {
  await db.batch([
    db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('audit-grade','Grade',0,1)"),
    db.prepare("INSERT INTO teachers(id,name,phone) VALUES('audit-main','Primary','01901010002'),('audit-sub','Subject','01901010003')"),
    db.prepare("INSERT INTO offline_batches(id,course_id,name,teacher_id,days,start_time,end_time) VALUES('audit-grade-b','audit-grade','Exam Batch','audit-main','1','09:00','10:00'),('audit-conflict','audit-grade','Conflict',NULL,'1','09:30','10:30')"),
    db.prepare("INSERT INTO offline_students(id,name,phone) VALUES('audit-grade-s','Test pupil','01901010004')"),
    db.prepare("INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,start_date,fee_minor,duration_months,plan_months) VALUES('audit-grade-e','audit-grade-s','audit-grade','audit-grade-b','2026-01-01',0,1,1)"),
    db.prepare("INSERT INTO offline_exams(id,batch_id,title,subject,exam_date,created_by) VALUES('audit-exam','audit-grade-b','History','History','2026-11-24','test')"),
  ]);
  expect(await addBatchTeacher(db, actor, 'audit-grade-b', 'audit-sub', 'History')).toBe(true);
  expect(await addBatchTeacher(db, actor, 'audit-conflict', 'audit-sub', 'History')).toBe(false);
  expect(await teacherCanGrade(db, 'audit-exam', 'audit-main')).toBe(false);
  expect(await teacherCanGrade(db, 'audit-exam', 'audit-sub')).toBe(true);
  expect((await assignExamAssessor(db, actor, 'audit-exam', 'audit-sub')).ok).toBe(true);
  expect((await configureAssessment(db, actor, 'audit-exam', '100', '40', true)).ok).toBe(true);
  const rows = [{ enrollmentId: 'audit-grade-e', obtained: '85', absent: false, comment: '' }];
  expect((await saveExamMarks(db, actor, 'audit-exam', rows, 'audit-main')).ok).toBe(false);
  expect((await saveExamMarks(db, actor, 'audit-exam', rows, 'audit-sub')).ok).toBe(true);
  expect((await publishAssessment(db, actor, 'audit-exam', true)).ok).toBe(false);
  expect((await submitAssessment(db, actor, 'audit-exam', 'audit-sub')).ok).toBe(true);
  expect((await saveExamMarks(db, actor, 'audit-exam', rows, 'audit-sub')).ok).toBe(false);
  expect((await publishAssessment(db, actor, 'audit-exam', true)).ok).toBe(false);
  expect((await reviewAssessment(db, actor, 'audit-exam', false, 'Check recorded mark')).ok).toBe(true);
  expect((await submitAssessment(db, actor, 'audit-exam', 'audit-sub')).ok).toBe(true);
  expect((await reviewAssessment(db, actor, 'audit-exam', true, 'Checked')).ok).toBe(true);
  expect((await publishAssessment(db, actor, 'audit-exam', true)).ok).toBe(true);
});

it('allocates every poisha once while preserving the original expense and clearance snapshot', async () => {
  await db.batch([
    db.prepare("INSERT INTO offline_courses(id,title,fee_minor,duration_months) VALUES('audit-cost','Cost',0,1)"),
    db.prepare("INSERT INTO offline_batches(id,course_id,name) VALUES('audit-cost-b','audit-cost','Cost Batch')"),
    db.prepare("INSERT INTO offline_students(id,name,phone) VALUES('audit-cost-s1','One','01901010010'),('audit-cost-s2','Two','01901010011'),('audit-cost-s3','Three','01901010012')"),
    db.prepare(`INSERT INTO offline_enrollments(id,student_id,course_id,batch_id,start_date,fee_minor,duration_months,plan_months)
       SELECT id || '-e', id, 'audit-cost', 'audit-cost-b', '2026-10-01', 0, 1, 1 FROM offline_students WHERE id LIKE 'audit-cost-s%'`),
  ]);
  const expenseId = await recordExpense(db, actor, { spentOn: day, category: 'Class supplies', amountTaka: 10, description: '', method: 'cash', nonce: null }, null);
  const preview = await costPreview(db, expenseId, 'audit-cost-b');
  expect(preview?.shares.map((r) => r.amount)).toEqual([334, 333, 333]);
  expect((await allocateStudentCosts(db, actor, expenseId, 'audit-cost-b', 'stale', 'Reviewed')).ok).toBe(false);
  expect((await allocateStudentCosts(db, actor, expenseId, 'audit-cost-b', preview!.key, 'Reviewed')).ok).toBe(true);
  expect((await allocateStudentCosts(db, actor, expenseId, 'audit-cost-b', preview!.key, 'Reviewed')).ok).toBe(false);
  expect(await costsOfStudent(db, 'audit-cost-s1')).toMatchObject([{ id: expenseId, amount: 334, shared: 1 }]);
  expect((await getExpense(db, expenseId))?.amountMinor).toBe(1000);
  const clearance = (await transferClearance(db, 'audit-cost-s1', day))!;
  expect(clearance).toMatchObject({ balanceMinor: 0, books: [] });
  expect(await clearanceKey(clearance)).not.toBe(await clearanceKey({ ...clearance, balanceMinor: 1 }));
});

it('authenticates bank deliveries, rejects changed replays and writes only to review', async () => {
  const secs = 1795500000;
  const payload = { accountId: 'acct_bank', csv: 'date,reference,credit,debit\n2026-11-24,AUDIT-FEED01,100.50,' };
  const request = async (data: typeof payload, signature?: string) => {
    const id = 'audit-feed-2026-11-24';
    const body = JSON.stringify(data);
    return new Request('https://local.test/integrations/bank-statement', { method: 'POST', body, headers: {
      'X-Statement-Timestamp': String(secs), 'X-Statement-Id': id, 'X-Statement-Signature': signature ?? await hmacHex(secrets, `${secs}.${id}.${body}`),
    } });
  };
  const config = { secret: secrets, accounts: 'acct_bank' };
  expect((await receiveBankDelivery(db, {}, await request(payload), day, secs)).status).toBe(404);
  expect((await receiveBankDelivery(db, config, await request(payload, 'a'.repeat(64)), day, secs)).status).toBe(401);
  expect((await receiveBankDelivery(db, config, await request(payload), day, secs)).status).toBe(202);
  expect((await receiveBankDelivery(db, config, await request(payload), day, secs)).status).toBe(200);
  expect((await receiveBankDelivery(db, config, await request({ ...payload, csv: payload.csv.replace('100.50', '95.00') }), day, secs)).status).toBe(409);
  expect(await bankDeliveries(db)).toContainEqual(expect.objectContaining({ csv: payload.csv }));
  expect(await db.prepare("SELECT 1 FROM acc_cleared_items WHERE statement_reference = 'AUDIT-FEED01'").first()).toBeNull();
});

it('backs up media and restores verified bytes to a separate location', async () => {
  const archive = (env as typeof env & { BACKUPS: R2Bucket }).BACKUPS;
  const key = 'private/vouchers/audit-closeout-synthetic.txt';
  const destination = 'drill/audit-closeout-synthetic.txt';
  await env.MEDIA.put(key, 'Synthetic media only', { httpMetadata: { contentType: 'text/plain' } });
  const manifest = await archiveMedia(env.MEDIA, archive, new Date(day + 'T18:15:00Z'));
  const item = manifest.files.find((f) => f.key === key)!;
  expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await restoreArchivedObject(archive, env.MEDIA, { ...item, sha256: '0'.repeat(64) }, destination)).toBe(false);
  expect(await restoreArchivedObject(archive, env.MEDIA, item, destination)).toBe(true);
  const restored = await env.MEDIA.get(destination);
  expect(restored?.httpMetadata?.contentType).toBe('text/plain');
  expect(await restored?.text()).toBe('Synthetic media only');
  expect(await restoreArchivedObject(archive, env.MEDIA, item, destination)).toBe(false);
});
