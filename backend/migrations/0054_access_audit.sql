-- D19: append-only log of who opened sensitive player surfaces (not the PII itself).
-- Server inserts on player 360 (GET /api/players/{id}/overview). List via GET /api/access-audit.

CREATE TABLE access_audit (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    accessed_at     timestamptz NOT NULL DEFAULT now(),
    username        text NOT NULL,
    action          text NOT NULL,          -- e.g. view_player_360
    resource_type   text NOT NULL,          -- e.g. player
    resource_id     int,                    -- player.id (no name/USTA in the row)
    tournament_id   int REFERENCES tournament(id) ON DELETE SET NULL,
    client_kind     text NOT NULL DEFAULT 'api'
                        CHECK (client_kind IN ('browser', 'api')),
    detail          jsonb                   -- surface labels only (never row PII)
);

CREATE INDEX idx_access_audit_at ON access_audit (accessed_at DESC);
CREATE INDEX idx_access_audit_user ON access_audit (username, accessed_at DESC);
CREATE INDEX idx_access_audit_resource ON access_audit (resource_type, resource_id, accessed_at DESC);
