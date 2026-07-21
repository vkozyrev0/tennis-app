-- H4.1 / audit D1: append-only log of who exported what (not the PII itself).
-- Client-side CSV downloads POST here; server-side CSV endpoints insert directly.

CREATE TABLE export_audit (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exported_at     timestamptz NOT NULL DEFAULT now(),
    username        text NOT NULL,
    resource        text NOT NULL,          -- e.g. roster, players, payroll, emails
    tournament_id   int REFERENCES tournament(id) ON DELETE SET NULL,
    client_kind     text NOT NULL DEFAULT 'browser'
                        CHECK (client_kind IN ('browser', 'api')),
    detail          jsonb                   -- filename, row_count, etc. (no row PII)
);

CREATE INDEX idx_export_audit_at ON export_audit (exported_at DESC);
CREATE INDEX idx_export_audit_user ON export_audit (username, exported_at DESC);
