-- Backlog B2 (Roster — Initial + Correction imports) and B3 (combined T-shirt +
-- Hotel + Dietary import) reveal columns the real-world spreadsheets carry
-- that the current schema doesn't track. All new columns are NULLable so the
-- existing data stays valid and old code paths keep working.

-- ---- player catalog extensions (B2a Initial) -------------------------------
-- The "Tournament Full Player Data (June 2026).xlsx" file carries player-level
-- data the upsert should propagate to Setup → Players (multiple emails/phones,
-- USTA section/district, WTN ratings). Year-of-birth precision is captured
-- explicitly so we don't pretend YYYY-01-01 is a real DOB.
ALTER TABLE player
  ADD COLUMN IF NOT EXISTS emails TEXT,           -- comma-separated; preserve as-is
  ADD COLUMN IF NOT EXISTS phones TEXT,           -- comma-separated
  ADD COLUMN IF NOT EXISTS district TEXT,
  ADD COLUMN IF NOT EXISTS section TEXT,
  ADD COLUMN IF NOT EXISTS wtn_singles NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS wtn_singles_conf TEXT,
  ADD COLUMN IF NOT EXISTS wtn_doubles NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS wtn_doubles_conf TEXT;

-- "day" = full DOB known (the existing default — single-record edits supply
-- one); "year" = only year of birth is known (Initial import provides this).
-- Tests rely on the existing default of 'day' staying in force.
ALTER TABLE player
  ADD COLUMN IF NOT EXISTS birthdate_precision TEXT
    NOT NULL DEFAULT 'day'
    CHECK (birthdate_precision IN ('day', 'year'));

-- ---- roster (tournament_entry) extensions ----------------------------------
-- B2a Initial: full payment snapshot at registration time.
ALTER TABLE tournament_entry
  ADD COLUMN IF NOT EXISTS payment_status TEXT,
  ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS amount_refunded NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS amount_due NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS amount_outstanding NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS card_stored BOOL;

-- B2b Correction: tournament sign-in + suspension points (per-tournament,
-- not player-wide — the TD confirmed in the 2026-05-28 questionnaire).
ALTER TABLE tournament_entry
  ADD COLUMN IF NOT EXISTS signed_in BOOL NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspension_points INT;

-- B3 combined T-shirt/Hotel/Dietary: the source file asks a free-text hotel
-- question ("No, I am local" / "Yes, I plan to reserve…") that mostly maps
-- to the existing lodging_plan enum strings but sometimes won't. Store the
-- raw answer as a fallback for TD review.
-- The combined import stores the parsed lodging answer directly on the roster
-- row so the t-shirt page reads it in one query. The detailed player_hotel_stay
-- table (which has hotel_name + lodging_plan) stays available for the inbox /
-- per-tab workflow — they coexist.
ALTER TABLE tournament_entry
  ADD COLUMN IF NOT EXISTS lodging_plan TEXT,
  ADD COLUMN IF NOT EXISTS lodging_plan_raw TEXT;
