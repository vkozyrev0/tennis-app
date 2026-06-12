-- P4-5 (day-of operations): WHO changed an assignment, WHEN, and WHAT — the
-- dispute-resolution trail pay_audit doesn't cover (it freezes amounts, not
-- actions). Append-only. assignment_id is SET NULL on delete and the
-- tournament/official identity is denormalized, so the trail survives the
-- assignment itself being removed.
CREATE TABLE assignment_audit (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    assignment_id int REFERENCES assignment(id) ON DELETE SET NULL,
    tournament_id int,
    official_id   int,
    official_name text,
    changed_at    timestamptz NOT NULL DEFAULT now(),
    changed_by    text NOT NULL,
    action        text NOT NULL CHECK (action IN
                      ('created', 'updated', 'deleted', 'day_added', 'day_removed',
                       'day_status', 'response')),
    detail        jsonb
);

CREATE INDEX idx_asg_audit_assignment ON assignment_audit (assignment_id, changed_at DESC);
CREATE INDEX idx_asg_audit_tournament ON assignment_audit (tournament_id, changed_at DESC);
