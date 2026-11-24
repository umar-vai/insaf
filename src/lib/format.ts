const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function bnDigits(value: number | string): string {
  return String(value).replace(/\d/g, (d) => BN_DIGITS[Number(d)]!);
}

/** 99900 poisha -> "৯৯৯ টাকা". */
export function taka(minor: number): string {
  return `${bnDigits(Math.round(minor / 100).toLocaleString('en-IN'))} টাকা`;
}

/** Ledger amounts that include fractional taka, such as a shared expense or bank entry. */
export function takaExact(minor: number): string {
  return `${bnDigits((minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 }))} টাকা`;
}

/** 5400 -> "১ ঘণ্টা ৩০ মিনিট". */
export function duration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (!h && !m) return '';
  return [h && `${bnDigits(h)} ঘণ্টা`, m && `${bnDigits(m)} মিনিট`].filter(Boolean).join(' ');
}

/** 2095 -> "৩৪:৫৫". */
export function clock(sec: number): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return bnDigits(h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`);
}

/** Discount as a whole percent, or null when there is none. */
export function discountPercent(price: number, regular: number | null): number | null {
  if (!regular || regular <= price) return null;
  return Math.round(((regular - price) / regular) * 100);
}

/** Total hours, rounded down, for headline stats. */
export function hours(sec: number): number {
  return Math.floor(sec / 3600);
}

/** "৪ নভে, ২০২৬" (with time: "৪ নভে, ২০২৬, ১০:৩০ PM"), in Dhaka time. */
export function dateBn(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('bn-BD', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
    timeZone: 'Asia/Dhaka',
  }).format(d);
}

/**
 * Imported covers exist in two widths (<base>-400.webp, <base>-800.webp);
 * covers uploaded in the admin are one file, whose key has an extension.
 */
export function mediaUrl(base: string, width: 400 | 800 = 800): string {
  return /\.(webp|jpe?g|png)$/.test(base) ? `/media/${base}` : `/media/${base}-${width}.webp`;
}

/** 1536000 -> "১.৫ MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bnDigits(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${bnDigits((bytes / 1024 / 1024).toFixed(1))} MB`;
}

/** "RCP-000123": the serial number printed on a donation receipt, empty until the gift is numbered. */
export const receiptLabel = (n: number | null | undefined): string => (n ? `RCP-${String(n).padStart(6, '0')}` : '');
