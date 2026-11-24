import { log } from './admin';
import { CLOSED_THROUGH_SQL, dayIsClosed } from './acc-period';
import { longText, newId, text, type Result } from './ops-util';
import { addDays, isYmd, parseTaka, PAY_METHODS, type PayMethod } from '../lib/offline';

// The madrasa's books (migration 0004): projects, funds (general, zakat,
// lillah, grants), the places money is kept (cash box, bank, mobile banking,
// gateway), other income and transfers with voucher numbers, yearly budgets,
// bank and cash reconciliation, and the receipts and payments statement.
//
// Nothing here stores a second copy of money already recorded elsewhere:
// student fees come from offline_payments and spending from expenses
// (approved, not voided). Which account a fee or expense landed in follows
// from its payment method (each method belongs to one account). Donations
// are their own part of the site and are not counted here.

export const ALL_METHODS = [...PAY_METHODS, 'online'] as const satisfies readonly PayMethod[];
export const GENERAL_FUND = 'fund_general';
export const UNASSIGNED = 'unassigned';
export const DONATION_TRANSFER_CATEGORY = 'দান তহবিল থেকে স্থানান্তর';
/** Only used with a bound parameter or a stored method column. */
export const postedAccount = (method: string) => `coalesce((SELECT id FROM acc_accounts
  WHERE status = 'active' AND instr(',' || methods || ',', ',' || ${method} || ',') > 0
  ORDER BY created_at, id LIMIT 1), '${UNASSIGNED}')`;

export const ACCOUNT_KINDS = ['cash', 'bank', 'mobile', 'gateway'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_KIND_BN: Record<AccountKind, string> = { cash: 'ক্যাশ', bank: 'ব্যাংক', mobile: 'মোবাইল ব্যাংকিং', gateway: 'অনলাইন গেটওয়ে' };

export const FUND_KINDS = ['general', 'zakat', 'lillah', 'grant', 'other'] as const;
export type FundKind = (typeof FUND_KINDS)[number];
export const FUND_KIND_BN: Record<FundKind, string> = { general: 'সাধারণ', zakat: 'যাকাত', lillah: 'লিল্লাহ', grant: 'অনুদান বা গ্রান্ট', other: 'অন্যান্য' };

export const INCOME_CATEGORIES = ['অনুদান বা গ্রান্ট', 'দান তহবিল থেকে স্থানান্তর', 'ভাড়া আয়', 'বই ও পোশাক বিক্রি', 'পুরনো জিনিস বিক্রি', 'ব্যাংক মুনাফা', 'অন্যান্য আয়'] as const;

export type Project = { id: string; name: string; note: string; status: 'active' | 'closed' };
export type Fund = { id: string; name: string; kind: FundKind; restricted: number; note: string; status: 'active' | 'closed' };
export type Account = { id: string; name: string; kind: AccountKind; methods: string; numberHint: string; openingMinor: number; openingOn: string; status: 'active' | 'closed' };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });
const nonceOf = (form: FormData) => {
  const n = text(form, 'nonce', 40);
  return /^[0-9a-f-]{36}$/.test(n) ? n : null;
};
/** Optional whole taka (may be 0 or negative for an opening balance with "-"). */
function signedTaka(raw: unknown): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const neg = s.startsWith('-') || s.startsWith('−');
  const n = parseTaka(neg ? s.slice(1) : s);
  return n === null ? null : neg ? -n : n;
}

// ---- Projects, funds, accounts ------------------------------------------------

export async function listProjects(db: D1Database, includeClosed = false): Promise<Project[]> {
  const { results } = await db.prepare(`SELECT id, name, note, status FROM acc_projects ${includeClosed ? '' : "WHERE status = 'active'"} ORDER BY status, name`).all<Project>();
  return results;
}

export async function listFunds(db: D1Database, includeClosed = false): Promise<Fund[]> {
  const { results } = await db
    .prepare(`SELECT id, name, kind, restricted, note, status FROM acc_funds ${includeClosed ? '' : "WHERE status = 'active'"} ORDER BY id = '${GENERAL_FUND}' DESC, status, name`)
    .all<Fund>();
  return results;
}

export async function listAccounts(db: D1Database, includeClosed = true): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, kind, methods, number_hint AS numberHint, opening_minor AS openingMinor, opening_on AS openingOn, status FROM acc_accounts
       ${includeClosed ? '' : "WHERE status = 'active'"} ORDER BY status, created_at`,
    )
    .all<Account>();
  return results;
}

export function parseProjectForm(form: FormData): Result<{ name: string; note: string; status: 'active' | 'closed' }> {
  const name = text(form, 'name', 80);
  if (name.length < 2) return fail('name');
  return ok({ name, note: longText(form, 'note', 300), status: form.get('status') === 'closed' ? 'closed' : 'active' });
}

export async function saveProject(db: D1Database, actor: string, id: string | null, v: { name: string; note: string; status: 'active' | 'closed' }): Promise<Result<string>> {
  const pid = id || newId('prj');
  try {
    if (id) {
      const r = await db.prepare('UPDATE acc_projects SET name = ?, note = ?, status = ? WHERE id = ?').bind(v.name, v.note, v.status, id).run();
      if (!r.meta.changes) return fail('missing');
    } else {
      await db.prepare('INSERT INTO acc_projects (id, name, note, status, created_by) VALUES (?, ?, ?, ?, ?)').bind(pid, v.name, v.note, v.status, actor).run();
    }
  } catch {
    return fail('name_taken');
  }
  await log(db, actor, id ? 'accounts.project.update' : 'accounts.project.create', `project:${pid}`, v);
  return ok(pid);
}

export function parseFundForm(form: FormData): Result<{ name: string; kind: FundKind; restricted: boolean; note: string; status: 'active' | 'closed' }> {
  const name = text(form, 'name', 80);
  if (name.length < 2) return fail('name');
  const kind = text(form, 'kind') as FundKind;
  return ok({
    name,
    kind: (FUND_KINDS as readonly string[]).includes(kind) ? kind : 'other',
    restricted: form.get('restricted') === 'on',
    note: longText(form, 'note', 300),
    status: form.get('status') === 'closed' ? 'closed' : 'active',
  });
}

export async function saveFund(db: D1Database, actor: string, id: string | null, v: { name: string; kind: FundKind; restricted: boolean; note: string; status: 'active' | 'closed' }): Promise<Result<string>> {
  const fid = id || newId('fund');
  // The general fund always stays open and unrestricted: fees count there.
  const status = fid === GENERAL_FUND ? 'active' : v.status;
  const restricted = fid === GENERAL_FUND ? 0 : v.restricted ? 1 : 0;
  try {
    if (id) {
      const r = await db.prepare('UPDATE acc_funds SET name = ?, kind = ?, restricted = ?, note = ?, status = ? WHERE id = ?').bind(v.name, v.kind, restricted, v.note, status, id).run();
      if (!r.meta.changes) return fail('missing');
    } else {
      await db.prepare('INSERT INTO acc_funds (id, name, kind, restricted, note, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(fid, v.name, v.kind, restricted, v.note, status, actor).run();
    }
  } catch {
    return fail('name_taken');
  }
  await log(db, actor, id ? 'accounts.fund.update' : 'accounts.fund.create', `fund:${fid}`, { ...v, restricted: Boolean(restricted), status });
  return ok(fid);
}

type AccountInput = { name: string; kind: AccountKind; methods: string[]; numberHint: string; openingMinor: number; openingOn: string; status: 'active' | 'closed' };

export function parseAccountForm(form: FormData): Result<AccountInput> {
  const name = text(form, 'name', 80);
  if (name.length < 2) return fail('name');
  const kind = text(form, 'kind') as AccountKind;
  if (!(ACCOUNT_KINDS as readonly string[]).includes(kind)) return fail('kind');
  const methods = form.getAll('methods').map(String).filter((m) => (ALL_METHODS as readonly string[]).includes(m));
  const opening = signedTaka(form.get('opening'));
  if (opening === null) return fail('opening');
  const openingOn = text(form, 'openingOn', 10);
  if (openingOn && !isYmd(openingOn)) return fail('opening_on');
  // Only the last few digits: the full account number is not needed here.
  const numberHint = text(form, 'numberHint', 12).replace(/[^0-9A-Za-z-]/g, '');
  return ok({ name, kind, methods: [...new Set(methods)], numberHint, openingMinor: opening * 100, openingOn, status: form.get('status') === 'closed' ? 'closed' : 'active' });
}

/** Saves an account. A method given to it is taken away from any other account, so each method has one home. */
export async function saveAccount(db: D1Database, actor: string, id: string | null, v: AccountInput): Promise<Result<string>> {
  const aid = id || newId('acct');
  if (id) {
    // An opening balance inside closed books would change a finished statement.
    const old = await db.prepare('SELECT opening_minor AS m, opening_on AS d FROM acc_accounts WHERE id = ?').bind(id).first<{ m: number; d: string }>();
    if (old && (old.m !== v.openingMinor || old.d !== v.openingOn) && ((await dayIsClosed(db, old.d || '0000-01-01')) || (await dayIsClosed(db, v.openingOn || '0000-01-01')))) return fail('closed');
  }
  const others = (await listAccounts(db)).filter((a) => a.id !== aid);
  const stmts: D1PreparedStatement[] = [];
  for (const o of others) {
    const kept = o.methods.split(',').filter((m) => m && !v.methods.includes(m));
    if (kept.join(',') !== o.methods) stmts.push(db.prepare('UPDATE acc_accounts SET methods = ? WHERE id = ?').bind(kept.join(','), o.id));
  }
  stmts.push(
    id
      ? db
          .prepare('UPDATE acc_accounts SET name = ?, kind = ?, methods = ?, number_hint = ?, opening_minor = ?, opening_on = ?, status = ? WHERE id = ?')
          .bind(v.name, v.kind, v.methods.join(','), v.numberHint, v.openingMinor, v.openingOn, v.status, id)
      : db
          .prepare('INSERT INTO acc_accounts (id, name, kind, methods, number_hint, opening_minor, opening_on, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(aid, v.name, v.kind, v.methods.join(','), v.numberHint, v.openingMinor, v.openingOn, v.status, actor),
  );
  try {
    const out = await db.batch(stmts);
    if (id && !out[out.length - 1]?.meta.changes) return fail('missing');
  } catch {
    return fail('name_taken');
  }
  await log(db, actor, id ? 'accounts.account.update' : 'accounts.account.create', `account:${aid}`, { ...v, opening: v.openingMinor / 100 });
  return ok(aid);
}

/** Puts a department's fees under a project (or none). */
export async function setCourseProject(db: D1Database, actor: string, courseId: string, projectId: string | null): Promise<boolean> {
  const r = await db
    .prepare('UPDATE offline_courses SET project_id = (SELECT id FROM acc_projects WHERE id = ?) WHERE id = ?')
    .bind(projectId ?? '', courseId)
    .run();
  if (!r.meta.changes) return false;
  await log(db, actor, 'accounts.course.project', `offline_course:${courseId}`, { projectId });
  return true;
}

export async function courseProjects(db: D1Database) {
  const { results } = await db
    .prepare(`SELECT id, title, status, coalesce(project_id, '') AS projectId FROM offline_courses ORDER BY status, title`)
    .all<{ id: string; title: string; status: string; projectId: string }>();
  return results;
}

/** method -> account id. */
export const methodMap = (accounts: readonly Account[]) => {
  const m = new Map<string, string>();
  for (const a of accounts) for (const x of a.methods.split(',')) if (x && !m.has(x)) m.set(x, a.id);
  return m;
};

// ---- Other income and transfers ----------------------------------------------

export type EntryKind = 'income' | 'transfer';
export const VOUCHER_PREFIX = { expense: 'DV', income: 'CV', transfer: 'JV' } as const;
export const voucherCode = (kind: keyof typeof VOUCHER_PREFIX, no: number | null | undefined) => (no ? `${VOUCHER_PREFIX[kind]}-${String(no).padStart(4, '0')}` : '');

export type EntryInput = {
  kind: EntryKind;
  day: string;
  amountMinor: number;
  accountId: string;
  fromAccountId: string | null;
  projectId: string | null;
  fundId: string | null;
  category: string;
  party: string;
  description: string;
  reference: string;
  nonce: string | null;
  donationReference?: string;
};

export function parseEntryForm(form: FormData, today: string): Result<EntryInput> {
  const kind = form.get('kind') === 'transfer' ? 'transfer' : 'income';
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 100_000_000) return fail('amount');
  const day = text(form, 'day', 10) || today;
  if (!isYmd(day) || day > today) return fail('day');
  const accountId = text(form, 'accountId', 40);
  if (!accountId) return fail('account');
  const fromAccountId = kind === 'transfer' ? text(form, 'fromAccountId', 40) : '';
  if (kind === 'transfer' && (!fromAccountId || fromAccountId === accountId)) return fail('from_account');
  const donationReference = kind === 'income' ? text(form, 'donationReference', 80).toUpperCase() : '';
  const category = donationReference ? DONATION_TRANSFER_CATEGORY : kind === 'income' ? text(form, 'category', 60) : 'স্থানান্তর';
  if (category === DONATION_TRANSFER_CATEGORY && (!donationReference || !text(form, 'reference', 80))) return fail('donation');
  if (category.length < 2) return fail('category');
  return ok({
    kind,
    day,
    amountMinor: amount * 100,
    accountId,
    fromAccountId: fromAccountId || null,
    projectId: kind === 'income' ? text(form, 'projectId', 40) || null : null,
    fundId: kind === 'income' ? text(form, 'fundId', 40) || GENERAL_FUND : null,
    category,
    party: text(form, 'party', 120),
    description: longText(form, 'description', 500),
    reference: text(form, 'reference', 80),
    nonce: nonceOf(form),
    donationReference,
  });
}

/** Saves other income or a transfer with the next voucher number of its kind. */
export async function recordEntry(db: D1Database, actor: string, v: EntryInput): Promise<Result<{ id: string; voucherNo: number }>> {
  const seen = async () =>
    v.nonce ? await db.prepare('SELECT id, voucher_no AS voucherNo FROM acc_entries WHERE nonce = ?').bind(v.nonce).first<{ id: string; voucherNo: number }>() : null;
  const before = await seen();
  if (before) return ok(before);
  if (await dayIsClosed(db, v.day)) return fail('closed');
  const accounts = await listAccounts(db, false);
  if (!accounts.some((a) => a.id === v.accountId) || (v.fromAccountId && !accounts.some((a) => a.id === v.fromAccountId))) return fail('account');
  const donation = v.donationReference ? await db.prepare(`SELECT id, amount_minor AS amount FROM donations
    WHERE (upper(reference) = ?1 OR ('RCP-' || printf('%06d', receipt_no)) = ?1)
    AND status = 'paid' AND voided_at IS NULL`).bind(v.donationReference).first<{ id: string; amount: number }>() : null;
  if (v.donationReference && (!donation || v.kind !== 'income' || v.amountMinor > donation.amount || !v.reference)) return fail('donation');
  const id = newId('ace');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await db
        .prepare(
          `INSERT INTO acc_entries (id, kind, voucher_no, day, amount_minor, account_id, from_account_id, project_id, fund_id, category, party, description, reference, recorded_by, nonce, donation_id)
           SELECT ?1, ?2, (SELECT coalesce(max(voucher_no), 0) + 1 FROM acc_entries WHERE kind = ?2), ?3, ?4, ?5, ?6,
                   (SELECT id FROM acc_projects WHERE id = ?7), (SELECT id FROM acc_funds WHERE id = ?8), ?9, ?10, ?11, ?12, ?13, ?14, ?15
           WHERE ?15 IS NULL OR (EXISTS (SELECT 1 FROM donations d WHERE d.id = ?15 AND d.status = 'paid' AND d.voided_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM acc_entries x WHERE x.donation_id = ?15 AND x.voided_at IS NULL))
           RETURNING voucher_no AS voucherNo`,
        )
        .bind(id, v.kind, v.day, v.amountMinor, v.accountId, v.fromAccountId, v.projectId ?? '', v.fundId ?? '', donation ? DONATION_TRANSFER_CATEGORY : v.category, v.party, v.description, v.reference, actor, v.nonce, donation?.id ?? null)
        .first<{ voucherNo: number }>();
      if (!r) return fail('donation');
      await log(db, actor, `accounts.${v.kind}`, `acc_entry:${id}`, { voucherNo: r!.voucherNo, amount: v.amountMinor / 100, day: v.day, category: donation ? DONATION_TRANSFER_CATEGORY : v.category, donationId: donation?.id });
      return ok({ id, voucherNo: r!.voucherNo });
    } catch (e) {
      const again = await seen();
      if (again) return ok(again);
      if (attempt === 2 || !String(e).includes('UNIQUE')) throw e;
    }
  }
  throw new Error('unreachable');
}

export async function voidEntry(db: D1Database, actor: string, id: string, reason: string): Promise<boolean> {
  const why = reason.trim().slice(0, 300);
  if (why.length < 2) return false;
  const r = await db
    .prepare(
      `UPDATE acc_entries SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL AND day > ${CLOSED_THROUGH_SQL}
       RETURNING kind, voucher_no AS voucherNo, amount_minor AS amount`,
    )
    .bind(actor, why, id)
    .first<{ kind: string; voucherNo: number; amount: number }>();
  if (!r) return false;
  await log(db, actor, 'accounts.entry.void', `acc_entry:${id}`, { kind: r.kind, voucherNo: r.voucherNo, amount: r.amount / 100, reason: why });
  return true;
}

export type Entry = {
  id: string;
  kind: EntryKind;
  voucherNo: number;
  day: string;
  amountMinor: number;
  accountId: string;
  accountName: string;
  fromAccountId: string | null;
  fromAccountName: string | null;
  projectId: string | null;
  projectName: string | null;
  fundId: string | null;
  fundName: string | null;
  category: string;
  party: string;
  description: string;
  reference: string;
  donationReference: string | null;
  recordedBy: string;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
};

const ENTRY_SELECT = `SELECT x.id, x.kind, x.voucher_no AS voucherNo, x.day, x.amount_minor AS amountMinor, x.account_id AS accountId, a.name AS accountName,
  x.from_account_id AS fromAccountId, fa.name AS fromAccountName, x.project_id AS projectId, p.name AS projectName, x.fund_id AS fundId, f.name AS fundName,
  d.reference AS donationReference, x.category, x.party, x.description, x.reference, x.recorded_by AS recordedBy, x.voided_at AS voidedAt, x.void_reason AS voidReason, x.created_at AS createdAt
  FROM acc_entries x JOIN acc_accounts a ON a.id = x.account_id LEFT JOIN acc_accounts fa ON fa.id = x.from_account_id
  LEFT JOIN acc_projects p ON p.id = x.project_id LEFT JOIN acc_funds f ON f.id = x.fund_id LEFT JOIN donations d ON d.id = x.donation_id`;

export async function listEntries(db: D1Database, from: string, to: string, limit = 500): Promise<Entry[]> {
  const { results } = await db.prepare(`${ENTRY_SELECT} WHERE x.day BETWEEN ? AND ? ORDER BY x.day DESC, x.created_at DESC LIMIT ?`).bind(from, to, limit).all<Entry>();
  return results;
}

export const getEntry = (db: D1Database, id: string) => db.prepare(`${ENTRY_SELECT} WHERE x.id = ?`).bind(id).first<Entry>();

// ---- Transactions and balances ---------------------------------------------------

export type Txn = {
  id: string;
  day: string;
  source: 'fee' | 'income' | 'expense' | 'transfer';
  ref: string;
  link: string;
  accountId: string;
  projectId: string;
  fundId: string;
  head: string;
  party: string;
  inMinor: number;
  outMinor: number;
};

/**
 * Every counted movement of money between two days, oldest first. A
 * transfer gives two rows (out of one account, into the other). Movements
 * dated before an account's opening date are left out: its opening balance
 * already holds them.
 */
export async function transactions(db: D1Database, from: string, to: string, limit = 5000): Promise<Txn[]> {
  const accounts = await listAccounts(db);
  const byMethod = methodMap(accounts);
  const opening = new Map(accounts.map((a) => [a.id, a.openingOn]));
  const [fees, spent, entries] = await db.batch([
    db
      .prepare(
        `SELECT p.id, p.paid_on AS day, p.receipt_no AS no, p.amount_minor AS amount, p.method, p.posted_account_id AS accountId, coalesce(p.posted_project_id, c.project_id, '') AS projectId, coalesce(nullif(p.allocation_label, ''), c.title) AS head, s.name AS party, s.id AS studentId
         FROM offline_payments p JOIN offline_enrollments e ON e.id = p.enrollment_id JOIN offline_courses c ON c.id = e.course_id JOIN offline_students s ON s.id = e.student_id
         WHERE p.voided_at IS NULL AND p.paid_on BETWEEN ? AND ? ORDER BY p.paid_on, p.receipt_no LIMIT ?`,
      )
      .bind(from, to, limit),
    db
      .prepare(
        `SELECT id, spent_on AS day, voucher_no AS no, amount_minor AS amount, method, posted_account_id AS accountId, coalesce(project_id, '') AS projectId, coalesce(fund_id, '${GENERAL_FUND}') AS fundId,
         category AS head, CASE WHEN party <> '' THEN party ELSE description END AS party
         FROM expenses WHERE voided_at IS NULL AND status = 'approved' AND spent_on BETWEEN ? AND ? ORDER BY spent_on, created_at LIMIT ?`,
      )
      .bind(from, to, limit),
    db
      .prepare(
        `SELECT id, kind, voucher_no AS no, day, amount_minor AS amount, account_id AS accountId, from_account_id AS fromAccountId, coalesce(project_id, '') AS projectId,
         coalesce(fund_id, '${GENERAL_FUND}') AS fundId, category AS head, party FROM acc_entries WHERE voided_at IS NULL AND day BETWEEN ? AND ? ORDER BY day, created_at LIMIT ?`,
      )
      .bind(from, to, limit),
  ]);
  type Row = { id: string; day: string; no: number | null; amount: number; method?: string; projectId: string; fundId?: string; head: string; party: string; studentId?: string; kind?: string; accountId?: string; fromAccountId?: string | null };
  const out: Txn[] = [];
  const push = (t: Txn) => {
    if (t.day >= (opening.get(t.accountId) ?? '')) out.push(t);
  };
  for (const r of fees!.results as Row[]) {
    push({ id: r.id, day: r.day, source: 'fee', ref: `রসিদ ${r.no}`, link: `/admin/offline/receipt/${r.id}`, accountId: r.accountId ?? byMethod.get(r.method!) ?? UNASSIGNED, projectId: r.projectId, fundId: GENERAL_FUND, head: r.head, party: r.party, inMinor: r.amount, outMinor: 0 });
  }
  for (const r of spent!.results as Row[]) {
    push({ id: r.id, day: r.day, source: 'expense', ref: voucherCode('expense', r.no) || 'বেতন', link: `/admin/offline/accounts/voucher/${r.id}`, accountId: r.accountId ?? byMethod.get(r.method!) ?? UNASSIGNED, projectId: r.projectId, fundId: r.fundId!, head: r.head, party: r.party, inMinor: 0, outMinor: r.amount });
  }
  for (const r of entries!.results as Row[]) {
    const base = { id: r.id, day: r.day, link: `/admin/offline/accounts/voucher/${r.id}`, projectId: r.projectId, fundId: r.fundId!, head: r.head, party: r.party };
    if (r.kind === 'income') push({ ...base, source: 'income', ref: voucherCode('income', r.no), accountId: r.accountId!, inMinor: r.amount, outMinor: 0 });
    else {
      push({ ...base, source: 'transfer', ref: voucherCode('transfer', r.no), accountId: r.fromAccountId!, inMinor: 0, outMinor: r.amount });
      push({ ...base, source: 'transfer', ref: voucherCode('transfer', r.no), accountId: r.accountId!, inMinor: r.amount, outMinor: 0 });
    }
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export type Balance = { id: string; name: string; kind: AccountKind | 'none'; numberHint: string; openingMinor: number; inMinor: number; outMinor: number; balanceMinor: number; status: string };

/** Each account's balance at the end of a day (opening balance plus everything since its opening date). */
export async function balancesAsOf(db: D1Database, day: string): Promise<Balance[]> {
  const accounts = await listAccounts(db);
  const byMethod = methodMap(accounts);
  const openOf = new Map(accounts.map((a) => [a.id, a.openingOn]));
  const pairs = ALL_METHODS.map((m) => [m, byMethod.get(m) ?? UNASSIGNED, openOf.get(byMethod.get(m) ?? '') ?? ''] as const);
  const values = pairs.map(() => '(?, ?, ?)').join(', ');
  const flat = pairs.flat();
  const [fees, spent, entries] = await db.batch([
    db
      .prepare(`WITH m(method, account, start) AS (VALUES ${values}) SELECT coalesce(p.posted_account_id,m.account) AS account, sum(p.amount_minor) AS v
                FROM offline_payments p JOIN m ON m.method = p.method LEFT JOIN acc_accounts a ON a.id = p.posted_account_id
                WHERE p.voided_at IS NULL AND p.paid_on >= (CASE WHEN p.posted_account_id IS NULL THEN m.start ELSE coalesce(a.opening_on,'') END) AND p.paid_on <= ? GROUP BY 1`)
      .bind(...flat, day),
    db
      .prepare(`WITH m(method, account, start) AS (VALUES ${values}) SELECT coalesce(x.posted_account_id,m.account) AS account, sum(x.amount_minor) AS v
                FROM expenses x JOIN m ON m.method = x.method LEFT JOIN acc_accounts a ON a.id = x.posted_account_id
                WHERE x.voided_at IS NULL AND x.status = 'approved' AND x.spent_on >= (CASE WHEN x.posted_account_id IS NULL THEN m.start ELSE coalesce(a.opening_on,'') END) AND x.spent_on <= ? GROUP BY 1`)
      .bind(...flat, day),
    db
      .prepare(
        `SELECT a.id, (SELECT coalesce(sum(amount_minor), 0) FROM acc_entries x WHERE x.voided_at IS NULL AND x.account_id = a.id AND x.day >= a.opening_on AND x.day <= ?1) AS inV,
                (SELECT coalesce(sum(amount_minor), 0) FROM acc_entries x WHERE x.voided_at IS NULL AND x.kind = 'transfer' AND x.from_account_id = a.id AND x.day >= a.opening_on AND x.day <= ?1) AS outV
         FROM acc_accounts a`,
      )
      .bind(day),
  ]);
  const rows = new Map<string, Balance>();
  for (const a of accounts) {
    const counted = !a.openingOn || a.openingOn <= day;
    rows.set(a.id, { id: a.id, name: a.name, kind: a.kind, numberHint: a.numberHint, openingMinor: counted ? a.openingMinor : 0, inMinor: 0, outMinor: 0, balanceMinor: 0, status: a.status });
  }
  rows.set(UNASSIGNED, { id: UNASSIGNED, name: 'কোনো হিসাবে বসানো হয়নি', kind: 'none', numberHint: '', openingMinor: 0, inMinor: 0, outMinor: 0, balanceMinor: 0, status: 'active' });
  for (const r of fees!.results as { account: string; v: number }[]) (rows.get(r.account) ?? rows.get(UNASSIGNED))!.inMinor += r.v;
  for (const r of spent!.results as { account: string; v: number }[]) (rows.get(r.account) ?? rows.get(UNASSIGNED))!.outMinor += r.v;
  for (const r of entries!.results as { id: string; inV: number; outV: number }[]) {
    const b = rows.get(r.id);
    if (!b) continue;
    b.inMinor += r.inV;
    b.outMinor += r.outV;
  }
  const out = [...rows.values()].map((b) => ({ ...b, balanceMinor: b.openingMinor + b.inMinor - b.outMinor }));
  // Hide the "not placed" row when nothing is in it.
  return out.filter((b) => b.id !== UNASSIGNED || b.inMinor || b.outMinor);
}

export type HeadTotal = { id: string; name: string; inMinor: number; outMinor: number };

const sumBy = (txns: readonly Txn[], key: (t: Txn) => string) => {
  const m = new Map<string, { inMinor: number; outMinor: number }>();
  for (const t of txns) {
    if (t.source === 'transfer') continue;
    const k = key(t);
    const v = m.get(k) ?? { inMinor: 0, outMinor: 0 };
    v.inMinor += t.inMinor;
    v.outMinor += t.outMinor;
    m.set(k, v);
  }
  return m;
};

/** Income and spending of each fund between two days, and each fund's balance up to the end day. */
export async function fundSummary(db: D1Database, from: string, to: string) {
  const [funds, range, all] = await Promise.all([listFunds(db, true), transactions(db, from, to), transactions(db, '0000-01-01', to, 100_000)]);
  const r = sumBy(range, (t) => t.fundId);
  const a = sumBy(all, (t) => t.fundId);
  return funds.map((f) => ({
    ...f,
    inMinor: r.get(f.id)?.inMinor ?? 0,
    outMinor: r.get(f.id)?.outMinor ?? 0,
    balanceMinor: (a.get(f.id)?.inMinor ?? 0) - (a.get(f.id)?.outMinor ?? 0),
  }));
}

/** Income and spending of each project between two days ('' = not under a project). */
export async function projectSummary(db: D1Database, from: string, to: string): Promise<HeadTotal[]> {
  const [projects, txns] = await Promise.all([listProjects(db, true), transactions(db, from, to)]);
  const m = sumBy(txns, (t) => t.projectId);
  const rows: HeadTotal[] = projects.map((p) => ({ id: p.id, name: p.name, ...(m.get(p.id) ?? { inMinor: 0, outMinor: 0 }) }));
  const none = m.get('');
  if (none) rows.push({ id: '', name: 'কোনো প্রকল্পে নয় (সাধারণ)', ...none });
  return rows;
}

// ---- Budgets ----------------------------------------------------------------------

export type Budget = { id: string; year: string; projectId: string; projectName: string | null; category: string; amountMinor: number; note: string };

export function parseBudgetForm(form: FormData): Result<{ year: string; projectId: string; category: string; amountMinor: number; note: string }> {
  const year = text(form, 'year', 4);
  if (!/^20\d\d$/.test(year)) return fail('year');
  const amount = parseTaka(form.get('amount'));
  if (amount === null || amount < 1 || amount > 1_000_000_000) return fail('amount');
  const projectId = text(form, 'projectId', 40);
  const category = text(form, 'category', 60);
  if (!projectId && !category) return fail('head');
  return ok({ year, projectId, category, amountMinor: amount * 100, note: text(form, 'note', 200) });
}

/** One budget per year, project and head; saving the same again changes the amount. */
export async function saveBudget(db: D1Database, actor: string, v: { year: string; projectId: string; category: string; amountMinor: number; note: string }): Promise<Result<string>> {
  if (v.projectId && !(await db.prepare('SELECT 1 AS x FROM acc_projects WHERE id = ?').bind(v.projectId).first())) return fail('project');
  const id = newId('bud');
  await db
    .prepare(
      `INSERT INTO acc_budgets (id, year, project_id, category, amount_minor, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (year, project_id, category) DO UPDATE SET amount_minor = excluded.amount_minor, note = excluded.note, created_by = excluded.created_by,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    )
    .bind(id, v.year, v.projectId, v.category, v.amountMinor, v.note, actor)
    .run();
  await log(db, actor, 'accounts.budget.save', `budget:${v.year}:${v.projectId}:${v.category}`, { amount: v.amountMinor / 100 });
  return ok(id);
}

export async function removeBudget(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db.prepare('DELETE FROM acc_budgets WHERE id = ? RETURNING year, project_id AS projectId, category, amount_minor AS amount').bind(id).first<{ year: string; projectId: string; category: string; amount: number }>();
  if (!r) return false;
  await log(db, actor, 'accounts.budget.remove', `budget:${r.year}:${r.projectId}:${r.category}`, { amount: r.amount / 100 });
  return true;
}

export type BudgetLine = Budget & { actualMinor: number; varianceMinor: number; usedPercent: number };

/** Each budget of a year against what was actually spent (approved expenses), up to a day. */
export async function budgetVsActual(db: D1Database, year: string, upTo: string): Promise<BudgetLine[]> {
  const end = upTo < `${year}-12-31` ? upTo : `${year}-12-31`;
  const [budgets, actual] = await db.batch([
    db
      .prepare(
        `SELECT b.id, b.year, b.project_id AS projectId, p.name AS projectName, b.category, b.amount_minor AS amountMinor, b.note FROM acc_budgets b
         LEFT JOIN acc_projects p ON p.id = b.project_id WHERE b.year = ? ORDER BY p.name, b.category`,
      )
      .bind(year),
    db
      .prepare(
        `SELECT coalesce(project_id, '') AS projectId, category, sum(amount_minor) AS v FROM expenses
         WHERE voided_at IS NULL AND status = 'approved' AND spent_on BETWEEN ? AND ? GROUP BY projectId, category`,
      )
      .bind(`${year}-01-01`, end),
  ]);
  const spent = actual!.results as { projectId: string; category: string; v: number }[];
  return (budgets!.results as Budget[]).map((b) => {
    const actualMinor = spent.filter((s) => (!b.projectId || s.projectId === b.projectId) && (!b.category || s.category === b.category)).reduce((a, s) => a + s.v, 0);
    return { ...b, actualMinor, varianceMinor: b.amountMinor - actualMinor, usedPercent: Math.round((actualMinor / b.amountMinor) * 100) };
  });
}

// ---- Reconciliation ---------------------------------------------------------------

export type Reconciliation = { id: string; accountId: string; accountName: string; asOf: string; statementMinor: number; bookMinor: number; note: string; createdBy: string; createdAt: string };

export function parseReconcileForm(form: FormData, today: string): Result<{ accountId: string; asOf: string; statementMinor: number; note: string }> {
  const accountId = text(form, 'accountId', 40);
  if (!accountId) return fail('account');
  const asOf = text(form, 'asOf', 10) || today;
  if (!isYmd(asOf) || asOf > today) return fail('day');
  const s = signedTaka(form.get('statement'));
  if (s === null || !String(form.get('statement') ?? '').trim()) return fail('statement');
  return ok({ accountId, asOf, statementMinor: s * 100, note: longText(form, 'note', 500) });
}

/** Saves a count of the cash box or a bank statement against the books for that day. */
export async function saveReconciliation(db: D1Database, actor: string, v: { accountId: string; asOf: string; statementMinor: number; note: string }): Promise<Result<Reconciliation>> {
  const book = (await balancesAsOf(db, v.asOf)).find((b) => b.id === v.accountId);
  if (!book || v.accountId === UNASSIGNED) return fail('account');
  const id = newId('rec');
  await db
    .prepare('INSERT INTO acc_reconciliations (id, account_id, as_of, statement_minor, book_minor, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, v.accountId, v.asOf, v.statementMinor, book.balanceMinor, v.note, actor)
    .run();
  await log(db, actor, 'accounts.reconcile', `account:${v.accountId}`, { asOf: v.asOf, statement: v.statementMinor / 100, book: book.balanceMinor / 100, difference: (v.statementMinor - book.balanceMinor) / 100 });
  return ok({ id, accountId: v.accountId, accountName: book.name, asOf: v.asOf, statementMinor: v.statementMinor, bookMinor: book.balanceMinor, note: v.note, createdBy: actor, createdAt: new Date().toISOString() });
}

export async function listReconciliations(db: D1Database, limit = 40): Promise<Reconciliation[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.account_id AS accountId, a.name AS accountName, r.as_of AS asOf, r.statement_minor AS statementMinor, r.book_minor AS bookMinor, r.note,
       r.created_by AS createdBy, r.created_at AS createdAt FROM acc_reconciliations r JOIN acc_accounts a ON a.id = r.account_id ORDER BY r.as_of DESC, r.created_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Reconciliation>();
  return results;
}

// ---- Receipts and payments statement ------------------------------------------------

export type Statement = {
  from: string;
  to: string;
  openingMinor: number;
  newOpeningMinor: number;
  receipts: { head: string; group: string; minor: number }[];
  payments: { head: string; group: string; minor: number }[];
  receiptsMinor: number;
  paymentsMinor: number;
  closingMinor: number;
  closingByAccount: Balance[];
  openingByAccount: Balance[];
};

/**
 * The receipts and payments statement auditors ask for: what was in hand at
 * the start, every receipt and payment by head, and what is in hand at the
 * end, which must equal the account balances. Transfers between accounts
 * are left out (they are neither).
 */
export async function receiptsAndPayments(db: D1Database, from: string, to: string): Promise<Statement> {
  const [openingByAccount, closingByAccount, txns, accounts] = await Promise.all([balancesAsOf(db, addDays(from, -1)), balancesAsOf(db, to), transactions(db, from, to, 100_000), listAccounts(db)]);
  const receipts = new Map<string, { group: string; minor: number }>();
  const payments = new Map<string, { group: string; minor: number }>();
  for (const t of txns) {
    if (t.source === 'transfer') continue;
    if (t.inMinor) {
      const key = t.source === 'fee' ? `ছাত্রদের ফি: ${t.head}` : t.head;
      const v = receipts.get(key) ?? { group: t.source === 'fee' ? 'ফি' : 'অন্যান্য আয়', minor: 0 };
      v.minor += t.inMinor;
      receipts.set(key, v);
    }
    if (t.outMinor) {
      const v = payments.get(t.head) ?? { group: 'খরচ', minor: 0 };
      v.minor += t.outMinor;
      payments.set(t.head, v);
    }
  }
  // Accounts opened inside the period bring their opening balance as a receipt.
  const newOpeningMinor = accounts.filter((a) => a.openingOn && a.openingOn >= from && a.openingOn <= to).reduce((s, a) => s + a.openingMinor, 0);
  const list = (m: Map<string, { group: string; minor: number }>) => [...m.entries()].map(([head, v]) => ({ head, ...v })).sort((a, b) => a.group.localeCompare(b.group) || b.minor - a.minor);
  const openingMinor = openingByAccount.reduce((s, b) => s + b.balanceMinor, 0);
  const receiptsMinor = [...receipts.values()].reduce((s, v) => s + v.minor, 0);
  const paymentsMinor = [...payments.values()].reduce((s, v) => s + v.minor, 0);
  return {
    from,
    to,
    openingMinor,
    newOpeningMinor,
    receipts: list(receipts),
    payments: list(payments),
    receiptsMinor,
    paymentsMinor,
    closingMinor: closingByAccount.reduce((s, b) => s + b.balanceMinor, 0),
    closingByAccount,
    openingByAccount,
  };
}

// ---- Expense approval rules (two steps) --------------------------------------------

export type ApprovalWho = { owner: boolean; full: boolean };

/**
 * What happens to a new expense. An owner's is counted at once. Above the
 * owner's limit it needs the owner: a member with full accounts power gives
 * the first step (checked) by recording it. Above the first limit, a member
 * without full power waits for someone with it.
 */
export function newExpenseStage(amountTaka: number, who: ApprovalWho, rules: { approvalOver: number; ownerOver: number }): 'approved' | 'pending' | 'checked' {
  if (who.owner) return 'approved';
  if (rules.ownerOver > 0 && amountTaka > rules.ownerOver) return who.full ? 'checked' : 'pending';
  if (rules.approvalOver > 0 && amountTaka > rules.approvalOver && !who.full) return 'pending';
  return 'approved';
}
