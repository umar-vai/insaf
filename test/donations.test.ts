import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyDonationValidation,
  createDonation,
  decideReview,
  donationByReference,
  donorHistory,
  isDonationReference,
  listDonors,
  listFunds,
  markDonationUnpaid,
  monthlyTotals,
  parseDonationForm,
  parseManualForm,
  recentGifts,
  recordManualDonation,
  voidDonation,
} from '../src/server/donations';
import type { Validation } from '../src/server/sslcommerz';

const db = env.DB;
const ACTOR = 'office@example.org';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const valid = (reference: string, amount: string, extra: Partial<Validation> = {}): Validation => ({
  status: 'VALID',
  tran_id: reference,
  val_id: 'v1',
  amount,
  currency: 'BDT',
  bank_tran_id: 'b1',
  card_type: 'BKASH-BKash',
  risk_level: '0',
  ...extra,
});

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM donation_events'),
    db.prepare('DELETE FROM donations'),
    db.prepare('DELETE FROM fund_updates'),
    db.prepare('DELETE FROM funds'),
    db.prepare('DELETE FROM admin_events'),
    db.prepare(
      `INSERT INTO funds (id, slug, title, goal_minor, position) VALUES ('f_land', 'land-buy', 'Land', 2000000000, 1), ('f_gen', 'general', 'General', NULL, 2)`,
    ),
    db.prepare(`INSERT INTO funds (id, slug, title, status) VALUES ('f_off', 'old', 'Old', 'hidden')`),
  ]);
});

const start = async (amount = '1000', contact = '01711111111', extra: Record<string, string> = {}) => {
  const p = parseDonationForm(form({ fund: 'land-buy', amount, name: 'Amina', contact, ...extra }));
  if (!p.ok) throw new Error(p.error);
  const c = await createDonation(db, p.value);
  if (!c.ok) throw new Error(c.reason);
  return c.donation;
};

describe('the public donation form', () => {
  it('checks amount, name and contact, and reads Bangla digits', () => {
    expect(parseDonationForm(form({ fund: 'land-buy', amount: '5', name: 'A B', contact: '01711111111' }))).toEqual({ ok: false, error: 'amount' });
    expect(parseDonationForm(form({ fund: 'land-buy', amount: '600000', name: 'A B', contact: '01711111111' }))).toEqual({ ok: false, error: 'amount' });
    expect(parseDonationForm(form({ fund: 'land-buy', amount: '500', name: 'A', contact: '01711111111' }))).toEqual({ ok: false, error: 'name' });
    expect(parseDonationForm(form({ fund: 'land-buy', amount: '500', name: 'A B', contact: 'ff' }))).toEqual({ ok: false, error: 'contact' });
    expect(parseDonationForm(form({ fund: '../x', amount: '500', name: 'A B', contact: '01711111111' }))).toEqual({ ok: false, error: 'fund' });
    const bn = parseDonationForm(form({ fund: 'land-buy', amount: '500', amount_other: '১,২০০', name: 'আমিনা', contact: '+880 ১৭১১-১১১১১১' }));
    expect(bn.ok && bn.value).toMatchObject({ amountTaka: 1200, contact: '01711111111' });
    const mail = parseDonationForm(form({ fund: 'land-buy', amount: '500', name: 'A B', contact: 'Me@Example.org', utm_source: 'facebook', utm_campaign: 'land-nov' }));
    expect(mail.ok && mail.value).toMatchObject({ contact: 'me@example.org', utmSource: 'facebook', utmCampaign: 'land-nov' });
  });

  it('refuses hidden or unknown funds', async () => {
    const p = parseDonationForm(form({ fund: 'old', amount: '500', name: 'A B', contact: '01711111111' }));
    expect(p.ok && (await createDonation(db, p.value))).toEqual({ ok: false, reason: 'fund' });
  });
});

describe('SSLCommerz validation', () => {
  it('counts a gift only when the validation API agrees, once', async () => {
    const d = await start('1000');
    expect(isDonationReference(d.reference)).toBe(true);
    expect(d.status).toBe('pending');
    expect(await applyDonationValidation(db, valid(d.reference, '1000.00'), d.reference)).toBe('paid');
    // The IPN arrives as well: nothing changes.
    expect(await applyDonationValidation(db, valid(d.reference, '1000.00'), d.reference)).toBe('paid');
    const funds = await listFunds(db);
    expect(funds.find((f) => f.id === 'f_land')).toMatchObject({ raisedMinor: 100000, gifts: 1, donors: 1 });
    // A late "cancel" cannot undo a paid gift.
    await markDonationUnpaid(db, d.reference, 'cancelled', {});
    expect((await donationByReference(db, d.reference))?.status).toBe('paid');
  });

  it('holds wrong amounts, other currencies, other references and risky payments for review', async () => {
    const a = await start('1000');
    expect(await applyDonationValidation(db, valid(a.reference, '10.00'), a.reference)).toBe('review');
    const b = await start('1000');
    expect(await applyDonationValidation(db, valid(b.reference, '1000.00', { currency: 'USD' }), b.reference)).toBe('review');
    const c = await start('1000');
    expect(await applyDonationValidation(db, valid(a.reference, '1000.00'), c.reference)).toBe('review');
    expect((await donationByReference(db, c.reference))?.status).toBe('pending');
    const d = await start('1000');
    expect(await applyDonationValidation(db, valid(d.reference, '1000.00', { risk_level: '1' }), d.reference)).toBe('review');
    expect((await listFunds(db)).find((f) => f.id === 'f_land')?.raisedMinor).toBe(0);
    // An unreachable gateway or a failed status changes nothing.
    const e = await start('1000');
    expect(await applyDonationValidation(db, null, e.reference)).toBe('pending');
    expect(await applyDonationValidation(db, { status: 'INVALID_TRANSACTION', tran_id: e.reference }, e.reference)).toBe('pending');
    // Staff accept one with a note; the money then counts.
    expect(await decideReview(db, ACTOR, d.reference, true, '')).toBe(false);
    expect(await decideReview(db, ACTOR, d.reference, true, 'matched in bKash')).toBe(true);
    expect((await listFunds(db)).find((f) => f.id === 'f_land')?.raisedMinor).toBe(100000);
  });

  it('marks abandoned payments without touching paid ones', async () => {
    const d = await start('500');
    await markDonationUnpaid(db, d.reference, 'cancelled', { status: 'CANCELLED' });
    expect((await donationByReference(db, d.reference))?.status).toBe('cancelled');
  });
});

describe('gifts handed to the office', () => {
  it('count at once, save once per form, and are voided with a reason', async () => {
    const p = parseManualForm(form({ fund_id: 'f_gen', amount: '25000', name: 'Rahim', phone: '01811111111', method: 'bank', paid_on: '2026-11-05', nonce: 'n1' }));
    if (!p.ok) throw new Error(p.error);
    const first = await recordManualDonation(db, ACTOR, p.value);
    const again = await recordManualDonation(db, ACTOR, p.value);
    expect(first.ok && again.ok && first.reference === again.reference).toBe(true);
    expect((await listFunds(db)).find((f) => f.id === 'f_gen')?.raisedMinor).toBe(2_500_000);
    const ref = first.ok ? first.reference : '';
    expect(await voidDonation(db, ACTOR, ref, 'x')).toBe(false);
    expect(await voidDonation(db, ACTOR, ref, 'typed twice')).toBe(true);
    expect((await listFunds(db)).find((f) => f.id === 'f_gen')?.raisedMinor).toBe(0);
    expect(parseManualForm(form({ fund_id: 'f_gen', amount: '1', name: 'R B', phone: '123', method: 'cash' }))).toEqual({ ok: false, error: 'phone' });
  });

  it('cannot void an online gift', async () => {
    const d = await start('1000');
    await applyDonationValidation(db, valid(d.reference, '1000'), d.reference);
    expect(await voidDonation(db, ACTOR, d.reference, 'not allowed here')).toBe(false);
  });
});

describe('donors, lists and the graph', () => {
  it('groups gifts by phone, hides anonymous names and fills months in Dhaka time', async () => {
    const a = await start('1000', '01711111111');
    await applyDonationValidation(db, valid(a.reference, '1000'), a.reference);
    const b = await start('500', '01711111111', { anonymous: '1' });
    await applyDonationValidation(db, valid(b.reference, '500'), b.reference);
    const donors = await listDonors(db);
    expect(donors).toHaveLength(1);
    expect(donors[0]).toMatchObject({ key: '01711111111', totalMinor: 150000, gifts: 2 });
    expect((await donorHistory(db, '01711111111')).length).toBe(2);
    const gifts = await recentGifts(db, 'f_land');
    expect(gifts.map((g) => g.name).sort()).toEqual(['', 'Amina']);

    // 31 Oct 19:00 UTC is 1 Nov in Dhaka.
    await db.prepare(`UPDATE donations SET paid_at = '2026-10-31T19:00:00.000Z'`).run();
    const months = await monthlyTotals(db, 'f_land', 3, '2026-11-10');
    expect(months).toEqual([
      { month: '2026-09', minor: 0, gifts: 0 },
      { month: '2026-10', minor: 0, gifts: 0 },
      { month: '2026-11', minor: 150000, gifts: 2 },
    ]);
  });
});
