-- CourtOps Tennis — authentication: user accounts + sessions.
-- Two roles: 'admin' (the TD) and 'official' (self-service). An official account
-- links to an official record. POC auth: pbkdf2 password hashes + a server-side
-- session token in an HttpOnly cookie (see docs/roadmap.md §Stack security note).

CREATE TYPE user_role AS ENUM ('admin', 'official');

CREATE TABLE user_account (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    role          user_role NOT NULL DEFAULT 'official',
    official_id   int REFERENCES official(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
    token      text PRIMARY KEY,
    user_id    int NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_user ON session(user_id);
