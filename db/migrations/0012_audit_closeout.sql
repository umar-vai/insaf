CREATE TABLE admission_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  fields TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admission_drafts_expiry_idx ON admission_drafts(expires_at);
ALTER TABLE admission_applications ADD COLUMN submit_key TEXT;
CREATE UNIQUE INDEX admission_submission_once_idx ON admission_applications(submit_key) WHERE submit_key IS NOT NULL;
CREATE INDEX admission_duplicate_review_idx ON admission_applications(phone, birth_date, student_name);

ALTER TABLE offline_exams ADD COLUMN assessor_id TEXT REFERENCES teachers(id);
ALTER TABLE assessment_policies ADD COLUMN submitted_at TEXT;
ALTER TABLE assessment_policies ADD COLUMN submitted_by TEXT;
ALTER TABLE assessment_policies ADD COLUMN reviewed_at TEXT;
ALTER TABLE assessment_policies ADD COLUMN reviewed_by TEXT;
ALTER TABLE assessment_policies ADD COLUMN review_note TEXT NOT NULL DEFAULT '';

ALTER TABLE admission_inquiries ADD COLUMN student_id TEXT REFERENCES offline_students(id);
CREATE UNIQUE INDEX admission_inquiries_student_idx ON admission_inquiries(student_id) WHERE student_id IS NOT NULL;

ALTER TABLE certificates ADD COLUMN clearance_json TEXT;
CREATE TABLE shared_expense_allocations (
  expense_id TEXT PRIMARY KEY NOT NULL REFERENCES expenses(id),
  batch_id TEXT NOT NULL REFERENCES offline_batches(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  reason TEXT NOT NULL,
  posted_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE shared_expense_shares (
  expense_id TEXT NOT NULL REFERENCES shared_expense_allocations(expense_id),
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (expense_id, student_id)
);
CREATE INDEX shared_expense_student_idx ON shared_expense_shares(student_id);

CREATE TABLE bank_statement_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES acc_accounts(id),
  csv TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT,
  reviewed_by TEXT
);
CREATE INDEX bank_statement_review_idx ON bank_statement_deliveries(reviewed_at, received_at);
