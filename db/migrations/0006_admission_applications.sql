-- Full online admission form (application, student pledge, guardian pledge,
-- signatures). Additive only: one new table and two nullable columns on
-- offline_students (photo and the application it came from). The old short
-- inquiries table is left as it is. A student record is made only when the
-- office accepts an application.

CREATE TABLE admission_applications (
  id TEXT PRIMARY KEY NOT NULL,
  app_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  student_name TEXT NOT NULL,
  birth_date TEXT NOT NULL DEFAULT '',
  father_name TEXT NOT NULL DEFAULT '',
  father_occupation TEXT NOT NULL DEFAULT '',
  perm_village TEXT NOT NULL DEFAULT '',
  perm_post TEXT NOT NULL DEFAULT '',
  perm_thana TEXT NOT NULL DEFAULT '',
  perm_district TEXT NOT NULL DEFAULT '',
  cur_village TEXT NOT NULL DEFAULT '',
  cur_post TEXT NOT NULL DEFAULT '',
  cur_thana TEXT NOT NULL DEFAULT '',
  cur_district TEXT NOT NULL DEFAULT '',
  prev_class TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  desired_class TEXT NOT NULL DEFAULT '',
  prev_institute TEXT NOT NULL DEFAULT '',
  blood_group TEXT NOT NULL DEFAULT '',
  residence TEXT NOT NULL DEFAULT 'non_resident' CHECK(residence IN ('resident','non_resident','day_care')),
  pickup_name TEXT NOT NULL DEFAULT '',
  pickup_address TEXT NOT NULL DEFAULT '',
  pickup_phone TEXT NOT NULL DEFAULT '',
  guardian_name TEXT NOT NULL,
  guardian_occupation TEXT NOT NULL DEFAULT '',
  guardian_nid TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  photo_key TEXT NOT NULL DEFAULT '',
  pledge_version INTEGER NOT NULL DEFAULT 1,
  student_sign_name TEXT NOT NULL DEFAULT '',
  student_signed_at TEXT,
  guardian_sign_name TEXT NOT NULL DEFAULT '',
  guardian_signed_at TEXT,
  exam_marks TEXT NOT NULL DEFAULT '',
  examiner_name TEXT NOT NULL DEFAULT '',
  fee_minor INTEGER NOT NULL DEFAULT 0,
  office_note TEXT NOT NULL DEFAULT '',
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by TEXT,
  decided_at TEXT,
  student_id TEXT REFERENCES offline_students(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX admission_applications_no_idx ON admission_applications (app_no);
CREATE INDEX admission_applications_status_idx ON admission_applications (status, created_at);
CREATE INDEX admission_applications_phone_idx ON admission_applications (phone);

ALTER TABLE offline_students ADD COLUMN photo_key TEXT NOT NULL DEFAULT '';
ALTER TABLE offline_students ADD COLUMN application_id TEXT;
