-- Keep historical bills and exams intact. New records carry their billing period and roster state.
ALTER TABLE fee_bill_runs ADD COLUMN fee_head TEXT NOT NULL DEFAULT 'other';
ALTER TABLE fee_bill_runs ADD COLUMN billing_period TEXT NOT NULL DEFAULT '';
ALTER TABLE fee_bill_runs ADD COLUMN title_key TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_exams ADD COLUMN roster_frozen INTEGER NOT NULL DEFAULT 0;

-- Blank allocation preserves the existing oldest-first rule for earlier receipts.
ALTER TABLE offline_payments ADD COLUMN allocation_key TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_payments ADD COLUMN allocation_label TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_online_payments ADD COLUMN allocation_key TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_online_payments ADD COLUMN resolution_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_online_payments ADD COLUMN resolution_reference TEXT NOT NULL DEFAULT '';

-- New ledger postings remember their original account and project.
ALTER TABLE offline_payments ADD COLUMN posted_account_id TEXT;
ALTER TABLE offline_payments ADD COLUMN posted_project_id TEXT;
ALTER TABLE expenses ADD COLUMN posted_account_id TEXT;
ALTER TABLE expenses ADD COLUMN student_id TEXT REFERENCES offline_students(id);
ALTER TABLE acc_entries ADD COLUMN donation_id TEXT REFERENCES donations(id);
CREATE UNIQUE INDEX acc_entries_active_donation_idx ON acc_entries(donation_id) WHERE donation_id IS NOT NULL AND voided_at IS NULL;
CREATE INDEX expenses_student_idx ON expenses(student_id);

-- Keep the before/after versions when an Academic Full officer corrects a published result.
CREATE TABLE assessment_mark_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  exam_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  before_mark INTEGER,
  after_mark INTEGER,
  before_comment TEXT NOT NULL,
  after_comment TEXT NOT NULL,
  reason TEXT NOT NULL,
  revised_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(exam_id, enrollment_id) REFERENCES assessment_examinees(exam_id, enrollment_id)
);
CREATE INDEX assessment_mark_revisions_exam_idx ON assessment_mark_revisions(exam_id, created_at);
