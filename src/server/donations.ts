import { log } from './admin';
import type { Validation } from './sslcommerz';
import { renderText } from '../lib/text';
import { isYmd, todayDhaka } from '../lib/offline';

// Donations to the madrasa's funds.
//
// Online gifts go through SSLCommerz. The amount the donor typed is kept on
// our side when the payment starts; the gift counts (status 'paid') only after
// SSLCommerz's validation API says the payment is valid, for this reference,
// for that exact amount, in Taka and not risky. Anything else waits in
// 'review' for staff. Applying the same answer twice changes nothing.
//
// Gifts handed to the office (cash, bank transfer, bKash to the madrasa's own
// number) are recorded by staff as 'manual' and count at once.

export const MIN_TAKA = 10;
export const MAX_TAKA = 500_000;

export type Fund = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  storyText: string;
  coverKey: string | null;
  goalMinor: number | null;
  memberGoal: number | null;
  presetAmounts: string;
  status: 'active' | 'hidden';
  position: number;
};

export type FundWithTotals = Fund & { raisedMinor: number; gifts: number; donors: number };

const FUND_COLS = `f.id, f.slug, f.title, f.summary, f.story_text AS storyText, f.cover_key AS coverKey, f.goal_minor AS goalMinor,
  f.member_goal AS memberGoal, f.preset_amounts AS presetAmounts, f.status, f.position`;

/** A donor is counted once per phone number (or name, for gifts without one). */
const DONOR_KEY = `CASE WHEN d.donor_phone <> '' THEN d.donor_phone ELSE lower(d.donor_name) END`;

/** Counted gifts: paid online, or recorded at the office and not voided. */
export const COUNTED = `d.status = 'paid' AND d.voided_at IS NULL`;

export async function listFunds(db: D1Database, opts: { all?: boolean } = {}): Promise<FundWithTotals[]> {
  const { results } = await db
    .prepare(
      `SELECT ${FUND_COLS},
         coalesce(sum(CASE WHEN ${COUNTED} THEN d.amount_minor END), 0) AS raisedMinor,
         count(CASE WHEN ${COUNTED} THEN 1 END) AS gifts,
         count(DISTINCT CASE WHEN ${COUNTED} THEN ${DONOR_KEY} END) AS donors
       FROM funds f LEFT JOIN donations d ON d.fund_id = f.id
       ${opts.all ? '' : `WHERE f.status = 'active'`}
       GROUP BY f.id ORDER BY f.position, f.title`,
    )
    .all<FundWithTotals>();
  return results;
}

export async function fundBySlug(db: D1Database, slug: string): Promise<FundWithTotals | null> {
  return db
    .prepare(
      `SELECT ${FUND_COLS},
         coalesce(sum(CASE WHEN ${COUNTED} THEN d.amount_minor END), 0) AS raisedMinor,
         count(CASE WHEN ${COUNTED} THEN 1 END) AS gifts,
         count(DISTINCT CASE WHEN ${COUNTED} THEN ${DONOR_KEY} END) AS donors
       FROM funds f LEFT JOIN donations d ON d.fund_id = f.id WHERE f.slug = ? GROUP BY f.id`,
    )
    .bind(slug)
    .first<FundWithTotals>();
}

export const fundById = (db: D1Database, id: string) => db.prepare(`SELECT ${FUND_COLS} FROM funds f WHERE f.id = ?`).bind(id).first<Fund>();

/** Quick amounts in taka for the donation form, from the fund's setting. */
export function presets(f: Pick<Fund, 'presetAmounts'>): number[] {
  return f.presetAmounts
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= MIN_TAKA && n <= MAX_TAKA)
    .slice(0, 6);
}

export const percent = (raised: number, goal: number | null | undefined) => (goal && goal > 0 ? Math.min(100, Math.floor((raised / goal) * 1000) / 10) : null);

export const storyHtml = (f: Pick<Fund, 'storyText'>) => renderText(f.storyText);

// ---- Public lists ------------------------------------------------------------------

export type PublicGift = { name: string; onBehalf: string; amountMinor: number; paidAt: string };

/** Recent gifts for a fund page. Anonymous donors are never named. */
export async function recentGifts(db: D1Database, fundId: string | null, limit = 12): Promise<PublicGift[]> {
  const { results } = await db
    .prepare(
      `SELECT CASE WHEN d.anonymous THEN '' ELSE d.donor_name END AS name, CASE WHEN d.anonymous THEN '' ELSE d.on_behalf END AS onBehalf,
         d.amount_minor AS amountMinor, d.paid_at AS paidAt
       FROM donations d WHERE ${COUNTED} ${fundId ? 'AND d.fund_id = ?1' : ''} ORDER BY d.paid_at DESC LIMIT ${fundId ? '?2' : '?1'}`,
    )
    .bind(...(fundId ? [fundId, limit] : [limit]))
    .all<PublicGift>();
  return results;
}

/** Money raised per month (Dhaka), oldest first, for the graph. Months with nothing are filled with 0. */
export async function monthlyTotals(db: D1Database, fundId: string | null, months = 12, today = todayDhaka()): Promise<{ month: string; minor: number; gifts: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT substr(datetime(d.paid_at, '+6 hours'), 1, 7) AS month, sum(d.amount_minor) AS minor, count(*) AS gifts
       FROM donations d WHERE ${COUNTED} ${fundId ? 'AND d.fund_id = ?' : ''} GROUP BY month`,
    )
    .bind(...(fundId ? [fundId] : []))
    .all<{ month: string; minor: number; gifts: number }>();
  const by = new Map(results.map((r) => [r.month, r]));
  const out: { month: string; minor: number; gifts: number }[] = [];
  const [y, m] = today.split('-').map(Number) as [number, number];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = d.toISOString().slice(0, 7);
    out.push({ month: key, minor: by.get(key)?.minor ?? 0, gifts: by.get(key)?.gifts ?? 0 });
  }
  return out;
}

export type FundUpdate = { id: string; fundId: string; title: string; body: string; imageKey: string | null; happenedOn: string; status: string };

export async function fundUpdates(db: D1Database, fundId: string, all = false): Promise<FundUpdate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, fund_id AS fundId, title, body, image_key AS imageKey, happened_on AS happenedOn, status FROM fund_updates
       WHERE fund_id = ? ${all ? '' : `AND status = 'published'`} ORDER BY happened_on DESC, created_at DESC`,
    )
    .bind(fundId)
    .all<FundUpdate>();
  return results;
}

// ---- Starting an online gift -------------------------------------------------------

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newReference(prefix = 'DN'): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}-${Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')}`;
}
export const isDonationReference = (ref: string | undefined | null) => Boolean(ref && /^(DN|MN)-[A-Z0-9]{8,20}$|^DMP\d{6,20}$/.test(ref));

export type DonationInput = {
  fundSlug: string;
  amountTaka: number;
  name: string;
  contact: string;
  onBehalf: string;
  anonymous: boolean;
  utmSource: string;
  utmCampaign: string;
};

const BD_PHONE = /^(?:\+?88)?(01[3-9]\d{8})$/;
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toAscii = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
const clean = (s: unknown, max: number) => toAscii(String(s ?? '')).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

/** Reads and checks the public donation form. Phone or email: the donor gives one. */
export function parseDonationForm(form: FormData): { ok: true; value: DonationInput } | { ok: false; error: 'fund' | 'amount' | 'name' | 'contact' } {
  const fundSlug = clean(form.get('fund'), 60);
  if (!/^[a-z0-9-]{1,60}$/.test(fundSlug)) return { ok: false, error: 'fund' };
  const rawAmount = clean(form.get('amount_other'), 12) || clean(form.get('amount'), 12);
  const amountTaka = Number(rawAmount.replace(/[,\s৳]/g, ''));
  if (!Number.isInteger(amountTaka) || amountTaka < MIN_TAKA || amountTaka > MAX_TAKA) return { ok: false, error: 'amount' };
  const name = clean(form.get('name'), 80);
  if (name.length < 2) return { ok: false, error: 'name' };
  const contact = clean(form.get('contact'), 120).replace(/[\s-]/g, '');
  const phone = BD_PHONE.exec(contact)?.[1];
  const intl = /^\+\d{8,15}$/.test(contact) ? contact : null;
  const email = /^[^\s@]{1,64}@[^\s@]{1,100}\.[a-z]{2,}$/i.test(contact) ? contact.toLowerCase() : null;
  if (!phone && !intl && !email) return { ok: false, error: 'contact' };
  return {
    ok: true,
    value: {
      fundSlug,
      amountTaka,
      name,
      contact: phone ?? intl ?? email!,
      onBehalf: clean(form.get('on_behalf'), 120),
      anonymous: form.get('anonymous') === '1',
      utmSource: clean(form.get('utm_source'), 60),
      utmCampaign: clean(form.get('utm_campaign'), 100),
    },
  };
}

export type Donation = {
  id: string;
  reference: string;
  fundId: string;
  fundTitle: string;
  fundSlug: string;
  amountMinor: number;
  donorName: string;
  donorPhone: string;
  donorEmail: string;
  onBehalf: string;
  anonymous: number;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'review';
  gateway: 'sslcommerz' | 'manual';
  method: string;
  bankTranId: string | null;
  reviewReason: string | null;
  utmSource: string;
  utmCampaign: string;
  note: string;
  recordedBy: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  paidAt: string | null;
  createdAt: string;
};

const DONATION_SELECT = `SELECT d.id, d.reference, d.fund_id AS fundId, f.title AS fundTitle, f.slug AS fundSlug, d.amount_minor AS amountMinor,
  d.donor_name AS donorName, d.donor_phone AS donorPhone, d.donor_email AS donorEmail, d.on_behalf AS onBehalf, d.anonymous,
  d.status, d.gateway, d.method, d.bank_tran_id AS bankTranId, d.review_reason AS reviewReason, d.utm_source AS utmSource,
  d.utm_campaign AS utmCampaign, d.note, d.recorded_by AS recordedBy, d.voided_at AS voidedAt, d.void_reason AS voidReason,
  d.paid_at AS paidAt, d.created_at AS createdAt
  FROM donations d JOIN funds f ON f.id = d.fund_id`;

export const donationByReference = (db: D1Database, reference: string) => db.prepare(`${DONATION_SELECT} WHERE d.reference = ?`).bind(reference).first<Donation>();

export async function createDonation(db: D1Database, v: DonationInput): Promise<{ ok: true; donation: Donation } | { ok: false; reason: 'fund' }> {
  const fund = await db.prepare(`SELECT id, title, slug FROM funds WHERE slug = ? AND status = 'active'`).bind(v.fundSlug).first<{ id: string; title: string; slug: string }>();
  if (!fund) return { ok: false, reason: 'fund' };
  const id = `don_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const reference = newReference();
  const isEmail = v.contact.includes('@');
  await db
    .prepare(
      `INSERT INTO donations (id, reference, fund_id, amount_minor, donor_name, donor_phone, donor_email, on_behalf, anonymous, utm_source, utm_campaign)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, reference, fund.id, v.amountTaka * 100, v.name, isEmail ? '' : v.contact, isEmail ? v.contact : '', v.onBehalf, v.anonymous ? 1 : 0, v.utmSource, v.utmCampaign)
    .run();
  return { ok: true, donation: (await donationByReference(db, reference))! };
}

async function event(db: D1Database, donationId: string | null, kind: string, detail: unknown) {
  await db
    .prepare('INSERT INTO donation_events (id, donation_id, kind, detail_json) VALUES (?, ?, ?, ?)')
    .bind(`dev_${crypto.randomUUID()}`, donationId, kind, JSON.stringify(detail).slice(0, 4000))
    .run();
}

/** Applies SSLCommerz's validation answer. Safe to call many times (browser return and IPN). */
export async function applyDonationValidation(db: D1Database, v: Validation | null, expectedReference: string): Promise<Donation['status'] | 'unknown'> {
  const reference = v?.tran_id ?? expectedReference;
  const d = await donationByReference(db, reference);
  await event(db, d?.id ?? null, 'validation', { reference, v: v ?? { error: 'unreachable' } });
  if (!d) return 'unknown';
  if (d.status === 'paid') return 'paid';
  if (!v || !(v.status === 'VALID' || v.status === 'VALIDATED')) return d.status;

  const matches =
    v.tran_id === d.reference &&
    expectedReference === d.reference &&
    (v.currency ?? '').toUpperCase() === 'BDT' &&
    v.amount !== undefined &&
    Math.round(Number(v.amount) * 100) === d.amountMinor;
  const risky = v.risk_level === '1';
  const status = matches && !risky ? 'paid' : 'review';
  await db
    .prepare(
      `UPDATE donations SET status = ?, review_reason = ?, val_id = ?, bank_tran_id = ?, method = ?,
         paid_at = CASE WHEN ? = 'paid' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE paid_at END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status <> 'paid'`,
    )
    .bind(status, status === 'review' ? (matches ? 'risky' : 'mismatch') : null, v.val_id ?? null, v.bank_tran_id ?? null, (v.card_type ?? '').slice(0, 40), status, d.id)
    .run();
  return status;
}

export async function markDonationUnpaid(db: D1Database, reference: string, status: 'failed' | 'cancelled', detail: unknown) {
  const d = await db.prepare('SELECT id FROM donations WHERE reference = ?').bind(reference).first<{ id: string }>();
  await event(db, d?.id ?? null, status, { reference, detail });
  await db
    .prepare(`UPDATE donations SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE reference = ? AND status = 'pending'`)
    .bind(status, reference)
    .run();
}

// ---- Office ------------------------------------------------------------------------

export const MANUAL_METHODS = ['cash', 'bank', 'bkash', 'nagad', 'rocket', 'other'] as const;
export const MANUAL_METHOD_BN: Record<string, string> = { cash: 'নগদ', bank: 'ব্যাংক', bkash: 'বিকাশ', nagad: 'নগদ (মোবাইল)', rocket: 'রকেট', other: 'অন্যান্য' };

export type ManualInput = {
  fundId: string;
  amountTaka: number;
  name: string;
  phone: string;
  onBehalf: string;
  method: string;
  paidOn: string;
  note: string;
  anonymous: boolean;
  nonce: string;
};

export function parseManualForm(form: FormData): { ok: true; value: ManualInput } | { ok: false; error: string } {
  const amountTaka = Number(clean(form.get('amount'), 12).replace(/[,\s৳]/g, ''));
  if (!Number.isInteger(amountTaka) || amountTaka < 1 || amountTaka > 100_000_000) return { ok: false, error: 'amount' };
  const name = clean(form.get('name'), 80);
  if (name.length < 2) return { ok: false, error: 'name' };
  const method = clean(form.get('method'), 20);
  if (!(MANUAL_METHODS as readonly string[]).includes(method)) return { ok: false, error: 'method' };
  const paidOn = clean(form.get('paid_on'), 10) || todayDhaka();
  if (!isYmd(paidOn)) return { ok: false, error: 'date' };
  const rawPhone = clean(form.get('phone'), 20).replace(/[\s-]/g, '');
  const phone = rawPhone ? (BD_PHONE.exec(rawPhone)?.[1] ?? (/^\+\d{8,15}$/.test(rawPhone) ? rawPhone : null)) : '';
  if (phone === null) return { ok: false, error: 'phone' };
  return {
    ok: true,
    value: {
      fundId: clean(form.get('fund_id'), 40),
      amountTaka,
      name,
      phone,
      onBehalf: clean(form.get('on_behalf'), 120),
      method,
      paidOn,
      note: clean(form.get('note'), 300),
      anonymous: form.get('anonymous') === '1',
      nonce: clean(form.get('nonce'), 64) || crypto.randomUUID(),
    },
  };
}

/** A gift handed to the office. The nonce makes a double click save only once. */
export async function recordManualDonation(db: D1Database, actor: string, v: ManualInput): Promise<{ ok: true; reference: string } | { ok: false; error: 'fund' }> {
  const fund = await fundById(db, v.fundId);
  if (!fund) return { ok: false, error: 'fund' };
  const reference = newReference('MN');
  // Dhaka noon of the day it was given, so it lands in the right month.
  const paidAt = `${v.paidOn}T06:00:00.000Z`;
  const r = await db
    .prepare(
      `INSERT INTO donations (id, reference, fund_id, amount_minor, donor_name, donor_phone, on_behalf, anonymous, status, gateway, method, note, recorded_by, nonce, paid_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'manual', ?, ?, ?, ?, ?) ON CONFLICT (nonce) DO NOTHING`,
    )
    .bind(`don_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, reference, fund.id, v.amountTaka * 100, v.name, v.phone, v.onBehalf, v.anonymous ? 1 : 0, v.method, v.note, actor, v.nonce, paidAt)
    .run();
  if (r.meta.changes) await log(db, actor, 'donation.manual', `donation:${reference}`, { fund: fund.title, amount: v.amountTaka, name: v.name });
  const saved = await db.prepare('SELECT reference FROM donations WHERE nonce = ?').bind(v.nonce).first<{ reference: string }>();
  return { ok: true, reference: saved?.reference ?? reference };
}

/** A wrong office entry is voided with a reason, never deleted. Online gifts cannot be voided here. */
export async function voidDonation(db: D1Database, actor: string, reference: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 3) return false;
  const r = await db
    .prepare(
      `UPDATE donations SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ?
       WHERE reference = ? AND gateway = 'manual' AND voided_at IS NULL`,
    )
    .bind(actor, why, reference)
    .run();
  if (r.meta.changes) await log(db, actor, 'donation.void', `donation:${reference}`, { reason: why });
  return r.meta.changes > 0;
}

/** Staff decide a gift held for review: count it, or leave it out. */
export async function decideReview(db: D1Database, actor: string, reference: string, accept: boolean, note: string): Promise<boolean> {
  const why = note.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE donations SET status = ?, review_reason = coalesce(review_reason, '') || ' | ' || ?,
         paid_at = CASE WHEN ? = 'paid' THEN coalesce(paid_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE paid_at END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE reference = ? AND status = 'review'`,
    )
    .bind(accept ? 'paid' : 'failed', `${actor}: ${why}`, accept ? 'paid' : 'failed', reference)
    .run();
  if (r.meta.changes) await log(db, actor, accept ? 'donation.accept' : 'donation.reject', `donation:${reference}`, { note: why });
  return r.meta.changes > 0;
}

export type DonationFilter = { fundId?: string; status?: string; q?: string; from?: string; to?: string; source?: string };

const filterSql = (f: DonationFilter) => {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.fundId) {
    where.push('d.fund_id = ?');
    args.push(f.fundId);
  }
  if (f.status === 'counted') where.push(COUNTED);
  else if (f.status === 'voided') where.push('d.voided_at IS NOT NULL');
  else if (f.status) {
    where.push('d.status = ? AND d.voided_at IS NULL');
    args.push(f.status);
  }
  if (f.q) {
    where.push('(d.donor_name LIKE ? OR d.donor_phone LIKE ? OR d.donor_email LIKE ? OR d.reference LIKE ? OR d.on_behalf LIKE ?)');
    const like = `%${f.q.replace(/[%_]/g, '')}%`;
    args.push(like, like, like, like, like);
  }
  if (f.from && isYmd(f.from)) {
    where.push(`substr(datetime(coalesce(d.paid_at, d.created_at), '+6 hours'), 1, 10) >= ?`);
    args.push(f.from);
  }
  if (f.to && isYmd(f.to)) {
    where.push(`substr(datetime(coalesce(d.paid_at, d.created_at), '+6 hours'), 1, 10) <= ?`);
    args.push(f.to);
  }
  if (f.source) {
    where.push('d.utm_source = ?');
    args.push(f.source);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
};

export async function listDonations(db: D1Database, f: DonationFilter, limit = 200): Promise<{ rows: Donation[]; totalMinor: number; count: number }> {
  const w = filterSql(f);
  const [{ results }, sum] = await Promise.all([
    db.prepare(`${DONATION_SELECT} ${w.sql} ORDER BY coalesce(d.paid_at, d.created_at) DESC LIMIT ${Math.min(limit, 2000)}`).bind(...w.args).all<Donation>(),
    db
      .prepare(`SELECT coalesce(sum(CASE WHEN ${COUNTED} THEN d.amount_minor END), 0) AS totalMinor, count(*) AS count FROM donations d ${w.sql}`)
      .bind(...w.args)
      .first<{ totalMinor: number; count: number }>(),
  ]);
  return { rows: results, totalMinor: sum?.totalMinor ?? 0, count: sum?.count ?? 0 };
}

// ---- Donors (CRM) ----------------------------------------------------------------------

export type Donor = {
  key: string;
  name: string;
  phone: string;
  email: string;
  totalMinor: number;
  gifts: number;
  firstAt: string;
  lastAt: string;
  funds: string;
};

/** Everyone who gave, one row per phone number (or email, or name), biggest givers first. */
export async function listDonors(db: D1Database, q = '', limit = 300): Promise<Donor[]> {
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const { results } = await db
    .prepare(
      `SELECT CASE WHEN d.donor_phone <> '' THEN d.donor_phone WHEN d.donor_email <> '' THEN d.donor_email ELSE lower(d.donor_name) END AS key,
         max(d.donor_name) AS name, max(d.donor_phone) AS phone, max(d.donor_email) AS email,
         sum(d.amount_minor) AS totalMinor, count(*) AS gifts, min(d.paid_at) AS firstAt, max(d.paid_at) AS lastAt,
         group_concat(DISTINCT f.title) AS funds
       FROM donations d JOIN funds f ON f.id = d.fund_id
       WHERE ${COUNTED} ${q ? 'AND (d.donor_name LIKE ?1 OR d.donor_phone LIKE ?1 OR d.donor_email LIKE ?1)' : ''}
       GROUP BY key ORDER BY totalMinor DESC LIMIT ${Math.min(limit, 2000)}`,
    )
    .bind(...(q ? [like] : []))
    .all<Donor>();
  return results;
}

/** Every gift (counted or not) from one donor, by their key from listDonors. */
export async function donorHistory(db: D1Database, key: string): Promise<Donation[]> {
  const { results } = await db
    .prepare(
      `${DONATION_SELECT} WHERE (d.donor_phone = ?1 AND d.donor_phone <> '') OR (d.donor_email = ?1 AND d.donor_email <> '')
         OR (d.donor_phone = '' AND d.donor_email = '' AND lower(d.donor_name) = ?1)
       ORDER BY coalesce(d.paid_at, d.created_at) DESC LIMIT 500`,
    )
    .bind(key)
    .all<Donation>();
  return results;
}

// ---- Reports -------------------------------------------------------------------------------

export async function donationSummary(db: D1Database, today = todayDhaka()) {
  const month = today.slice(0, 7);
  const row = await db
    .prepare(
      `SELECT coalesce(sum(d.amount_minor), 0) AS totalMinor, count(*) AS gifts,
         count(DISTINCT ${DONOR_KEY}) AS donors,
         coalesce(sum(CASE WHEN substr(datetime(d.paid_at, '+6 hours'), 1, 7) = ?1 THEN d.amount_minor END), 0) AS monthMinor,
         coalesce(sum(CASE WHEN substr(datetime(d.paid_at, '+6 hours'), 1, 10) = ?2 THEN d.amount_minor END), 0) AS todayMinor
       FROM donations d WHERE ${COUNTED}`,
    )
    .bind(month, today)
    .first<{ totalMinor: number; gifts: number; donors: number; monthMinor: number; todayMinor: number }>();
  const pending = await db
    .prepare(`SELECT count(*) AS n FROM donations WHERE status = 'review'`)
    .first<{ n: number }>();
  return { ...row!, reviews: pending?.n ?? 0 };
}

/** Counted money by where the donor came from (utm_source), for judging ads. */
export async function bySource(db: D1Database, from: string) {
  const { results } = await db
    .prepare(
      `SELECT CASE WHEN d.utm_source = '' THEN (CASE WHEN d.gateway = 'manual' THEN 'office' ELSE 'direct' END) ELSE d.utm_source END AS source,
         d.utm_campaign AS campaign, count(*) AS gifts, sum(d.amount_minor) AS minor
       FROM donations d WHERE ${COUNTED} AND d.paid_at >= ? GROUP BY source, campaign ORDER BY minor DESC LIMIT 50`,
    )
    .bind(from)
    .all<{ source: string; campaign: string; gifts: number; minor: number }>();
  return results;
}

// ---- Funds (admin) -------------------------------------------------------------------------

export function slugOk(s: string) {
  return /^[a-z0-9][a-z0-9-]{0,58}$/.test(s);
}

export type FundInput = Omit<Fund, 'id' | 'coverKey'>;

export function parseFundForm(form: FormData): { ok: true; value: FundInput } | { ok: false; error: string } {
  const title = clean(form.get('title'), 120);
  if (title.length < 2) return { ok: false, error: 'title' };
  const slug = clean(form.get('slug'), 60).toLowerCase();
  if (!slugOk(slug)) return { ok: false, error: 'slug' };
  const goalTaka = clean(form.get('goal'), 14).replace(/[,\s৳]/g, '');
  const goal = goalTaka ? Number(goalTaka) : null;
  if (goal !== null && (!Number.isInteger(goal) || goal < 0 || goal > 10_000_000_000)) return { ok: false, error: 'goal' };
  const memberRaw = clean(form.get('member_goal'), 6);
  const memberGoal = memberRaw ? Number(memberRaw) : null;
  if (memberGoal !== null && (!Number.isInteger(memberGoal) || memberGoal < 0)) return { ok: false, error: 'member_goal' };
  const presetAmounts = clean(form.get('presets'), 120)
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= MIN_TAKA && n <= MAX_TAKA)
    .join(',');
  return {
    ok: true,
    value: {
      slug,
      title,
      summary: clean(form.get('summary'), 400),
      storyText: String(form.get('story') ?? '').slice(0, 20000),
      goalMinor: goal ? goal * 100 : null,
      memberGoal: memberGoal || null,
      presetAmounts: presetAmounts || '500,1000,2000,5000,10000',
      status: form.get('status') === 'hidden' ? 'hidden' : 'active',
      position: Number(clean(form.get('position'), 4)) || 0,
    },
  };
}

export async function saveFund(db: D1Database, actor: string, id: string | null, v: FundInput): Promise<{ ok: true; id: string } | { ok: false; error: 'slug_taken' }> {
  const taken = await db.prepare('SELECT id FROM funds WHERE slug = ?').bind(v.slug).first<{ id: string }>();
  if (taken && taken.id !== id) return { ok: false, error: 'slug_taken' };
  const fid = id ?? `fund_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  if (id) {
    await db
      .prepare(
        `UPDATE funds SET slug = ?, title = ?, summary = ?, story_text = ?, goal_minor = ?, member_goal = ?, preset_amounts = ?, status = ?, position = ? WHERE id = ?`,
      )
      .bind(v.slug, v.title, v.summary, v.storyText, v.goalMinor, v.memberGoal, v.presetAmounts, v.status, v.position, id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO funds (id, slug, title, summary, story_text, goal_minor, member_goal, preset_amounts, status, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(fid, v.slug, v.title, v.summary, v.storyText, v.goalMinor, v.memberGoal, v.presetAmounts, v.status, v.position)
      .run();
  }
  await log(db, actor, id ? 'fund.update' : 'fund.create', `fund:${fid}`, { title: v.title, goal: v.goalMinor ? v.goalMinor / 100 : null });
  return { ok: true, id: fid };
}

export async function setFundCover(db: D1Database, actor: string, fundId: string, key: string | null) {
  await db.prepare('UPDATE funds SET cover_key = ? WHERE id = ?').bind(key, fundId).run();
  await log(db, actor, 'fund.cover', `fund:${fundId}`, {});
}

export async function addFundUpdate(db: D1Database, actor: string, fundId: string, input: { title: string; body: string; happenedOn: string; imageKey: string | null }): Promise<boolean> {
  const title = clean(input.title, 160);
  if (title.length < 2 || !isYmd(input.happenedOn)) return false;
  await db
    .prepare('INSERT INTO fund_updates (id, fund_id, title, body, image_key, happened_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(`fu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`, fundId, title, String(input.body).slice(0, 5000), input.imageKey, input.happenedOn, actor)
    .run();
  await log(db, actor, 'fund.update_add', `fund:${fundId}`, { title });
  return true;
}

export async function setFundUpdateStatus(db: D1Database, actor: string, id: string, status: 'published' | 'hidden') {
  const r = await db.prepare('UPDATE fund_updates SET status = ? WHERE id = ?').bind(status, id).run();
  if (r.meta.changes) await log(db, actor, `fund.update_${status}`, `fund_update:${id}`, {});
}

