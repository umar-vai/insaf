import { log } from './admin';
import { getExpense } from './office';
import { examEligibleEnrollmentIds } from './academic';
import type { Result } from './ops-util';

const rosterSql = `WITH eligible AS (${examEligibleEnrollmentIds})
  SELECT DISTINCT s.id, s.name, s.student_no AS no
  FROM eligible x JOIN offline_enrollments e ON e.id = x.id JOIN offline_students s ON s.id = e.student_id
  ORDER BY s.id LIMIT 301`;

export function shareAmounts(amount: number, count: number) {
  return Array.from({ length: count }, (_, i) => Math.floor(amount / count) + Number(i < amount % count));
}

export async function costPreview(db: D1Database, expenseId: string, batchId: string) {
  const expense = await getExpense(db, expenseId);
  if (!expense || expense.studentId || expense.voidedAt || expense.status !== 'approved') return null;
  const [students, existing] = await Promise.all([
    db.prepare(rosterSql).bind(batchId, expense.spentOn).all<{ id: string; name: string; no: number | null }>(),
    db.prepare('SELECT batch_id AS batchId FROM shared_expense_allocations WHERE expense_id = ?').bind(expenseId).first<{ batchId: string }>(),
  ]);
  const amounts = shareAmounts(expense.amountMinor, students.results.length);
  const shares = students.results.map((row, i) => ({ ...row, amount: amounts[i]! }));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ expenseId, batchId, amount: expense.amountMinor, shares })));
  return { expense, shares, existing, key: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') };
}

export async function allocateStudentCosts(db: D1Database, actor: string, expenseId: string, batchId: string, key: string, reason: string): Promise<Result<number>> {
  const preview = await costPreview(db, expenseId, batchId);
  if (!preview || preview.existing || preview.key !== key || reason.trim().length < 3 || preview.shares.length === 0 || preview.shares.length > 300) return { ok: false, error: 'changed' };
  const [batch] = await db.batch([
    db.prepare(`INSERT INTO shared_expense_allocations (expense_id, batch_id, amount_minor, reason, posted_by)
      SELECT id, ?2, amount_minor, ?3, ?4 FROM expenses WHERE id = ?1 AND amount_minor = ?5 AND status = 'approved'
        AND voided_at IS NULL AND student_id IS NULL ON CONFLICT (expense_id) DO NOTHING`).bind(expenseId, batchId, reason.trim().slice(0, 300), actor, preview.expense.amountMinor),
    db.prepare(`INSERT INTO shared_expense_shares (expense_id, student_id, amount_minor)
      SELECT ?1, json_extract(s.value, '$.id'), json_extract(s.value, '$.amount') FROM json_each(?2) s WHERE changes() = 1`)
      .bind(expenseId, JSON.stringify(preview.shares.map(({ id, amount }) => ({ id, amount })))),
  ]);
  if (!batch?.meta.changes) return { ok: false, error: 'changed' };
  await log(db, actor, 'expense.allocate.students', `expense:${expenseId}`, { batchId, count: preview.shares.length });
  return { ok: true, value: preview.shares.length };
}

export async function costsOfStudent(db: D1Database, studentId: string) {
  return (await db.prepare(`SELECT e.id, e.category, e.spent_on AS day, e.amount_minor AS amount, 0 AS shared
    FROM expenses e WHERE e.student_id = ?1 AND e.status = 'approved' AND e.voided_at IS NULL
    UNION ALL SELECT e.id, e.category, e.spent_on, c.amount_minor, 1
    FROM shared_expense_shares c JOIN expenses e ON e.id = c.expense_id
    WHERE c.student_id = ?1 AND e.status = 'approved' AND e.voided_at IS NULL ORDER BY day DESC, id DESC`)
    .bind(studentId).all<{ id: string; category: string; day: string; amount: number; shared: number }>()).results;
}
