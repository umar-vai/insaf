-- Phase 4: school operations. Additive only: new tables, no existing row is changed.
-- Fee bills write ordinary offline_charges rows (source_key 'bill:<run id>'), so
-- dues, receipts and reports keep working the same way.

CREATE TABLE fee_bill_runs (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  due_date TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('all','course','batch')),
  target_id TEXT NOT NULL DEFAULT '',
  use_concessions INTEGER NOT NULL DEFAULT 1,
  created_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  total_minor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted','cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX fee_bill_runs_created_idx ON fee_bill_runs(created_at);

CREATE TABLE fee_concessions (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  percent INTEGER NOT NULL CHECK(percent BETWEEN 1 AND 100),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_by TEXT,
  ended_at TEXT
);
CREATE UNIQUE INDEX fee_concessions_one_active_idx ON fee_concessions(student_id) WHERE status = 'active';

CREATE TABLE library_books (
  id TEXT PRIMARY KEY NOT NULL,
  accession_no INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  shelf TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  copies INTEGER NOT NULL DEFAULT 1 CHECK(copies BETWEEN 0 AND 10000),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX library_books_title_idx ON library_books(lower(title));

CREATE TABLE library_loans (
  id TEXT PRIMARY KEY NOT NULL,
  book_id TEXT NOT NULL REFERENCES library_books(id),
  borrower_kind TEXT NOT NULL CHECK(borrower_kind IN ('student','teacher')),
  student_id TEXT REFERENCES offline_students(id),
  teacher_id TEXT REFERENCES teachers(id),
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  returned_on TEXT,
  fine_minor INTEGER NOT NULL DEFAULT 0 CHECK(fine_minor >= 0),
  fine_charge_id TEXT,
  issued_by TEXT NOT NULL,
  returned_by TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((borrower_kind = 'student' AND student_id IS NOT NULL AND teacher_id IS NULL) OR (borrower_kind = 'teacher' AND teacher_id IS NOT NULL AND student_id IS NULL)),
  CHECK(issued_on <= due_on)
);
CREATE INDEX library_loans_open_idx ON library_loans(book_id, returned_on);
CREATE INDEX library_loans_student_idx ON library_loans(student_id, returned_on);
CREATE INDEX library_loans_teacher_idx ON library_loans(teacher_id, returned_on);
CREATE INDEX library_loans_due_idx ON library_loans(returned_on, due_on);

CREATE TABLE certificates (
  id TEXT PRIMARY KEY NOT NULL,
  serial_no INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  kind TEXT NOT NULL CHECK(kind IN ('transfer','character','study','completion','other')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','revoked')),
  revoked_by TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX certificates_student_idx ON certificates(student_id, created_at);

CREATE TABLE staff_attendance (
  id TEXT PRIMARY KEY NOT NULL,
  teacher_id TEXT NOT NULL REFERENCES teachers(id),
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('present','late','absent','leave')),
  in_time TEXT NOT NULL DEFAULT '',
  out_time TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'office' CHECK(source IN ('office','self')),
  marked_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX staff_attendance_one_idx ON staff_attendance(teacher_id, day);
CREATE INDEX staff_attendance_day_idx ON staff_attendance(day);

CREATE TABLE student_leave_requests (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  from_day TEXT NOT NULL,
  to_day TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(from_day <= to_day)
);
CREATE INDEX student_leave_student_idx ON student_leave_requests(student_id, from_day);
CREATE INDEX student_leave_status_idx ON student_leave_requests(status, created_at);

CREATE TABLE admission_inquiries (
  id TEXT PRIMARY KEY NOT NULL,
  student_name TEXT NOT NULL,
  guardian_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  desired_class TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','admitted','closed')),
  staff_note TEXT NOT NULL DEFAULT '',
  handled_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX admission_inquiries_status_idx ON admission_inquiries(status, created_at);

CREATE TABLE portal_notifications (
  id TEXT PRIMARY KEY NOT NULL,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('student','teacher')),
  offline_student_id TEXT REFERENCES offline_students(id),
  teacher_id TEXT REFERENCES teachers(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  source_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK((recipient_kind = 'student' AND offline_student_id IS NOT NULL AND teacher_id IS NULL) OR (recipient_kind = 'teacher' AND teacher_id IS NOT NULL AND offline_student_id IS NULL))
);
CREATE UNIQUE INDEX portal_notifications_student_source_idx ON portal_notifications(offline_student_id, source_key) WHERE offline_student_id IS NOT NULL;
CREATE UNIQUE INDEX portal_notifications_teacher_source_idx ON portal_notifications(teacher_id, source_key) WHERE teacher_id IS NOT NULL;
CREATE INDEX portal_notifications_student_idx ON portal_notifications(offline_student_id, read_at, created_at);
CREATE INDEX portal_notifications_teacher_idx ON portal_notifications(teacher_id, read_at, created_at);
