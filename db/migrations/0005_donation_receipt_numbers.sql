-- Serial receipt numbers for donations (shown as RCP-000001). Additive only:
-- one empty column and one unique index. No existing row is changed; gifts that
-- were already paid keep an empty number until the owner approves a numbering run.
ALTER TABLE donations ADD COLUMN receipt_no INTEGER;
CREATE UNIQUE INDEX donations_receipt_no_idx ON donations(receipt_no) WHERE receipt_no IS NOT NULL;
