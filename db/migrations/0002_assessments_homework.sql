-- Phase 3: independently authored assessment/assignment workflow. Additive to existing Insaf D1.
CREATE TABLE assessment_policies (
  exam_id TEXT PRIMARY KEY NOT NULL REFERENCES offline_exams(id),
  max_marks INTEGER NOT NULL CHECK (max_marks BETWEEN 1 AND 1000),
  pass_marks INTEGER NOT NULL CHECK (pass_marks >= 0 AND pass_marks <= max_marks),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
  published_by TEXT,
  published_at TEXT,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE assessment_examinees (
  exam_id TEXT NOT NULL REFERENCES offline_exams(id),
  enrollment_id TEXT NOT NULL REFERENCES offline_enrollments(id),
  captured_by TEXT NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (exam_id,enrollment_id)
);
CREATE INDEX assessment_examinees_enrollment_idx ON assessment_examinees(enrollment_id);
CREATE TABLE assessment_marks (
  exam_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  obtained INTEGER,
  attendance TEXT NOT NULL CHECK(attendance IN ('present','absent')),
  comment TEXT NOT NULL DEFAULT '',
  marked_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(exam_id,enrollment_id),
  FOREIGN KEY(exam_id,enrollment_id) REFERENCES assessment_examinees(exam_id,enrollment_id),
  CHECK((attendance='absent' AND obtained IS NULL) OR (attendance='present' AND obtained IS NOT NULL AND obtained >= 0))
);
CREATE TABLE homework_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL REFERENCES offline_batches(id),
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK(kind IN ('homework','lesson')),
  due_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
  created_by TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX homework_assignments_batch_idx ON homework_assignments(batch_id,status,due_on);
CREATE TABLE homework_submissions (
  assignment_id TEXT NOT NULL REFERENCES homework_assignments(id),
  enrollment_id TEXT NOT NULL REFERENCES offline_enrollments(id),
  body TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'submitted' CHECK(state IN ('submitted','reviewed')),
  feedback TEXT NOT NULL DEFAULT '',
  score INTEGER CHECK(score IS NULL OR (score BETWEEN 0 AND 100)),
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  PRIMARY KEY(assignment_id,enrollment_id)
);
CREATE INDEX homework_submissions_enrollment_idx ON homework_submissions(enrollment_id,state);
