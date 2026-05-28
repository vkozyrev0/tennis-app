-- Backlog B1: per-tournament division ↔ site assignment so the multi-site
-- tournament t-shirt report can be grouped/filtered by Site.
-- Per the 2026-05-28 questionnaire: one division = one site (no splits),
-- scoped per tournament (each year picks its own assignment).
CREATE TABLE IF NOT EXISTS tournament_site_division (
  id            SERIAL PRIMARY KEY,
  tournament_id INT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  site_id       INT NOT NULL REFERENCES site(id)       ON DELETE CASCADE,
  division_id   INT NOT NULL REFERENCES division(id)   ON DELETE CASCADE,
  -- one division per tournament can only sit at one site (questionnaire 1.1)
  UNIQUE (tournament_id, division_id),
  -- guard against rebuilding a site assignment to the SAME site as a no-op
  UNIQUE (tournament_id, site_id, division_id)
);

CREATE INDEX IF NOT EXISTS idx_tsd_tournament
  ON tournament_site_division (tournament_id);
CREATE INDEX IF NOT EXISTS idx_tsd_site
  ON tournament_site_division (tournament_id, site_id);
