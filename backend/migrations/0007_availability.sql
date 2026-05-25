-- CourtOps Tennis — official availability per tournament (Phase 2 / audit §Availability).
-- The TD records which dates each official is available for a tournament; the
-- assignment flow can then surface/respect it.

CREATE TABLE availability (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    official_id    int NOT NULL REFERENCES official(id) ON DELETE CASCADE,
    tournament_id  int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    available_date date NOT NULL,
    hotel_needed   boolean NOT NULL DEFAULT false,
    UNIQUE (official_id, tournament_id, available_date)
);

CREATE INDEX idx_availability_tournament ON availability(tournament_id);
