-- CourtOps Tennis — Part B adult lists (audit §1.1, §DivisionFlexibility):
--   scheduling_avoidance  = player can't play at certain days/times
--   division_flexibility  = player willing to play other divisions if undersubscribed

CREATE TABLE scheduling_avoidance (
    id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id    int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    player_id        int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    avoid_day        text,
    avoid_time_range text,
    source_email_id  int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sched_avoid_tournament ON scheduling_avoidance(tournament_id);

CREATE TABLE division_flexibility (
    id                int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id     int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    player_id         int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    home_division     text,
    willing_divisions text,                 -- comma-separated for the POC
    source_email_id   int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_div_flex_tournament ON division_flexibility(tournament_id);
