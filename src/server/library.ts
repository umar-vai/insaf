import { log } from './admin';
import { notifyStudents } from './notifications';
import { daysBetween, longText, marks, newId, text, wholeNumber, type Result } from './ops-util';
import { addDays, dayBn, isYmd } from '../lib/offline';

// The madrasa library: the book list (with how many copies), lending to
// students and teachers, returns, and late fines. A fine is never paid at
// the library desk: for a student it becomes an ordinary charge on their
// active enrollment ("library:<loan id>"), so it is collected with the fees
// and shows on the receipt. Nothing is deleted: a book taken out of the
// library is marked removed, a loan stays in history after it is returned.

export type Book = {
  id: string;
  accessionNo: number;
  title: string;
  author: string;
  category: string;
  shelf: string;
  isbn: string;
  copies: number;
  status: 'active' | 'removed';
  onLoan: number;
  available: number;
};

const BOOK_SELECT = `SELECT b.id, b.accession_no AS accessionNo, b.title, b.author, b.category, b.shelf, b.isbn, b.copies, b.status,
  (SELECT count(*) FROM library_loans l WHERE l.book_id = b.id AND l.returned_on IS NULL) AS onLoan
  FROM library_books b`;
const withAvailable = (b: Omit<Book, 'available'>): Book => ({ ...b, available: Math.max(0, b.copies - b.onLoan) });

export type BookInput = { accessionNo: number | null; title: string; author: string; category: string; shelf: string; isbn: string; copies: number };

export function parseBookForm(form: FormData): Result<BookInput> {
  const title = text(form, 'title', 200);
  if (title.length < 1) return { ok: false, error: 'title' };
  const rawNo = text(form, 'accessionNo', 12);
  const accessionNo = rawNo ? wholeNumber(rawNo) : null;
  if (rawNo && (accessionNo === null || accessionNo < 1)) return { ok: false, error: 'accession' };
  const copies = wholeNumber(text(form, 'copies', 6) || '1');
  if (copies === null || copies > 10000) return { ok: false, error: 'copies' };
  return {
    ok: true,
    value: { accessionNo, title, author: text(form, 'author', 160), category: text(form, 'category', 80), shelf: text(form, 'shelf', 40), isbn: text(form, 'isbn', 20), copies },
  };
}

export async function listBooks(db: D1Database, q = '', includeRemoved = false, limit = 300): Promise<Book[]> {
  const term = q.trim().slice(0, 80);
  const conds = [includeRemoved ? '' : "b.status = 'active'", term ? '(lower(b.title) LIKE ?1 OR lower(b.author) LIKE ?1 OR lower(b.category) LIKE ?1 OR CAST(b.accession_no AS TEXT) = ?2)' : '']
    .filter(Boolean)
    .join(' AND ');
  const stmt = db.prepare(`${BOOK_SELECT} ${conds ? `WHERE ${conds}` : ''} ORDER BY b.title, b.accession_no LIMIT ${Math.min(1000, Math.max(1, limit))}`);
  const { results } = await (term ? stmt.bind(`%${term.toLowerCase()}%`, term) : stmt).all<Omit<Book, 'available'>>();
  return results.map(withAvailable);
}

export async function getBook(db: D1Database, id: string): Promise<Book | null> {
  const b = await db.prepare(`${BOOK_SELECT} WHERE b.id = ?`).bind(id).first<Omit<Book, 'available'>>();
  return b ? withAvailable(b) : null;
}

export async function saveBook(db: D1Database, actor: string, id: string | null, v: BookInput): Promise<Result<string>> {
  if (id) {
    const b = await getBook(db, id);
    if (!b) return { ok: false, error: 'missing' };
    if (v.copies < b.onLoan) return { ok: false, error: 'copies_on_loan' };
    try {
      await db
        .prepare('UPDATE library_books SET accession_no = ?, title = ?, author = ?, category = ?, shelf = ?, isbn = ?, copies = ? WHERE id = ?')
        .bind(v.accessionNo ?? b.accessionNo, v.title, v.author, v.category, v.shelf, v.isbn, v.copies, id)
        .run();
    } catch {
      return { ok: false, error: 'accession_taken' };
    }
    await log(db, actor, 'library.book.update', `book:${id}`, { title: v.title, copies: v.copies });
    return { ok: true, value: id };
  }
  const newBook = newId('bk');
  for (let attempt = 0; attempt < 3; attempt++) {
    const no = v.accessionNo ?? ((await db.prepare('SELECT coalesce(max(accession_no), 0) + 1 AS n FROM library_books').first<{ n: number }>())?.n ?? 1);
    try {
      await db
        .prepare('INSERT INTO library_books (id, accession_no, title, author, category, shelf, isbn, copies, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(newBook, no, v.title, v.author, v.category, v.shelf, v.isbn, v.copies, actor)
        .run();
      await log(db, actor, 'library.book.add', `book:${newBook}`, { title: v.title, accessionNo: no, copies: v.copies });
      return { ok: true, value: newBook };
    } catch {
      if (v.accessionNo) return { ok: false, error: 'accession_taken' };
    }
  }
  return { ok: false, error: 'accession_taken' };
}

/** Takes a book out of the list (only when no copy is lent out). */
export async function removeBook(db: D1Database, actor: string, id: string): Promise<boolean> {
  const r = await db
    .prepare(`UPDATE library_books SET status = 'removed' WHERE id = ? AND status = 'active' AND NOT EXISTS (SELECT 1 FROM library_loans l WHERE l.book_id = library_books.id AND l.returned_on IS NULL)`)
    .bind(id)
    .run();
  if (r.meta.changes) await log(db, actor, 'library.book.remove', `book:${id}`, {});
  return r.meta.changes > 0;
}

// ---- Loans ----------------------------------------------------------------------

export type Loan = {
  id: string;
  bookId: string;
  bookTitle: string;
  accessionNo: number;
  borrowerKind: 'student' | 'teacher';
  studentId: string | null;
  teacherId: string | null;
  borrowerName: string;
  borrowerCode: number | null;
  issuedOn: string;
  dueOn: string;
  returnedOn: string | null;
  fineMinor: number;
  note: string;
};

const LOAN_SELECT = `SELECT l.id, l.book_id AS bookId, b.title AS bookTitle, b.accession_no AS accessionNo, l.borrower_kind AS borrowerKind,
  l.student_id AS studentId, l.teacher_id AS teacherId, coalesce(s.name, t.name, '') AS borrowerName, s.student_no AS borrowerCode,
  l.issued_on AS issuedOn, l.due_on AS dueOn, l.returned_on AS returnedOn, l.fine_minor AS fineMinor, l.note
  FROM library_loans l JOIN library_books b ON b.id = l.book_id
  LEFT JOIN offline_students s ON s.id = l.student_id LEFT JOIN teachers t ON t.id = l.teacher_id`;

export type IssueInput = { bookId: string; borrowerKind: 'student' | 'teacher'; borrowerId: string; dueOn: string; note: string };

export function parseIssueForm(form: FormData, today: string, loanDays: number): Result<IssueInput> {
  const bookId = text(form, 'bookId', 40);
  const kind = text(form, 'borrowerKind') === 'teacher' ? 'teacher' : 'student';
  const borrowerId = text(form, kind === 'teacher' ? 'teacherId' : 'studentId', 40);
  if (!bookId) return { ok: false, error: 'book' };
  if (!borrowerId) return { ok: false, error: 'borrower' };
  const dueOn = text(form, 'dueOn', 10) || addDays(today, loanDays);
  if (!isYmd(dueOn) || dueOn < today || daysBetween(today, dueOn) > 365) return { ok: false, error: 'due' };
  return { ok: true, value: { bookId, borrowerKind: kind, borrowerId, dueOn, note: longText(form, 'note', 300) } };
}

/** Lends a copy, if one is on the shelf. The same person cannot hold two copies of one book. */
export async function issueBook(db: D1Database, actor: string, v: IssueInput, today: string): Promise<Result<string>> {
  const book = await getBook(db, v.bookId);
  if (!book || book.status !== 'active') return { ok: false, error: 'book' };
  if (book.available <= 0) return { ok: false, error: 'none_left' };
  const who =
    v.borrowerKind === 'student'
      ? await db.prepare("SELECT id FROM offline_students WHERE id = ? AND status = 'active'").bind(v.borrowerId).first()
      : await db.prepare("SELECT id FROM teachers WHERE id = ? AND status = 'active'").bind(v.borrowerId).first();
  if (!who) return { ok: false, error: 'borrower' };
  const col = v.borrowerKind === 'student' ? 'student_id' : 'teacher_id';
  const id = newId('ln');
  // One statement: checks copies and the same person's open loan at the moment of writing.
  const r = await db
    .prepare(
      `INSERT INTO library_loans (id, book_id, borrower_kind, ${col}, issued_on, due_on, issued_by, note)
       SELECT ?, b.id, ?, ?, ?, ?, ?, ? FROM library_books b
       WHERE b.id = ? AND b.status = 'active'
         AND b.copies > (SELECT count(*) FROM library_loans x WHERE x.book_id = b.id AND x.returned_on IS NULL)
         AND NOT EXISTS (SELECT 1 FROM library_loans y WHERE y.book_id = b.id AND y.${col} = ? AND y.returned_on IS NULL)`,
    )
    .bind(id, v.borrowerKind, v.borrowerId, today, v.dueOn, actor, v.note, v.bookId, v.borrowerId)
    .run();
  if (!r.meta.changes) return { ok: false, error: 'already' };
  await log(db, actor, 'library.issue', `book:${v.bookId}`, { loanId: id, borrower: `${v.borrowerKind}:${v.borrowerId}`, dueOn: v.dueOn });
  return { ok: true, value: id };
}

/** The fine for returning on `today`: whole days late times the daily fine. */
export const lateFine = (dueOn: string, today: string, perDayTaka: number) => Math.max(0, daysBetween(dueOn, today)) * Math.max(0, perDayTaka) * 100;

/**
 * Takes a book back. A late student gets the fine as a charge on their
 * newest active enrollment (once per loan). waive: no fine (full level only,
 * checked by the page).
 */
export async function returnBook(db: D1Database, actor: string, loanId: string, today: string, perDayTaka: number, waive: boolean): Promise<Result<{ fineMinor: number }>> {
  const loan = await db.prepare(`${LOAN_SELECT} WHERE l.id = ?`).bind(loanId).first<Loan>();
  if (!loan || loan.returnedOn) return { ok: false, error: 'missing' };
  const fine = waive || loan.borrowerKind !== 'student' ? 0 : lateFine(loan.dueOn, today, perDayTaka);
  const moved = await db
    .prepare('UPDATE library_loans SET returned_on = ?, returned_by = ?, fine_minor = ? WHERE id = ? AND returned_on IS NULL')
    .bind(today, actor, fine, loanId)
    .run();
  if (!moved.meta.changes) return { ok: false, error: 'missing' };
  let chargeId: string | null = null;
  if (fine > 0 && loan.studentId) {
    const e = await db
      .prepare("SELECT id FROM offline_enrollments WHERE student_id = ? AND status = 'active' ORDER BY start_date DESC LIMIT 1")
      .bind(loan.studentId)
      .first<{ id: string }>();
    if (e) {
      chargeId = newId('chg');
      await db
        .prepare(
          `INSERT INTO offline_charges (id, enrollment_id, kind, label, amount_minor, due_date, source_key, created_by)
           VALUES (?, ?, 'other', ?, ?, ?, ?, ?) ON CONFLICT (enrollment_id, source_key) DO NOTHING`,
        )
        .bind(chargeId, e.id, `লাইব্রেরি জরিমানা: ${loan.bookTitle}`.slice(0, 120), fine, today, `library:${loanId}`, actor)
        .run();
      await db.prepare('UPDATE library_loans SET fine_charge_id = ? WHERE id = ?').bind(chargeId, loanId).run();
    }
  }
  await log(db, actor, 'library.return', `book:${loan.bookId}`, { loanId, fine: fine / 100, waived: waive, chargeId });
  return { ok: true, value: { fineMinor: fine } };
}

export async function listLoans(db: D1Database, opts: { open?: boolean; overdueOn?: string; limit?: number } = {}): Promise<Loan[]> {
  const conds = [opts.open ? 'l.returned_on IS NULL' : '', opts.overdueOn ? 'l.returned_on IS NULL AND l.due_on < ?' : ''].filter(Boolean).join(' AND ');
  const { results } = await db
    .prepare(`${LOAN_SELECT} ${conds ? `WHERE ${conds}` : ''} ORDER BY l.returned_on IS NOT NULL, l.due_on, l.created_at DESC LIMIT ?`)
    .bind(...(opts.overdueOn ? [opts.overdueOn] : []), Math.min(1000, opts.limit ?? 300))
    .all<Loan>();
  return results;
}

/** A student's (or a family's) loans, for the portal. */
export async function loansOfStudents(db: D1Database, studentIds: string[], limit = 60): Promise<Loan[]> {
  if (!studentIds.length) return [];
  const { results } = await db
    .prepare(`${LOAN_SELECT} WHERE l.student_id IN (${marks(studentIds.length)}) ORDER BY l.returned_on IS NOT NULL, l.due_on DESC LIMIT ?`)
    .bind(...studentIds, limit)
    .all<Loan>();
  return results;
}

export async function loansOfTeacher(db: D1Database, teacherId: string, limit = 30): Promise<Loan[]> {
  const { results } = await db.prepare(`${LOAN_SELECT} WHERE l.teacher_id = ? ORDER BY l.returned_on IS NOT NULL, l.due_on DESC LIMIT ?`).bind(teacherId, limit).all<Loan>();
  return results;
}

export async function libraryCounts(db: D1Database, today: string) {
  const r = await db
    .prepare(
      `SELECT (SELECT count(*) FROM library_books WHERE status = 'active') AS titles,
        (SELECT coalesce(sum(copies), 0) FROM library_books WHERE status = 'active') AS copies,
        (SELECT count(*) FROM library_loans WHERE returned_on IS NULL) AS onLoan,
        (SELECT count(*) FROM library_loans WHERE returned_on IS NULL AND due_on < ?) AS overdue`,
    )
    .bind(today)
    .first<{ titles: number; copies: number; onLoan: number; overdue: number }>();
  return r ?? { titles: 0, copies: 0, onLoan: 0, overdue: 0 };
}

/** Nightly: tells each student once when a book becomes overdue. */
export async function remindOverdueBooks(db: D1Database, today: string): Promise<number> {
  const loans = (await listLoans(db, { overdueOn: today, limit: 1000 })).filter((l) => l.studentId);
  let sent = 0;
  for (const l of loans) {
    sent += await notifyStudents(db, 'system', [l.studentId!], {
      title: `লাইব্রেরির বই ফেরত দেওয়ার সময় পার হয়েছে: ${l.bookTitle}`,
      body: `বইটি ফেরত দেওয়ার শেষ দিন ছিল ${dayBn(l.dueOn)}। দ্রুত লাইব্রেরিতে ফেরত দিন।`,
      link: '/account/offline/library',
      sourceKey: `library-overdue:${l.id}`,
    });
  }
  return sent;
}
