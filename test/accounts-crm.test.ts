import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  balancesAsOf,
  budgetVsActual,
  fundSummary,
  GENERAL_FUND,
  newExpenseStage,
  projectSummary,
  receiptsAndPayments,
  recordEntry,
  saveAccount,
  saveBudget,
  saveFund,
  saveProject,
  saveReconciliation,
  setCourseProject,
  transactions,
  voidEntry,
  type EntryInput,
} from '../src/server/accounts';
import { decideExpense, getExpense, recordExpense } from '../src/server/office';
import { createOfflineCourse, createOfflineStudent, enrollOffline, recordPayment } from '../src/server/offline';
import {
  addFollowup,
  closeFollowup,
  engagementReport,
  followupCounts,
  listContacts,
  logContact,
  renderTemplate,
  setTags,
  studentTimeline,
  tagsOf,
} from '../src/server/crm';
import { sendMessage } from '../src/server/notifications';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-10';

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM portal_notifications'),
    db.prepare('DELETE FROM crm_contacts'),
    db.prepare('DELETE FROM crm_followups'),
    db.prepare('DELETE FROM crm_tags'),
    db.prepare('DELETE FROM crm_templates'),
    db.prepare('DELETE FROM offline_charges'),
    db.prepare('DELETE FROM offline_attendance'),
    db.prepare('DELETE FROM offline_payments'),
    db.prepare('DELETE FROM offline_enrollments'),
    db.prepare('DELETE FROM offline_students'),
    db.prepare('UPDATE offline_courses SET project_id = NULL'),
    db.prepare('DELETE FROM offline_courses'),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM acc_reconciliations'),
    db.prepare('DELETE FROM acc_entries'),
    db.prepare('DELETE FROM acc_budgets'),
    db.prepare('DELETE FROM acc_projects'),
    db.prepare(`DELETE FROM acc_funds WHERE id <> '${GENERAL_FUND}'`),
    db.prepare(`DELETE FROM acc_accounts WHERE id NOT IN ('acct_cash', 'acct_bank', 'acct_mobile', 'acct_online')`),
    db.prepare(`UPDATE acc_accounts SET opening_minor = 0, opening_on = '', methods = CASE id WHEN 'acct_cash' THEN 'cash,other' WHEN 'acct_bank' THEN 'bank' WHEN 'acct_mobile' THEN 'bkash,nagad,rocket' ELSE 'online' END`),
  ]);
});

async function studentWithFee(feeTaka = 12000) {
  const courseId = await createOfflineCourse(db, ACTOR, { title: 'Hifz', feeTaka, admissionTaka: 0, durationMonths: 12, note: '', status: 'active' });
  const studentId = await createOfflineStudent(db, ACTOR, { name: 'Abdullah (Test)', phone: '01711000000', guardianPhone: '01811000000', address: '', note: '', email: '' });
  const enrollmentId = (await enrollOffline(db, ACTOR, studentId, { courseId, batchId: null, roll: '', startDate: '2026-01-01', discountTaka: 0, planMonths: 1, note: '' }))!;
  return { courseId, studentId, enrollmentId };
}

const income = (over: Partial<EntryInput> = {}): EntryInput => ({
  kind: 'income', day: today, amountMinor: 50_000_00, accountId: 'acct_bank', fromAccountId: null, projectId: null, fundId: GENERAL_FUND,
  category: 'অনুদান বা গ্রান্ট', party: 'Test donor org', description: '', reference: '', nonce: null, ...over,
});

describe('accounts: balances, funds, projects', () => {
  it('puts fees and expenses into the account of their payment method and moves transfers', async () => {
    const { enrollmentId } = await studentWithFee();
    await recordPayment(db, ACTOR, enrollmentId, { amountTaka: 1000, paidOn: today, method: 'cash', reference: '', note: '', nonce: null }, today);
    await recordPayment(db, ACTOR, enrollmentId, { amountTaka: 500, paidOn: today, method: 'bkash', reference: '', note: '', nonce: null }, today);
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Electricity', amountTaka: 300, description: '', method: 'cash', nonce: null }, null);
    const t = await recordEntry(db, ACTOR, { ...income(), kind: 'transfer', amountMinor: 200_00, accountId: 'acct_bank', fromAccountId: 'acct_cash', category: 'স্থানান্তর', fundId: null });
    expect(t.ok).toBe(true);
    const b = new Map((await balancesAsOf(db, today)).map((x) => [x.id, x.balanceMinor]));
    expect(b.get('acct_cash')).toBe(1000_00 - 300_00 - 200_00);
    expect(b.get('acct_mobile')).toBe(500_00);
    expect(b.get('acct_bank')).toBe(200_00);
    // Before the day nothing was there.
    expect((await balancesAsOf(db, '2026-11-09')).reduce((a, x) => a + x.balanceMinor, 0)).toBe(0);
  });

  it('gives running voucher numbers per kind, saves once per form, and voids with a reason', async () => {
    const nonce = crypto.randomUUID();
    const a = await recordEntry(db, ACTOR, income({ nonce }));
    const again = await recordEntry(db, ACTOR, income({ nonce }));
    const b = await recordEntry(db, ACTOR, income());
    expect(a.ok && again.ok && b.ok).toBe(true);
    if (!a.ok || !again.ok || !b.ok) return;
    expect(again.value.id).toBe(a.value.id);
    expect([a.value.voucherNo, b.value.voucherNo]).toEqual([1, 2]);
    expect(await voidEntry(db, ACTOR, a.value.id, '')).toBe(false);
    expect(await voidEntry(db, ACTOR, a.value.id, 'entered twice')).toBe(true);
    const bank = (await balancesAsOf(db, today)).find((x) => x.id === 'acct_bank')!;
    expect(bank.balanceMinor).toBe(50_000_00);
  });

  it('expenses get debit voucher numbers', async () => {
    const x = await recordExpense(db, ACTOR, { spentOn: today, category: 'Rent', amountTaka: 100, description: '', method: 'cash', nonce: null }, null);
    const y = await recordExpense(db, ACTOR, { spentOn: today, category: 'Rent', amountTaka: 100, description: '', method: 'cash', nonce: null }, null);
    expect((await getExpense(db, x))!.voucherNo).toBe(1);
    expect((await getExpense(db, y))!.voucherNo).toBe(2);
  });

  it('keeps fund and project ledgers apart', async () => {
    const zakat = await saveFund(db, ACTOR, null, { name: 'Zakat fund', kind: 'zakat', restricted: true, note: '', status: 'active' });
    const hifz = await saveProject(db, ACTOR, null, { name: 'Hifz department', note: '', status: 'active' });
    expect(zakat.ok && hifz.ok).toBe(true);
    if (!zakat.ok || !hifz.ok) return;
    const { courseId, enrollmentId } = await studentWithFee();
    expect(await setCourseProject(db, ACTOR, courseId, hifz.value)).toBe(true);
    await recordPayment(db, ACTOR, enrollmentId, { amountTaka: 1000, paidOn: today, method: 'cash', reference: '', note: '', nonce: null }, today);
    await recordEntry(db, ACTOR, income({ amountMinor: 3000_00, fundId: zakat.value }));
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Student food', amountTaka: 1200, description: '', method: 'bank', nonce: null, fundId: zakat.value, projectId: hifz.value }, null);
    const funds = new Map((await fundSummary(db, today, today)).map((f) => [f.id, f]));
    expect(funds.get(zakat.value)!.balanceMinor).toBe(1800_00);
    expect(funds.get(GENERAL_FUND)!.balanceMinor).toBe(1000_00);
    const projects = new Map((await projectSummary(db, today, today)).map((p) => [p.id, p]));
    expect(projects.get(hifz.value)).toMatchObject({ inMinor: 1000_00, outMinor: 1200_00 });
  });

  it('a method belongs to one account only', async () => {
    const r = await saveAccount(db, ACTOR, null, { name: 'bKash merchant', kind: 'mobile', methods: ['bkash'], numberHint: '', openingMinor: 500_00, openingOn: '2026-11-01', status: 'active' });
    expect(r.ok).toBe(true);
    const mobile = await db.prepare("SELECT methods FROM acc_accounts WHERE id = 'acct_mobile'").first<{ methods: string }>();
    expect(mobile!.methods).toBe('nagad,rocket');
    const b = (await balancesAsOf(db, today)).find((x) => r.ok && x.id === r.value)!;
    expect(b.balanceMinor).toBe(500_00);
  });

  it('the receipts and payments statement balances with the accounts', async () => {
    const { enrollmentId } = await studentWithFee();
    await recordPayment(db, ACTOR, enrollmentId, { amountTaka: 2000, paidOn: '2026-10-05', method: 'cash', reference: '', note: '', nonce: null }, today);
    await recordPayment(db, ACTOR, enrollmentId, { amountTaka: 1000, paidOn: today, method: 'bank', reference: '', note: '', nonce: null }, today);
    await recordEntry(db, ACTOR, income({ amountMinor: 700_00 }));
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Books', amountTaka: 400, description: '', method: 'cash', nonce: null }, null);
    const s = await receiptsAndPayments(db, '2026-11-01', today);
    expect(s.openingMinor).toBe(2000_00);
    expect(s.receiptsMinor).toBe(1700_00);
    expect(s.paymentsMinor).toBe(400_00);
    expect(s.closingMinor).toBe(s.openingMinor + s.receiptsMinor - s.paymentsMinor);
    const txns = await transactions(db, '2026-11-01', today);
    expect(txns.map((t) => t.source).sort()).toEqual(['expense', 'fee', 'income']);
  });

  it('budget against approved spending only', async () => {
    const p = await saveProject(db, ACTOR, null, { name: 'Building', note: '', status: 'active' });
    if (!p.ok) throw new Error('project');
    await saveBudget(db, ACTOR, { year: '2026', projectId: p.value, category: '', amountMinor: 1000_00, note: '' });
    await saveBudget(db, ACTOR, { year: '2026', projectId: '', category: 'Rent', amountMinor: 500_00, note: '' });
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Cement', amountTaka: 800, description: '', method: 'cash', nonce: null, projectId: p.value }, null);
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Cement', amountTaka: 900, description: '', method: 'cash', nonce: null, projectId: p.value }, null, 'pending');
    await recordExpense(db, ACTOR, { spentOn: today, category: 'Rent', amountTaka: 600, description: '', method: 'cash', nonce: null }, null);
    const lines = await budgetVsActual(db, '2026', today);
    const building = lines.find((l) => l.projectId === p.value)!;
    const rent = lines.find((l) => l.category === 'Rent')!;
    expect(building.actualMinor).toBe(800_00);
    expect(rent).toMatchObject({ actualMinor: 600_00, varianceMinor: -100_00, usedPercent: 120 });
  });

  it('reconciliation stores the difference against the books', async () => {
    await recordEntry(db, ACTOR, income({ accountId: 'acct_cash', amountMinor: 1000_00 }));
    const r = await saveReconciliation(db, ACTOR, { accountId: 'acct_cash', asOf: today, statementMinor: 990_00, note: 'counted' });
    expect(r.ok && r.value.bookMinor).toBe(1000_00);
  });
});

describe('two step expense approval', () => {
  const rules = { approvalOver: 2000, ownerOver: 25000 };
  it('decides the stage from the amount and who records it', () => {
    expect(newExpenseStage(500, { owner: false, full: false }, rules)).toBe('approved');
    expect(newExpenseStage(5000, { owner: false, full: false }, rules)).toBe('pending');
    expect(newExpenseStage(5000, { owner: false, full: true }, rules)).toBe('approved');
    expect(newExpenseStage(30000, { owner: false, full: true }, rules)).toBe('checked');
    expect(newExpenseStage(30000, { owner: false, full: false }, rules)).toBe('pending');
    expect(newExpenseStage(30000, { owner: true, full: true }, rules)).toBe('approved');
  });

  it('needs the accountant then the owner, and nobody approves their own', async () => {
    const id = await recordExpense(db, 'clerk@example.org', { spentOn: today, category: 'Roof', amountTaka: 30000, description: '', method: 'bank', nonce: null }, null, 'pending');
    const accountant = { owner: false, full: true };
    expect(await decideExpense(db, 'clerk@example.org', id, 'approved', accountant, 25000)).toBe('self');
    expect(await decideExpense(db, 'acc@example.org', id, 'approved', accountant, 25000)).toBe('checked');
    expect(await decideExpense(db, 'acc2@example.org', id, 'approved', accountant, 25000)).toBe('owner');
    expect((await getExpense(db, id))!.status).toBe('pending');
    expect(await decideExpense(db, ACTOR, id, 'approved', { owner: true, full: true }, 25000)).toBe('approved');
    const e = (await getExpense(db, id))!;
    expect(e.status).toBe('approved');
    expect(e.checkedBy).toBe('acc@example.org');
  });
});

describe('student CRM', () => {
  it('tags, follow ups, contacts and the timeline', async () => {
    const { studentId, enrollmentId } = await studentWithFee();
    expect(await setTags(db, ACTOR, studentId, ['এতিম', 'হিফজ'])).toBe(true);
    await setTags(db, ACTOR, studentId, ['হিফজ', 'আবাসিক']);
    expect(await tagsOf(db, studentId)).toEqual(['আবাসিক', 'হিফজ']);

    const f = await addFollowup(db, ACTOR, { title: 'Call about dues', dueOn: '2026-11-09', assignedTo: '', studentId, inquiryId: null });
    expect(f.ok).toBe(true);
    expect(await followupCounts(db, today)).toEqual({ overdue: 1, today: 0, upcoming: 0 });
    if (f.ok) expect(await closeFollowup(db, ACTOR, f.value, 'done', 'Will pay Monday', 'call')).toBe(true);
    if (f.ok) expect(await closeFollowup(db, ACTOR, f.value, 'done', 'again')).toBe(false);
    await logContact(db, ACTOR, { studentId, inquiryId: null, channel: 'visit', direction: 'in', summary: 'Father came to office' });
    const contacts = await listContacts(db, { studentId });
    expect(contacts.map((c) => c.channel).sort()).toEqual(['call', 'visit']);

    const pay = await recordPayment(db, ACTOR, enrollmentId, { amountTaka: 1000, paidOn: today, method: 'cash', reference: '', note: '', nonce: null }, today);
    expect(pay.ok).toBe(true);
    // The digital receipt went to the portal.
    const n = await db.prepare('SELECT link FROM portal_notifications WHERE offline_student_id = ?').bind(studentId).first<{ link: string }>();
    expect(n?.link).toBe(`/account/offline/receipt/${pay.ok ? pay.id : ''}`);

    const kinds = (await studentTimeline(db, studentId)).map((t) => t.kind);
    for (const k of ['ভর্তি', 'পেমেন্ট', 'যোগাযোগ', 'ফলো আপ', 'নোটিফিকেশন']) expect(kinds).toContain(k);
    const report = await engagementReport(db, today);
    expect(report.followups.done30).toBe(1);
  });

  it('a group message to a tag reaches only those students, personalised, and is logged', async () => {
    const { studentId } = await studentWithFee();
    const other = await createOfflineStudent(db, ACTOR, { name: 'Maryam (Test)', phone: '01711000001', guardianPhone: '', address: '', note: '', email: '' });
    const course = await db.prepare('SELECT id FROM offline_courses LIMIT 1').first<{ id: string }>();
    await enrollOffline(db, ACTOR, other, { courseId: course!.id, batchId: null, roll: '', startDate: '2026-01-01', discountTaka: 0, planMonths: 1, note: '' });
    await setTags(db, ACTOR, studentId, ['এতিম']);
    const r = await sendMessage(db, env, ACTOR, { audience: 'tag', targetId: 'এতিম', title: 'আসসালামু আলাইকুম {name}', body: 'আইডি {id}', sms: false });
    expect(r.ok && r.value.people).toBe(1);
    const n = await db.prepare('SELECT title, offline_student_id AS sid FROM portal_notifications').all<{ title: string; sid: string }>();
    expect(n.results).toEqual([{ title: 'আসসালামু আলাইকুম Abdullah (Test)', sid: studentId }]);
    expect((await listContacts(db, { studentId })).map((c) => c.channel)).toEqual(['portal']);
  });

  it('fills a template', () => {
    expect(renderTemplate('{name} ({id}) owes {due} for {course}', { name: 'A', id: 'MI-0001', course: 'Hifz', class: '', due: '৳500', date: '' })).toBe('A (MI-0001) owes ৳500 for Hifz');
  });
});
