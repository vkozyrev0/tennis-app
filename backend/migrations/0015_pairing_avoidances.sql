-- CourtOps Tennis — pairing avoidances (juniors, audit §1.1): a group of 2+
-- players (same club / siblings) who must not meet in the first round. Modeled as
-- a header + members so a group can exceed two players.

CREATE TYPE avoidance_relationship AS ENUM ('same_club', 'siblings');

CREATE TABLE pairing_avoidance (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id   int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    age_division    text,
    relationship    avoidance_relationship,
    source_email_id int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pairing_avoid_tournament ON pairing_avoidance(tournament_id);

CREATE TABLE pairing_avoidance_member (
    id                   int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    pairing_avoidance_id int NOT NULL REFERENCES pairing_avoidance(id) ON DELETE CASCADE,
    player_id            int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    UNIQUE (pairing_avoidance_id, player_id)
);
