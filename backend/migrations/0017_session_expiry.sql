-- CourtOps Tennis — session hardening (audit follow-up).
-- Sessions now carry an expiry; expired tokens are rejected at auth time and
-- cleaned up on login. Resetting an official's login also deletes their sessions
-- (see app/routers/officials.py set_official_account) so a reset forces re-login.

ALTER TABLE session
    ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days';

CREATE INDEX idx_session_expires ON session(expires_at);
