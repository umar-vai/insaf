import type { GoogleProfile } from './google';
import { readCookie, readSession, SESSION_COOKIE, type SessionEnv } from './session';

export type Student = { id: string; email: string; name: string };

/**
 * Students who learned on the old site already have a row with their email,
 * so signing in with that email (by code or Google) opens their old courses.
 */
export async function studentForEmail(db: D1Database, email: string): Promise<string> {
  const row = await db
    .prepare(
      `INSERT INTO students (id, email) VALUES (?, ?)
       ON CONFLICT (lower(email)) DO UPDATE SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       RETURNING id`,
    )
    .bind(`stu_${crypto.randomUUID()}`, email)
    .first<{ id: string }>();
  return row!.id;
}

/** Finds the student by Google account, else by verified email, else creates one. */
export async function studentForGoogle(db: D1Database, p: GoogleProfile): Promise<string> {
  const bySub = await db.prepare('SELECT id FROM students WHERE google_sub = ?').bind(p.sub).first<{ id: string }>();
  const id = bySub?.id ?? (await studentForEmail(db, p.email));
  await db
    .prepare(
      `UPDATE students SET google_sub = ?, name = CASE WHEN name = '' THEN ? ELSE name END,
         last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    )
    .bind(p.sub, p.name, id)
    .run();
  return id;
}

export async function currentStudent(db: D1Database, env: SessionEnv, cookieHeader: string | null): Promise<Student | null> {
  const id = await readSession(env, readCookie(cookieHeader, SESSION_COOKIE));
  if (!id) return null;
  return db.prepare('SELECT id, email, name FROM students WHERE id = ?').bind(id).first<Student>();
}

export async function updateStudentName(db: D1Database, id: string, name: string) {
  await db.prepare('UPDATE students SET name = ? WHERE id = ?').bind(name.trim().slice(0, 80), id).run();
}
