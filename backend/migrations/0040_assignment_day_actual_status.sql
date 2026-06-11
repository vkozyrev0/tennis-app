-- P4-1 (day-of operations): planned-vs-actual per assignment day. The TD marks
-- what really happened on the day — no_show days drop out of pay; the rest is
-- reporting truth (who actually worked) for payroll reconciliation.
ALTER TABLE assignment_day
    ADD COLUMN actual_status text NOT NULL DEFAULT 'planned'
        CHECK (actual_status IN ('planned', 'worked', 'no_show', 'early_departure'));

COMMENT ON COLUMN assignment_day.actual_status IS
    'Day-of truth: planned (default) | worked | no_show (excluded from pay) | early_departure';
