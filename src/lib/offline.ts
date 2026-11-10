// Offline course ledger: fee schedules worked out from what was agreed at
// enrolment and the payments recorded since. Pure functions, no database.
// Money is integer poisha; installments are whole taka. Dates are
// "YYYY-MM-DD" in Dhaka time.

import { bnDigits } from './format';

export const PLAN_MONTHS = [0, 1, 2, 3, 4, 6, 12] as const;
/** What staff can pick. 'online' is set only by a confirmed SSLCommerz payment. */
export const PAY_METHODS = ['cash', 'bkash', 'nagad', 'rocket', 'bank', 'other'] as const;
export type PayMethod = (typeof PAY_METHODS)[number] | 'online';

export const METHOD_BN: Record<PayMethod, string> = {
  cash: 'ক্যাশ',
  bkash: 'বিকাশ',
  nagad: 'নগদ',
  rocket: 'রকেট',
  bank: 'ব্যাংক',
  other: 'অন্যান্য',
  online: 'অনলাইন (SSLCommerz)',
};

export const OFFLINE_ENROLL_STATUS_BN: Record<string, string> = { active: 'চলছে', completed: 'শেষ', dropped: 'ছেড়ে দিয়েছে' };

export function planBn(months: number): string {
  if (months === 0) return 'একবারে পুরো টাকা';
  if (months === 1) return 'প্রতি মাসে';
  if (months === 12) return 'প্রতি বছরে';
  return `প্রতি ${bnDigits(months)} মাস পর পর`;
}

export function durationBn(months: number): string {
  if (months % 12 === 0) return `${bnDigits(months / 12)} বছর`;
  return `${bnDigits(months)} মাস`;
}

/** "1,200" or "১২০০" or "1200.00" -> 1200 (whole taka), else null. */
export function parseTaka(raw: unknown): number | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)))
    .replace(/[,\s]/g, '')
    .replace(/\.0+$/, '');
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Today's date in Dhaka. */
export function todayDhaka(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Adds months, keeping the day but never spilling into the next month (31 Jan + 1 = 28/29 Feb). */
export function addMonths(ymd: string, months: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** "2026-11-06" -> "৬ নভে, ২০২৬". */
export function dayBn(ymd: string | null | undefined): string {
  if (!ymd || !isYmd(ymd.slice(0, 10))) return '';
  return new Intl.DateTimeFormat('bn-BD', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${ymd.slice(0, 10)}T00:00:00Z`),
  );
}

export type Terms = {
  feeMinor: number;
  admissionFeeMinor: number;
  discountMinor: number;
  durationMonths: number;
  planMonths: number;
  startDate: string;
};

export type InstallmentState = 'paid' | 'partial' | 'overdue' | 'upcoming';
/** fee: a course fee installment. exam, late, other: a charge added on top. */
export type ItemKind = 'fee' | 'exam' | 'late' | 'other';
export type Installment = {
  /** Installment number for course fee items (1, 2, ...); 0 for charges. */
  n: number;
  kind: ItemKind;
  label: string;
  dueDate: string;
  amountMinor: number;
  paidMinor: number;
  state: InstallmentState;
};
/** An exam fee, late fee or other charge on one enrollment (not voided). */
export type Charge = { id: string; kind: Exclude<ItemKind, 'fee'>; label: string; amountMinor: number; dueDate: string };

export const ITEM_KIND_BN: Record<ItemKind, string> = { fee: 'কোর্স ফি', exam: 'পরীক্ষার ফি', late: 'লেট ফি', other: 'অন্যান্য' };

export type Ledger = {
  totalMinor: number;
  paidMinor: number;
  dueMinor: number;
  /** Unpaid part of items whose date has come. */
  overdueMinor: number;
  next: { dueDate: string; amountMinor: number } | null;
  /** Course fee installments and charges, in the order payments cover them. */
  installments: Installment[];
  /** What is owed, split by kind (course fee, exam fee, late fee, other). */
  byKind: Record<ItemKind, { totalMinor: number; dueMinor: number }>;
};

export const totalPayable = (t: Pick<Terms, 'feeMinor' | 'admissionFeeMinor' | 'discountMinor'>) =>
  Math.max(0, t.feeMinor + t.admissionFeeMinor - t.discountMinor);

/**
 * The installments for these terms. The course fee (after discount) is split
 * evenly in whole taka, the last one taking what is left over; the admission
 * fee is added to the first. Paying everything at once (plan 0), or a plan
 * longer than the course, is one installment on the start date.
 */
export function schedule(t: Terms): { dueDate: string; amountMinor: number }[] {
  const course = Math.max(0, t.feeMinor - t.discountMinor);
  const admission = Math.max(0, Math.min(t.admissionFeeMinor, t.feeMinor + t.admissionFeeMinor - t.discountMinor));
  const count = t.planMonths > 0 ? Math.max(1, Math.ceil(t.durationMonths / t.planMonths)) : 1;
  const each = Math.floor(course / 100 / count) * 100;
  return Array.from({ length: count }, (_, i) => ({
    dueDate: addMonths(t.startDate, i * t.planMonths),
    amountMinor: (i === count - 1 ? course - each * (count - 1) : each) + (i === 0 ? admission : 0),
  }));
}

/**
 * Schedule plus charges plus payments: what is paid, what is left, what is
 * late. Payments cover items in date order (a charge on the same day as an
 * installment comes after it).
 */
export function ledger(t: Terms, paidMinor: number, today: string, charges: readonly Charge[] = []): Ledger {
  const items = [
    ...schedule(t).map((s, i) => ({ n: i + 1, kind: 'fee' as ItemKind, label: `কিস্তি ${bnDigits(i + 1)}`, ...s, order: 0 })),
    ...charges.map((c) => ({ n: 0, kind: c.kind as ItemKind, label: c.label, dueDate: c.dueDate, amountMinor: c.amountMinor, order: 1 })),
  ].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.order - b.order);
  let left = paidMinor;
  const installments = items.map((s): Installment => {
    const paid = Math.min(left, s.amountMinor);
    left -= paid;
    const state: InstallmentState =
      paid >= s.amountMinor ? 'paid' : s.dueDate <= today ? 'overdue' : paid > 0 ? 'partial' : 'upcoming';
    return { n: s.n, kind: s.kind, label: s.label, dueDate: s.dueDate, amountMinor: s.amountMinor, paidMinor: paid, state };
  });
  const totalMinor = installments.reduce((a, s) => a + s.amountMinor, 0);
  const overdueMinor = installments.filter((s) => s.state === 'overdue').reduce((a, s) => a + s.amountMinor - s.paidMinor, 0);
  const open = installments.find((s) => s.paidMinor < s.amountMinor);
  const byKind = { fee: { totalMinor: 0, dueMinor: 0 }, exam: { totalMinor: 0, dueMinor: 0 }, late: { totalMinor: 0, dueMinor: 0 }, other: { totalMinor: 0, dueMinor: 0 } };
  for (const s of installments) {
    byKind[s.kind].totalMinor += s.amountMinor;
    byKind[s.kind].dueMinor += s.amountMinor - s.paidMinor;
  }
  return {
    totalMinor,
    paidMinor,
    dueMinor: Math.max(0, totalMinor - paidMinor),
    overdueMinor,
    next: open ? { dueDate: open.dueDate, amountMinor: open.amountMinor - open.paidMinor } : null,
    installments,
    byKind,
  };
}

/** Parses the charges column of an enrollment query (a JSON array). */
export function parseCharges(json: string | null | undefined): Charge[] {
  if (!json) return [];
  try {
    const rows = JSON.parse(json) as Charge[];
    return Array.isArray(rows) ? rows.filter((c) => c && typeof c.amountMinor === 'number' && c.amountMinor > 0) : [];
  } catch {
    return [];
  }
}

/** Adds days to "YYYY-MM-DD". */
export const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Course fee installments that should now carry a late fee: not fully paid
 * by the end of the grace days. Each installment gets one late fee only, so
 * those already charged (lateDone holds their numbers) are skipped.
 */
export function lateInstallments(l: Ledger, today: string, graceDays: number, lateDone: ReadonlySet<number>): Installment[] {
  return l.installments.filter((s) => s.kind === 'fee' && s.paidMinor < s.amountMinor && addDays(s.dueDate, graceDays) < today && !lateDone.has(s.n));
}

/** Text for a CSV cell (Excel opens these). */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  // Stop Excel from running a cell as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: unknown[][]) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** 12 -> "MI-0012". */
export const studentCode = (no: number | null | undefined) => (no ? `MI-${String(no).padStart(4, '0')}` : '');

// ---- Batches, routine and attendance ----------------------------------------

/** Weekdays in the order the institute's week runs (Saturday first). 0 = Sunday. */
export const WEEK = [6, 0, 1, 2, 3, 4, 5] as const;
export const DAY_BN = ['রবিবার', 'সোমবার', 'মঙ্গলবার', 'বুধবার', 'বৃহস্পতিবার', 'শুক্রবার', 'শনিবার'] as const;
export const DAY_SHORT_BN = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহঃ', 'শুক্র', 'শনি'] as const;

/** "6,1,3" -> [6, 1, 3], ignoring anything else. */
export const parseDays = (s: string) => [...new Set(s.split(',').map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];

/** Weekday (0 = Sunday) of a "YYYY-MM-DD" date. */
export const weekday = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();

export const isTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** "16:30" -> "বিকাল ৪:৩০". */
export function timeBn(hhmm: string): string {
  if (!isTime(hhmm)) return '';
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const part = h < 5 ? 'রাত' : h < 12 ? 'সকাল' : h < 15 ? 'দুপুর' : h < 18 ? 'বিকাল' : h < 20 ? 'সন্ধ্যা' : 'রাত';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${part} ${bnDigits(h12)}:${bnDigits(String(m).padStart(2, '0'))}`;
}

export const ATTENDANCE = ['present', 'absent', 'late', 'leave'] as const;
export type AttendanceStatus = (typeof ATTENDANCE)[number];
export const ATTENDANCE_BN: Record<AttendanceStatus, string> = { present: 'উপস্থিত', absent: 'অনুপস্থিত', late: 'দেরিতে', leave: 'ছুটি' };

/** Usual spending heads; any other name can be typed too. */
export const EXPENSE_CATEGORIES = ['বাড়ি ভাড়া', 'শিক্ষক বেতন', 'স্টাফ বেতন', 'বিদ্যুৎ বিল', 'ইন্টারনেট', 'বিজ্ঞাপন', 'বই ও স্টেশনারি', 'আপ্যায়ন', 'যাতায়াত', 'মেরামত', 'অন্যান্য'] as const;

/** A Bangladeshi mobile number as wa.me wants it (8801XXXXXXXXX), or null. */
export function waNumber(phone: string): string | null {
  const d = phone.replace(/[০-৯]/g, (x) => String('০১২৩৪৫৬৭৮৯'.indexOf(x))).replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return `88${d}`;
  if (/^8801\d{9}$/.test(d)) return d;
  return null;
}

/** Fills {name}, {amount} and the like in a message template. */
export const fillTemplate = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (all, k: string) => vars[k] ?? all);

/** "2026-11" -> "নভে" (short) or "নভেম্বর ২০২৬". */
export function monthBn(ym: string, long = false): string {
  return new Intl.DateTimeFormat('bn-BD', long ? { month: 'long', year: 'numeric', timeZone: 'UTC' } : { month: 'short', timeZone: 'UTC' }).format(
    new Date(`${ym}-01T00:00:00Z`),
  );
}
