// Small helpers shared by the Phase 4 school operations modules
// (fee bills, library, certificates, staff attendance, student leave,
// admission inquiries, portal notifications).

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export const text = (form: FormData, k: string, max = 200) => String(form.get(k) ?? '').trim().slice(0, max);
export const longText = (form: FormData, k: string, max = 2000) => String(form.get(k) ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
/** Bangla digits to English, spaces and dashes removed. */
export const cleanPhone = (s: string) => s.replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[\s-]/g, '');
export const PHONE = /^\+?[0-9]{6,15}$/;
/** Whole number from Bangla or English digits, or null. */
export function wholeNumber(raw: unknown): number | null {
  const s = String(raw ?? '').replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d))).replace(/[,\s]/g, '');
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}
/** Days from a to b ("YYYY-MM-DD"), b minus a. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
/** "?, ?, ?" for an IN list. */
export const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

/**
 * The batch an enrollment sits in now: its placement in the active academic
 * session (a promotion) when there is one, else the enrollment's own batch.
 * Use with an enrollment aliased as e.
 */
export const EFFECTIVE_BATCH = `coalesce((SELECT p.to_batch_id FROM academic_promotions p JOIN academic_sessions ss ON ss.id = p.to_session_id AND ss.status = 'active'
  WHERE p.enrollment_id = e.id LIMIT 1), e.batch_id)`;

/** Runs prepared statements in groups D1 accepts, returning the rows changed. */
export async function runBatches(db: D1Database, statements: D1PreparedStatement[], size = 50): Promise<number> {
  let changed = 0;
  for (let i = 0; i < statements.length; i += size) {
    const out = await db.batch(statements.slice(i, i + size));
    changed += out.reduce((a, o) => a + (o.meta.changes ?? 0), 0);
  }
  return changed;
}
