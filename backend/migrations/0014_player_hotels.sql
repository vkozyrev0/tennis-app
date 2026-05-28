-- CourtOps Tennis — Part B: player-reported hotel stays (audit §1.2, CVB loop).
-- Players report which hotel they booked; aggregated room-night patterns help the
-- TD negotiate comp rooms / sponsorship from the convention & visitors bureau.

CREATE TABLE player_hotel_stay (
    id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id   int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    player_id       int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    hotel_name      text,
    source_email_id int REFERENCES email_message(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_player_hotel_tournament ON player_hotel_stay(tournament_id);
