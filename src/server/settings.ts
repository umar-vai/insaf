import { log } from './admin';

// Office rules the owner can change on /admin/offline/settings without a new
// version of the site. Each has a safe default, used until it is changed.

export const SALARY_BASES = ['class_days', 'thirty', 'month_days', 'none'] as const;
export type SalaryBasis = (typeof SALARY_BASES)[number];
export const SALARY_BASIS_BN: Record<SalaryBasis, string> = {
  class_days: 'শুধু ক্লাসের দিন দিয়ে ভাগ (রুটিন অনুযায়ী)',
  thirty: 'মূল বেতন ÷ ৩০',
  month_days: 'মাসের আসল দিন দিয়ে ভাগ',
  none: 'নিজে থেকে কিছু কাটা হবে না',
};

export type Settings = {
  /** Approved leave days per month that are still paid. */
  paidLeaveDays: number;
  salaryBasis: SalaryBasis;
  /** Offline students may pay dues online through SSLCommerz. */
  onlineFees: boolean;
  /** Teachers see the phone numbers of students in their batches. */
  teacherSeesPhones: boolean;
  teacherCanPostNotice: boolean;
  teacherCanShareMaterial: boolean;
  /** Teachers mark attendance for their own batches. */
  teacherTakesAttendance: boolean;
  /** Starting text of the WhatsApp due reminder. */
  dueTemplate: string;
  /** Expenses above this many taka wait for the owner's approval (0 = never). */
  expenseApprovalOver: number;
  /** Offline students rate their teachers once a month. */
  teacherRatings: boolean;
  /** Late fee in taka added once to each installment still unpaid after the grace days (0 = no late fee). */
  lateFeeTaka: number;
  /** Days after an installment's date before the late fee is added. */
  lateGraceDays: number;
  /** How many days a library book is lent for. */
  libraryLoanDays: number;
  /** Fine in taka for each day a student keeps a book late (0 = no fine). */
  libraryFinePerDayTaka: number;
  /** Teachers and staff mark their own arrival and leaving in the teacher panel. */
  staffSelfAttendance: boolean;
  /** Office start time (HH:MM). Arriving after it counts as late; empty: never late. */
  staffStartTime: string;
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_DUE_TEMPLATE =
  'আসসালামু আলাইকুম, {name}। মাদরাসাতুল ইনসাফে {course} এর {amount} বকেয়া আছে (তারিখ ছিল {date})। অনুগ্রহ করে দ্রুত পরিশোধ করুন। জাযাকাল্লাহু খাইরান।';

export const DEFAULTS: Settings = {
  paidLeaveDays: 2,
  salaryBasis: 'class_days',
  onlineFees: true,
  teacherSeesPhones: true,
  teacherCanPostNotice: true,
  teacherCanShareMaterial: true,
  teacherTakesAttendance: true,
  dueTemplate: DEFAULT_DUE_TEMPLATE,
  expenseApprovalOver: 2000,
  teacherRatings: true,
  lateFeeTaka: 0,
  lateGraceDays: 7,
  libraryLoanDays: 14,
  libraryFinePerDayTaka: 0,
  staffSelfAttendance: false,
  staffStartTime: '',
};

/** Allowed range for each number. */
const RANGE: Partial<Record<keyof Settings, [number, number]>> = { paidLeaveDays: [0, 31], expenseApprovalOver: [0, 100_000_000], lateFeeTaka: [0, 100_000], lateGraceDays: [0, 90], libraryLoanDays: [1, 365], libraryFinePerDayTaka: [0, 10_000] };
const inRange = (k: keyof Settings, n: number) => Number.isInteger(n) && n >= (RANGE[k]?.[0] ?? 0) && n <= (RANGE[k]?.[1] ?? 0);
const toNumber = (raw: unknown) => Number(String(raw ?? '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[,\s]/g, ''));

const KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

function read(key: keyof Settings, raw: string | undefined): Settings[keyof Settings] {
  const d = DEFAULTS[key];
  if (raw === undefined) return d;
  if (typeof d === 'boolean') return raw === '1';
  if (typeof d === 'number') {
    const n = Number(raw);
    return inRange(key, n) ? n : d;
  }
  if (key === 'salaryBasis') return (SALARY_BASES as readonly string[]).includes(raw) ? raw : d;
  if (key === 'staffStartTime') return HHMM.test(raw) ? raw : '';
  return raw.slice(0, 1000) || d;
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  return Object.fromEntries(KEYS.map((k) => [k, read(k, map.get(k))])) as Settings;
}

/** Reads the settings form. Unchecked boxes mean off. */
export function parseSettingsForm(form: FormData): Settings {
  const s = { ...DEFAULTS };
  for (const k of ['paidLeaveDays', 'expenseApprovalOver', 'lateFeeTaka', 'lateGraceDays', 'libraryLoanDays', 'libraryFinePerDayTaka'] as const) {
    const n = toNumber(form.get(k));
    s[k] = inRange(k, n) ? n : DEFAULTS[k];
  }
  const basis = String(form.get('salaryBasis') ?? '');
  s.salaryBasis = (SALARY_BASES as readonly string[]).includes(basis) ? (basis as SalaryBasis) : DEFAULTS.salaryBasis;
  for (const k of ['onlineFees', 'teacherSeesPhones', 'teacherCanPostNotice', 'teacherCanShareMaterial', 'teacherTakesAttendance', 'teacherRatings', 'staffSelfAttendance'] as const) s[k] = form.get(k) === 'on';
  const start = String(form.get('staffStartTime') ?? '').trim();
  s.staffStartTime = HHMM.test(start) ? start : '';
  s.dueTemplate = String(form.get('dueTemplate') ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1000) || DEFAULT_DUE_TEMPLATE;
  return s;
}

export async function saveSettings(db: D1Database, actor: string, s: Settings): Promise<void> {
  const before = await getSettings(db);
  const changed = KEYS.filter((k) => before[k] !== s[k]);
  if (!changed.length) return;
  await db.batch(
    changed.map((k) => {
      const v = s[k];
      return db
        .prepare(
          `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        )
        .bind(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v), actor);
    }),
  );
  await log(db, actor, 'settings.update', 'settings', Object.fromEntries(changed.map((k) => [k, { from: before[k], to: s[k] }])));
}
