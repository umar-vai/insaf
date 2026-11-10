// Everything a student sees about themselves on /account. Every query is
// bound to the signed in student's id; nothing here takes an id from the URL.

export const BD_PHONE = /^(?:\+?88)?(01[3-9]\d{8})$/;

/** "+880 1712-345678", "01712 345678" -> "01712345678", or null if not a BD mobile. */
export const normalizePhone = (raw: string) => BD_PHONE.exec(raw.replace(/[\s-]/g, ''))?.[1] ?? null;

export type Profile = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  google: boolean;
  legacy: boolean;
  hasPassword: boolean;
};

export async function profileFor(db: D1Database, studentId: string): Promise<Profile | null> {
  const row = await db
    .prepare(
      `SELECT id, email, name, phone, created_at AS createdAt, last_login_at AS lastLoginAt,
              google_sub IS NOT NULL AS google, legacy_wp_user_id IS NOT NULL AS legacy, password_hash IS NOT NULL AS hasPassword
       FROM students WHERE id = ?`,
    )
    .bind(studentId)
    .first<Omit<Profile, 'google' | 'legacy' | 'hasPassword'> & { google: number; legacy: number; hasPassword: number }>();
  return row && { ...row, google: Boolean(row.google), legacy: Boolean(row.legacy), hasPassword: Boolean(row.hasPassword) };
}

export type ProfileResult = { ok: true } | { ok: false; reason: 'name' | 'phone' };

/** Name is required; phone may be left empty. */
export async function updateProfile(db: D1Database, studentId: string, input: { name: string; phone: string }): Promise<ProfileResult> {
  const name = input.name.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (name.length < 2) return { ok: false, reason: 'name' };
  const rawPhone = input.phone.trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  if (rawPhone && !phone) return { ok: false, reason: 'phone' };
  await db.prepare('UPDATE students SET name = ?, phone = ? WHERE id = ?').bind(name, phone, studentId).run();
  return { ok: true };
}

