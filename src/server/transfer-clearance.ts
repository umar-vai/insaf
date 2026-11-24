import { getOfflineStudent } from './offline';

export async function transferClearance(db: D1Database, studentId: string, today: string) {
  const [record, books, linked] = await Promise.all([
    getOfflineStudent(db, studentId, today),
    db.prepare(`SELECT l.id, b.title FROM library_loans l JOIN library_books b ON b.id = l.book_id
      WHERE l.student_id = ? AND l.returned_on IS NULL ORDER BY l.id`).bind(studentId).all<{ id: string; title: string }>(),
    db.prepare("SELECT count(*) AS total FROM academic_guardian_links WHERE student_id = ? AND status = 'active'").bind(studentId).first<{ total: number }>(),
  ]);
  if (!record) return null;
  return {
    balanceMinor: record.enrollments.reduce((sum, e) => sum + e.ledger.dueMinor, 0),
    books: books.results, studentStatus: record.student.status, portalLinked: Boolean(record.student.email), guardians: linked?.total ?? 0,
  };
}

export async function clearanceKey(clearance: NonNullable<Awaited<ReturnType<typeof transferClearance>>>) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(clearance)));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
