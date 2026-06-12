-- P4-3 (day-of operations): incident log — the tournament's operational memory.
-- Weather delays, injuries, disputes, facility problems get logged as they
-- happen (quick one-liner), optionally resolved later; feeds post-event review
-- and protest/dispute paper trails.
CREATE TABLE tournament_incident (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    site_id       int REFERENCES site(id) ON DELETE SET NULL,
    occurred_at   timestamptz NOT NULL DEFAULT now(),
    category      text NOT NULL CHECK (category IN
                      ('weather', 'injury', 'dispute', 'facility', 'conduct', 'other')),
    severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'minor', 'major')),
    description   text NOT NULL,
    resolved      boolean NOT NULL DEFAULT false,
    resolution    text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_incident_tournament ON tournament_incident (tournament_id, occurred_at DESC);
