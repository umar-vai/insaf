-- Additive academic-year, placement and verified guardian links. No legacy rows or financial entries are modified.
CREATE TABLE academic_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','archived')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK(starts_on <= ends_on)
);
CREATE UNIQUE INDEX academic_sessions_single_active_idx ON academic_sessions(status) WHERE status = 'active';
CREATE TABLE academic_batch_sessions (
  batch_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_batches(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES academic_sessions(id),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX academic_batch_sessions_session_idx ON academic_batch_sessions(session_id);
CREATE TABLE academic_promotions (
  id TEXT PRIMARY KEY NOT NULL,
  enrollment_id TEXT NOT NULL REFERENCES offline_enrollments(id),
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  from_batch_id TEXT REFERENCES offline_batches(id),
  to_batch_id TEXT NOT NULL REFERENCES offline_batches(id),
  to_session_id TEXT NOT NULL REFERENCES academic_sessions(id),
  next_roll TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(enrollment_id, to_session_id)
);
CREATE INDEX academic_promotions_student_idx ON academic_promotions(student_id, to_session_id);
CREATE INDEX academic_promotions_batch_idx ON academic_promotions(to_batch_id, to_session_id);
CREATE TABLE academic_guardian_links (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT NOT NULL REFERENCES offline_students(id) ON DELETE CASCADE,
  guardian_email TEXT NOT NULL,
  guardian_name TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('father','mother','guardian','other')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_by TEXT,
  revoked_at TEXT
);
CREATE UNIQUE INDEX academic_guardian_student_email_idx ON academic_guardian_links(student_id, lower(guardian_email));
CREATE INDEX academic_guardian_email_status_idx ON academic_guardian_links(lower(guardian_email), status);
