-- CourtOps Tennis — Part B: withdrawals (audit §2.4).
-- A reason is required unless the player was an alternate. Recording a withdrawal
-- flips the roster status to 'withdrawn'; we snapshot was_alternate here because
-- that flip would otherwise lose the prior status.

CREATE TABLE withdrawal (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id   int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    player_id       int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    events          text,
    reason          text,
    notes           text,
    was_alternate   boolean NOT NULL DEFAULT false,
    source_email_id int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_withdrawal_tournament ON withdrawal(tournament_id);
