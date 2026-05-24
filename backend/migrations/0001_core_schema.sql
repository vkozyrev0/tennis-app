-- CourtOps Tennis — core schema (Phase 0)
-- Entities: Site, Tournament, Official, Player, TournamentEntry
-- See docs/data-model.md. Idempotency is handled by the migration runner
-- (schema_migrations table), so this file assumes a clean target.

-- ---------- enums ----------
CREATE TYPE tournament_type   AS ENUM ('junior', 'adult');
CREATE TYPE selection_status  AS ENUM ('selected', 'alternate', 'withdrawn');
CREATE TYPE entry_source      AS ENUM ('usta_roster', 'late_entry', 'manual');

-- ---------- site ----------
-- Tennis venue. Address is used for official mileage (later phases). audit §3.7
CREATE TABLE site (
    id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        text UNIQUE,                 -- short label, e.g. JDS / RSTC / ROME
    name        text NOT NULL,
    street      text,
    city        text,
    state       text,
    zip         text,
    lat         double precision,            -- optional, for auto-distance (D3)
    lng         double precision,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- tournament ----------
-- Central entity. Three distinct dates per audit §2.5.
CREATE TABLE tournament (
    id                   int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                 text NOT NULL UNIQUE,
    type                 tournament_type NOT NULL,
    play_start_date      date NOT NULL,       -- match-play start
    play_end_date        date NOT NULL,       -- match-play end (3-6 days)
    registration_deadline date,               -- audit §2.5 (distinct from late-entry)
    late_entry_deadline  date,                -- audit §2.5
    site_id              int REFERENCES site(id) ON DELETE SET NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tournament_dates_ok CHECK (play_end_date >= play_start_date)
);

-- ---------- official ----------
-- Officials are a separate population from players (audit §4.2).
CREATE TABLE official (
    id                   int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    first_name           text NOT NULL,
    last_name            text NOT NULL,
    street               text,
    city                 text,
    state                text,
    zip                  text,
    phone                text,
    email                text,
    dietary_restrictions text,               -- shown on confirmed-officials report (audit §2.3)
    lat                  double precision,
    lng                  double precision,
    created_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------- player ----------
-- One stable identity across every list; USTA number is the natural key (audit §4.1).
-- Per-tournament attributes live on tournament_entry, not here.
CREATE TABLE player (
    id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usta_number text NOT NULL UNIQUE,
    first_name  text,
    last_name   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------- tournament_entry ----------
-- TD-supplied per-tournament roster (audit §4.1). Source of truth for selection
-- status, t-shirt size, and dietary preference; ingested via spreadsheet upload (§3.8).
CREATE TABLE tournament_entry (
    id                int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id     int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    player_id         int NOT NULL REFERENCES player(id) ON DELETE CASCADE,
    age_division      text,
    events            text,
    selection_status  selection_status NOT NULL DEFAULT 'selected',
    t_shirt_size      text,                  -- t-shirt history lives here (audit §8 F1)
    dietary_preference text,
    source            entry_source NOT NULL DEFAULT 'usta_roster',
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tournament_id, player_id)
);

CREATE INDEX idx_tournament_site        ON tournament(site_id);
CREATE INDEX idx_entry_tournament       ON tournament_entry(tournament_id);
CREATE INDEX idx_entry_player           ON tournament_entry(player_id);
