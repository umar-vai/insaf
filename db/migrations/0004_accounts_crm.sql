-- Accounts (projects, funds, money accounts, other income, transfers, budgets,
-- reconciliation, voucher numbers, two step expense approval) and the student
-- CRM (tags, follow ups, contact log, message templates). Additive only: new
-- tables, nullable columns on expenses and offline_courses, and a few starting
-- rows (one general fund and the four places money is kept). No existing row
-- is changed; donations are not touched.

CREATE TABLE acc_projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE acc_funds (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'general' CHECK(kind IN ('general','zakat','lillah','grant','other')),
  restricted INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Where money is kept. methods: comma separated payment methods that land here
-- (cash, bkash, nagad, rocket, bank, other, online); each method in one account.
CREATE TABLE acc_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('cash','bank','mobile','gateway')),
  methods TEXT NOT NULL DEFAULT '',
  number_hint TEXT NOT NULL DEFAULT '',
  opening_minor INTEGER NOT NULL DEFAULT 0,
  opening_on TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Money in that is not a student fee (grants, rent, sales, transfers from the
-- donation side recorded by hand) and transfers between accounts. Never deleted.
CREATE TABLE acc_entries (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('income','transfer')),
  voucher_no INTEGER NOT NULL,
  day TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  account_id TEXT NOT NULL REFERENCES acc_accounts(id),
  from_account_id TEXT REFERENCES acc_accounts(id),
  project_id TEXT REFERENCES acc_projects(id),
  fund_id TEXT REFERENCES acc_funds(id),
  category TEXT NOT NULL DEFAULT '',
  party TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL,
  nonce TEXT,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX acc_entries_voucher_idx ON acc_entries(kind, voucher_no);
CREATE UNIQUE INDEX acc_entries_nonce_idx ON acc_entries(nonce);
CREATE INDEX acc_entries_day_idx ON acc_entries(day);

-- A year's budget for one head: a project, an expense head, or both ('' = any).
CREATE TABLE acc_budgets (
  id TEXT PRIMARY KEY NOT NULL,
  year TEXT NOT NULL,
  project_id TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX acc_budgets_one_idx ON acc_budgets(year, project_id, category);

CREATE TABLE acc_reconciliations (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES acc_accounts(id),
  as_of TEXT NOT NULL,
  statement_minor INTEGER NOT NULL,
  book_minor INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX acc_reconciliations_account_idx ON acc_reconciliations(account_id, as_of);

ALTER TABLE expenses ADD COLUMN voucher_no INTEGER;
ALTER TABLE expenses ADD COLUMN project_id TEXT REFERENCES acc_projects(id);
ALTER TABLE expenses ADD COLUMN fund_id TEXT REFERENCES acc_funds(id);
ALTER TABLE expenses ADD COLUMN party TEXT NOT NULL DEFAULT '';
ALTER TABLE expenses ADD COLUMN checked_by TEXT;
ALTER TABLE expenses ADD COLUMN checked_at TEXT;
CREATE UNIQUE INDEX expenses_voucher_idx ON expenses(voucher_no) WHERE voucher_no IS NOT NULL;
CREATE INDEX expenses_project_idx ON expenses(project_id);

ALTER TABLE offline_courses ADD COLUMN project_id TEXT REFERENCES acc_projects(id);

INSERT INTO acc_funds (id, name, kind, restricted, note, created_by) VALUES
  ('fund_general', 'সাধারণ তহবিল', 'general', 0, 'ছাত্রদের ফি ও যেকোনো খাতে খরচ করা যায় এমন টাকা', 'system');
INSERT INTO acc_accounts (id, name, kind, methods, created_by) VALUES
  ('acct_cash', 'ক্যাশ বাক্স', 'cash', 'cash,other', 'system'),
  ('acct_bank', 'ব্যাংক হিসাব', 'bank', 'bank', 'system'),
  ('acct_mobile', 'মোবাইল ব্যাংকিং', 'mobile', 'bkash,nagad,rocket', 'system'),
  ('acct_online', 'অনলাইন গেটওয়ে', 'gateway', 'online', 'system');

-- ---- Student CRM ----

CREATE TABLE crm_tags (
  student_id TEXT NOT NULL REFERENCES offline_students(id),
  tag TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (student_id, tag)
);
CREATE INDEX crm_tags_tag_idx ON crm_tags(tag);

CREATE TABLE crm_followups (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT REFERENCES offline_students(id),
  inquiry_id TEXT REFERENCES admission_inquiries(id),
  title TEXT NOT NULL,
  due_on TEXT NOT NULL,
  assigned_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','cancelled')),
  outcome TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  done_by TEXT,
  done_at TEXT
);
CREATE INDEX crm_followups_due_idx ON crm_followups(status, due_on);
CREATE INDEX crm_followups_student_idx ON crm_followups(student_id);

CREATE TABLE crm_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  student_id TEXT REFERENCES offline_students(id),
  inquiry_id TEXT REFERENCES admission_inquiries(id),
  channel TEXT NOT NULL CHECK(channel IN ('call','sms','whatsapp','visit','portal','email','letter')),
  direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out','in')),
  summary TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX crm_contacts_student_idx ON crm_contacts(student_id, created_at);
CREATE INDEX crm_contacts_created_idx ON crm_contacts(created_at);

CREATE TABLE crm_templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'any' CHECK(channel IN ('any','sms','whatsapp','portal')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
