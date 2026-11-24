-- Existing single-head receipts continue to use their original allocation columns.
CREATE TABLE offline_payment_allocations (
  payment_id TEXT NOT NULL REFERENCES offline_payments(id) ON DELETE CASCADE,
  allocation_key TEXT NOT NULL,
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (payment_id, allocation_key)
);

ALTER TABLE acc_cleared_items ADD COLUMN statement_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE acc_cleared_items ADD COLUMN statement_amount_minor INTEGER;
CREATE UNIQUE INDEX acc_cleared_statement_idx ON acc_cleared_items(account_id, cleared_on, statement_reference, statement_amount_minor)
  WHERE statement_reference <> '';

CREATE TABLE enrollment_assistance (
  id TEXT PRIMARY KEY NOT NULL,
  enrollment_id TEXT NOT NULL REFERENCES offline_enrollments(id),
  kind TEXT NOT NULL CHECK (kind IN ('sibling', 'zakat')),
  sibling_id TEXT REFERENCES offline_students(id),
  fund_id TEXT REFERENCES acc_funds(id),
  original_admission_minor INTEGER NOT NULL,
  original_discount_minor INTEGER NOT NULL,
  admission_waiver_minor INTEGER NOT NULL CHECK (admission_waiver_minor >= 0),
  tuition_waiver_minor INTEGER NOT NULL CHECK (tuition_waiver_minor >= 0),
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT NOT NULL DEFAULT '',
  CHECK ((kind = 'sibling' AND sibling_id IS NOT NULL AND fund_id IS NULL) OR (kind = 'zakat' AND fund_id IS NOT NULL AND sibling_id IS NULL))
);
CREATE UNIQUE INDEX enrollment_assistance_enrollment_idx ON enrollment_assistance(enrollment_id) WHERE revoked_at IS NULL;

CREATE TABLE residential_rooms (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  created_by TEXT NOT NULL
);
CREATE TABLE residential_stays (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  room_id TEXT NOT NULL REFERENCES residential_rooms(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT,
  placed_by TEXT NOT NULL,
  released_by TEXT,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE UNIQUE INDEX residential_stays_current_student_idx ON residential_stays(student_id) WHERE ends_on IS NULL;
CREATE INDEX residential_stays_room_idx ON residential_stays(room_id, ends_on);

ALTER TABLE academic_promotions ADD COLUMN qualifying_exam_id TEXT REFERENCES offline_exams(id);
ALTER TABLE academic_promotions ADD COLUMN reviewed_application INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_application IN (0, 1));
