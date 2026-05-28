-- CourtOps Tennis — doubles pairing (juniors, audit §2.2 / §3.6).
-- doubles_request = one filed email (a player asking to be paired). A MUTUAL
-- partnership verifies only when BOTH players' emails are on file (each naming the
-- other). A RANDOM request enqueues the player; the next random request in the
-- same division pairs FIFO. A request is binding once made.

CREATE TYPE doubles_pairing_type AS ENUM ('mutual', 'random');

CREATE TABLE doubles_request (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id   int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    age_division    text,
    player_id       int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    partner_usta    text,                 -- named partner's USTA (null for random)
    wants_random    boolean NOT NULL DEFAULT false,
    status          text NOT NULL DEFAULT 'pending',   -- 'pending' | 'paired'
    source_email_id int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_doubles_req_tournament ON doubles_request(tournament_id);

CREATE TABLE doubles_pair (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    age_division  text,
    player1_id    int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    player2_id    int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    pairing_type  doubles_pairing_type NOT NULL,
    verified      boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_doubles_pair_tournament ON doubles_pair(tournament_id);
