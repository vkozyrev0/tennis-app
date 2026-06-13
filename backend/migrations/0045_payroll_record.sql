-- P4-4 (day-of operations): payroll finalization. Freezes the COMPUTED pay
-- (per-day cert rates were already snapshotted onto assignment_day) into an
-- immutable record at event close, so later edits to days, rates, distances
-- or no-show flags can't move money that was already approved for payment.
-- One record per assignment. Identity is denormalized and the FK is SET NULL
-- on delete, so the money trail survives the assignment itself being removed
-- (same policy as assignment_audit).
CREATE TABLE payroll_record (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    assignment_id  int UNIQUE REFERENCES assignment(id) ON DELETE SET NULL,
    tournament_id  int NOT NULL,
    official_id    int,
    official_name  text NOT NULL,
    days_worked    int NOT NULL,
    no_show_days   int NOT NULL DEFAULT 0,
    pay            numeric(10,2) NOT NULL,
    mileage        numeric(10,2),                -- NULL = no distance on file at finalize time
    total          numeric(10,2) NOT NULL,
    rule_version   text,
    detail         jsonb NOT NULL,               -- frozen day-by-day breakdown
    finalized_at   timestamptz NOT NULL DEFAULT now(),
    finalized_by   text NOT NULL,
    -- mark-paid tracking: paid_at/method/note only meaningful when paid
    paid           boolean NOT NULL DEFAULT false,
    paid_at        date,
    paid_method    text CHECK (paid_method IS NULL OR paid_method IN
                       ('check', 'ach', 'cash', 'venmo', 'zelle', 'other')),
    paid_note      text
);

CREATE INDEX idx_payroll_tournament ON payroll_record (tournament_id);

-- The audit action enum gains the payroll lifecycle.
ALTER TABLE assignment_audit DROP CONSTRAINT assignment_audit_action_check;
ALTER TABLE assignment_audit ADD CONSTRAINT assignment_audit_action_check
    CHECK (action IN ('created', 'updated', 'deleted', 'day_added', 'day_removed',
                      'day_status', 'response',
                      'finalized', 'unfinalized', 'paid', 'unpaid'));
