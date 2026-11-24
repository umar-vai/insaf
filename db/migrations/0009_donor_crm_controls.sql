-- Donor CRM (profile notes, tags, contact log, follow ups, support tickets,
-- message templates) and accounting controls (closed periods, item by item
-- bank clearing). Additive only: new tables. The donations and funds tables
-- are not changed; donors are still worked out from their gifts and are
-- linked here by the same key (phone, else email, else lower case name).

CREATE TABLE donor_profiles (
  donor_key TEXT PRIMARY KEY NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  preferred_channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK(preferred_channel IN ('call','sms','whatsapp','email','visit','letter')),
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE donor_tags (
  donor_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (donor_key, tag)
);
CREATE INDEX donor_tags_tag_idx ON donor_tags(tag);

CREATE TABLE donor_followups (
  id TEXT PRIMARY KEY NOT NULL,
  donor_key TEXT NOT NULL,
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
CREATE INDEX donor_followups_due_idx ON donor_followups(status, due_on);
CREATE INDEX donor_followups_donor_idx ON donor_followups(donor_key);

-- donation_ref is set when this contact delivered that gift's receipt, so a
-- receipt is counted as sent once.
CREATE TABLE donor_contacts (
  id TEXT PRIMARY KEY NOT NULL,
  donor_key TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('call','sms','whatsapp','email','visit','letter')),
  direction TEXT NOT NULL DEFAULT 'out' CHECK(direction IN ('out','in')),
  summary TEXT NOT NULL,
  donation_ref TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX donor_contacts_donor_idx ON donor_contacts(donor_key, created_at);
CREATE INDEX donor_contacts_created_idx ON donor_contacts(created_at);
CREATE UNIQUE INDEX donor_contacts_receipt_idx ON donor_contacts(donation_ref) WHERE donation_ref IS NOT NULL;

CREATE TABLE donor_tickets (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_no INTEGER NOT NULL,
  donor_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('receipt','payment','information','complaint','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  assigned_to TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX donor_tickets_no_idx ON donor_tickets(ticket_no);
CREATE INDEX donor_tickets_status_idx ON donor_tickets(status, updated_at);
CREATE INDEX donor_tickets_donor_idx ON donor_tickets(donor_key);

CREATE TABLE donor_ticket_messages (
  id TEXT PRIMARY KEY NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES donor_tickets(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX donor_ticket_messages_idx ON donor_ticket_messages(ticket_id, created_at);

CREATE TABLE donor_templates (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL DEFAULT 'general' CHECK(purpose IN ('general','receipt')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---- Accounting controls ----

-- Books closed through a day: nothing dated on or before it can be added,
-- approved or voided until an owner reopens it. Rows are history, never deleted.
CREATE TABLE acc_period_closes (
  id TEXT PRIMARY KEY NOT NULL,
  through_day TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  closed_by TEXT NOT NULL,
  closed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reopened_by TEXT,
  reopened_at TEXT,
  reopen_reason TEXT
);
CREATE INDEX acc_period_closes_open_idx ON acc_period_closes(reopened_at, through_day);

-- A book line ticked as seen on the bank or mobile statement.
CREATE TABLE acc_cleared_items (
  account_id TEXT NOT NULL REFERENCES acc_accounts(id),
  source TEXT NOT NULL CHECK(source IN ('fee','income','expense','transfer')),
  txn_id TEXT NOT NULL,
  cleared_on TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (account_id, source, txn_id)
);
