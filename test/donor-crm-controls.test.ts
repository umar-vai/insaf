import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { closedThrough, closePeriod, reopenPeriod } from '../src/server/acc-period';
import { clearingView, consolidatedReport, MOVED_FROM_DONATIONS, restrictedFundShort, saveClearing } from '../src/server/acc-controls';
import { GENERAL_FUND, recordEntry, saveFund, voidEntry, type EntryInput } from '../src/server/accounts';
import { decideExpense, recordExpense, voidExpense } from '../src/server/office';
import {
  addDonorFollowup,
  closeDonorFollowup,
  donorDirectory,
  donorEngagement,
  donorTimeline,
  listDonorContacts,
  markReceiptSent,
  openDonorTicket,
  receiptMessage,
  renderDonorTemplate,
  replyDonorTicket,
  segmentOf,
  setDonorTags,
  thanksQueue,
} from '../src/server/donor-crm';

const db = env.DB;
const ACTOR = 'owner@example.org';
const today = '2026-11-20';
const PHONE = '01711000099';
const ORIGIN = 'https://example.test';

async function gift(ref: string, minor: number, paidAt: string, over: { phone?: string; status?: string; voided?: boolean } = {}) {
  await db
    .prepare(
      `INSERT INTO donations (id, reference, receipt_no, fund_id, amount_minor, donor_name, donor_phone, status, gateway, method, paid_at, voided_at)
       VALUES (?, ?, (SELECT coalesce(max(receipt_no), 0) + 1 FROM donations), 'tfund', ?, 'Test Donor', ?, ?, 'manual', 'cash', ?, ?)`,
    )
    .bind(`don_${ref}`, ref, minor, over.phone ?? PHONE, over.status ?? 'paid', paidAt, over.voided ? paidAt : null)
    .run();
}

const income = (over: Partial<EntryInput> = {}): EntryInput => ({
  kind: 'income', day: '2026-11-01', amountMinor: 1000_00, accountId: 'acct_bank', fromAccountId: null, projectId: null, fundId: GENERAL_FUND,
  category: 'ভাড়া আয়', party: '', description: '', reference: '', nonce: null, ...over,
});
const expense = (spentOn: string, amountTaka = 100, fundId: string | null = null) => ({ spentOn, category: 'Test', amountTaka, description: '', method: 'cash', nonce: null, fundId });

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM donation_events'),
    db.prepare('DELETE FROM donations'),
    db.prepare(`DELETE FROM funds WHERE id = 'tfund'`),
    db.prepare(`INSERT INTO funds (id, slug, title) VALUES ('tfund', 'tfund', 'Test Fund')`),
    db.prepare('DELETE FROM expenses'),
    db.prepare('DELETE FROM acc_entries'),
    db.prepare(`DELETE FROM acc_funds WHERE id <> '${GENERAL_FUND}'`),
  ]);
});

describe('donor CRM', () => {
  it('sorts donors into segments by their gifts', () => {
    expect(segmentOf({ gifts: 1, firstAt: '2026-11-10T00:00:00Z', lastAt: '2026-11-10T00:00:00Z' }, today)).toBe('new');
    expect(segmentOf({ gifts: 4, firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-10-01T00:00:00Z' }, today)).toBe('regular');
    expect(segmentOf({ gifts: 5, firstAt: '2024-01-01T00:00:00Z', lastAt: '2025-01-01T00:00:00Z' }, today)).toBe('lapsed');
    expect(segmentOf({ gifts: 1, firstAt: '2026-08-01T00:00:00Z', lastAt: '2026-08-01T00:00:00Z' }, today)).toBe('once');
  });

  it('counts only real gifts and filters by tag', async () => {
    await gift('DN-A', 500_00, '2026-11-10T06:00:00.000Z');
    await gift('DN-B', 900_00, '2026-11-11T06:00:00.000Z', { status: 'review' });
    await gift('DN-C', 700_00, '2026-11-12T06:00:00.000Z', { voided: true });
    expect(await setDonorTags(db, ACTOR, PHONE, ['যাকাত দাতা'])).toBe(true);
    const d = await donorDirectory(db, today, { tag: 'যাকাত দাতা' });
    expect(d.rows).toHaveLength(1);
    expect(d.rows[0]!.totalMinor).toBe(500_00);
    expect((await donorDirectory(db, today, { tag: 'নেই' })).rows).toHaveLength(0);
  });

  it('refuses CRM records for someone who never gave', async () => {
    expect(await setDonorTags(db, ACTOR, '01999999999', ['x y'])).toBe(false);
    expect(await addDonorFollowup(db, ACTOR, '01999999999', { title: 'call', dueOn: today, assignedTo: '' })).toBe(false);
  });

  it('sends a receipt only for a counted gift, and logs it once', async () => {
    await gift('DN-PAID', 500_00, '2026-11-10T06:00:00.000Z');
    await gift('DN-HOLD', 500_00, '2026-11-10T06:00:00.000Z', { status: 'review' });
    expect((await thanksQueue(db, today)).map((t) => t.reference)).toEqual(['DN-PAID']);
    expect(await receiptMessage(db, 'DN-HOLD', ORIGIN, today)).toBeNull();
    expect(await markReceiptSent(db, ACTOR, 'DN-HOLD', 'whatsapp', ORIGIN, today)).toBe(false);
    const m = await receiptMessage(db, 'DN-PAID', ORIGIN, today);
    expect(m?.message).toContain('RCP-');
    expect(m?.message).toContain(`${ORIGIN}/donate/done?ref=DN-PAID`);
    await markReceiptSent(db, ACTOR, 'DN-PAID', 'whatsapp', ORIGIN, today);
    await markReceiptSent(db, ACTOR, 'DN-PAID', 'whatsapp', ORIGIN, today);
    expect(await listDonorContacts(db, { key: PHONE })).toHaveLength(1);
    expect(await thanksQueue(db, today)).toHaveLength(0);
  });

  it('keeps people who asked not to be contacted out of the receipt queue', async () => {
    await gift('DN-Q', 500_00, '2026-11-10T06:00:00.000Z');
    await db.prepare(`INSERT INTO donor_profiles (donor_key, do_not_contact, updated_by) VALUES (?, 1, ?)`).bind(PHONE, ACTOR).run();
    expect(await thanksQueue(db, today)).toHaveLength(0);
  });

  it('puts gifts, follow ups and tickets on one timeline', async () => {
    await gift('DN-T', 500_00, '2026-11-10T06:00:00.000Z');
    await addDonorFollowup(db, ACTOR, PHONE, { title: 'Call back', dueOn: today, assignedTo: '' });
    const { results } = await db.prepare('SELECT id FROM donor_followups').all<{ id: string }>();
    expect(await closeDonorFollowup(db, ACTOR, results[0]!.id, 'done', 'spoke', 'call')).toBe(true);
    const t = await openDonorTicket(db, ACTOR, PHONE, { subject: 'Receipt missing', category: 'receipt', body: 'please resend', assignedTo: '' });
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(await replyDonorTicket(db, ACTOR, t.value, 'sent again', true)).toBe(true);
      expect(await replyDonorTicket(db, ACTOR, t.value, 'too late', false)).toBe(false);
    }
    const kinds = new Set((await donorTimeline(db, PHONE)).map((i) => i.kind));
    expect([...kinds].sort()).toEqual(['টিকেট', 'দান', 'ফলো আপ', 'যোগাযোগ'].sort());
  });

  it('reports how many of last year\'s donors gave again', async () => {
    await gift('DN-Y1', 100_00, '2025-05-01T06:00:00.000Z');
    await gift('DN-Y2', 100_00, '2026-05-01T06:00:00.000Z');
    await gift('DN-Z1', 100_00, '2025-05-01T06:00:00.000Z', { phone: '01811000088' });
    const r = await donorEngagement(db, today);
    expect(r.retention).toEqual({ lastYear: 2, kept: 1, percent: 50 });
  });

  it('fills a template and leaves other braces alone', () => {
    expect(renderDonorTemplate('{name} {amount} {other}', { name: 'A', amount: '৳1' })).toBe('A ৳1 {other}');
  });
});

describe('accounting controls', () => {
  it('blocks every change inside a closed period until an owner reopens', async () => {
    const e = await recordEntry(db, ACTOR, income());
    const spent = await recordExpense(db, ACTOR, expense('2026-11-02'), null);
    expect((await closePeriod(db, ACTOR, '2026-11-05', today, 'month end')).ok).toBe(true);
    expect(await closedThrough(db)).toBe('2026-11-05');
    expect(await recordEntry(db, ACTOR, income({ day: '2026-11-03' }))).toEqual({ ok: false, error: 'closed' });
    await expect(recordExpense(db, ACTOR, expense('2026-11-03'), null)).rejects.toThrow('period_closed');
    expect(await voidExpense(db, ACTOR, spent, 'wrong')).toBe(false);
    if (e.ok) expect(await voidEntry(db, ACTOR, e.value.id, 'wrong')).toBe(false);
    expect((await recordEntry(db, ACTOR, income({ day: '2026-11-06' }))).ok).toBe(true);
    expect((await reopenPeriod(db, ACTOR, 'found a mistake')).ok).toBe(true);
    expect(await voidExpense(db, ACTOR, spent, 'wrong')).toBe(true);
  });

  it('will not close today, a day already closed, or a period with expenses waiting', async () => {
    expect(await closePeriod(db, ACTOR, today, today, '')).toEqual({ ok: false, error: 'day' });
    const waiting = await recordExpense(db, ACTOR, expense('2026-11-02'), null, 'pending');
    expect(await closePeriod(db, ACTOR, '2026-11-05', today, '')).toEqual({ ok: false, error: 'pending' });
    await decideExpense(db, ACTOR, waiting, 'approved');
    expect((await closePeriod(db, ACTOR, '2026-11-05', today, '')).ok).toBe(true);
    expect(await closePeriod(db, ACTOR, '2026-11-04', today, '')).toEqual({ ok: false, error: 'already' });
  });

  it('finds spending past a restricted fund but not an ordinary one', async () => {
    const z = await saveFund(db, ACTOR, null, { name: 'Zakat test', kind: 'zakat', restricted: true, note: '', status: 'active' });
    expect(z.ok).toBe(true);
    if (!z.ok) return;
    await recordEntry(db, ACTOR, income({ fundId: z.value, amountMinor: 500_00 }));
    expect(await restrictedFundShort(db, z.value, 400_00, today)).toBeNull();
    expect((await restrictedFundShort(db, z.value, 700_00, today))?.shortMinor).toBe(200_00);
    expect(await restrictedFundShort(db, GENERAL_FUND, 999_999_00, today)).toBeNull();
  });

  it('works out what the statement should show from uncleared lines', async () => {
    const a = await recordEntry(db, ACTOR, income({ amountMinor: 1000_00 }));
    await recordEntry(db, ACTOR, income({ amountMinor: 300_00, day: '2026-11-02' }));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await saveClearing(db, ACTOR, 'acct_bank', [`income:${a.value.id}`], [`income:${a.value.id}`], today);
    const v = await clearingView(db, 'acct_bank', today);
    expect(v.bookMinor).toBe(1300_00);
    expect(v.unclearedIn).toBe(300_00);
    expect(v.expectedStatementMinor).toBe(1000_00);
    await saveClearing(db, ACTOR, 'acct_bank', [`income:${a.value.id}`], [], today);
    expect((await clearingView(db, 'acct_bank', today)).unclearedIn).toBe(1300_00);
  });

  it('never counts money moved from donations twice', async () => {
    await gift('DN-C1', 5000_00, '2026-11-10T06:00:00.000Z');
    await gift('DN-C2', 999_00, '2026-11-10T06:00:00.000Z', { status: 'review' });
    await recordEntry(db, ACTOR, income({ category: MOVED_FROM_DONATIONS, amountMinor: 2000_00, day: '2026-11-11' }));
    await recordEntry(db, ACTOR, income({ category: 'ভাড়া আয়', amountMinor: 100_00, day: '2026-11-11' }));
    await recordExpense(db, ACTOR, expense('2026-11-12', 50), null);
    const r = await consolidatedReport(db, '2026-11-01', '2026-11-30');
    expect(r.donationsMinor).toBe(5000_00);
    expect(r.movedMinor).toBe(2000_00);
    expect(r.otherMinor).toBe(100_00);
    expect(r.incomeMinor).toBe(5100_00);
    expect(r.netMinor).toBe(5050_00);
  });
});
