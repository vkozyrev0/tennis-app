-- P4-4 follow-up: payment batches. The TD settles officials in groups — a
-- check run, an ACH file, a cash day — not one transfer per assignment. A
-- batch records that settlement once (method, date, reference, note) and links
-- the payroll_records paid in it. Creating a batch marks each member record
-- paid; dissolving the batch walks every member back to unpaid. The FK on the
-- record is SET NULL, so deleting a batch never deletes the money rows
-- themselves (same survives-deletion policy as payroll_record/assignment_audit).
CREATE TABLE payment_batch (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    reference     text NOT NULL,                 -- "Check run 2026-06-15", "ACH #42"
    method        text NOT NULL CHECK (method IN
                      ('check', 'ach', 'cash', 'venmo', 'zelle', 'other')),
    paid_on       date NOT NULL,
    note          text,
    created_by    text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_batch_tournament ON payment_batch (tournament_id);

-- A finalized record belongs to at most one batch. SET NULL on delete so
-- dissolving a batch (or its tournament cascade) leaves the record intact.
ALTER TABLE payroll_record
    ADD COLUMN batch_id int REFERENCES payment_batch(id) ON DELETE SET NULL;

CREATE INDEX idx_payroll_batch ON payroll_record (batch_id);
