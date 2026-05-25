-- CourtOps Tennis — Part B foundation: a human-review email inbox + the first
-- list (late entries). No automated parsing (D5/§5.1): a person files each email.

CREATE TYPE email_status AS ENUM ('new', 'filed', 'needs_followup');

-- Inbound parent/player email, forwarded to the tournament address (POC: entered
-- by hand). The reviewer sets classification + status and files it into a list.
CREATE TABLE email_message (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id  int REFERENCES tournament(id) ON DELETE SET NULL,
    message_id     text UNIQUE,                 -- dedup (nullable for manual adds)
    received_at    timestamptz NOT NULL DEFAULT now(),
    from_address   text,
    subject        text,
    body           text,
    classification text NOT NULL DEFAULT 'unclassified',
    status         email_status NOT NULL DEFAULT 'new',
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_email_tournament ON email_message(tournament_id);

-- Late entries (vision: date, time, player, age division, events, USTA number).
-- Filing one also upserts the player + their tournament_entry (source=late_entry).
CREATE TABLE late_entry (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id   int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    player_id       int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    request_date    date,
    request_time    text,
    age_division    text,
    events          text,
    source_email_id int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_late_entry_tournament ON late_entry(tournament_id);
