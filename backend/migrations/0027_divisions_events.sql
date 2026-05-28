-- Divisions + events were previously hardcoded constants on the frontend
-- (Boys/Girls 10..18, NTRP 2.5..Open Men/Women, Combo 6.0..9.0; Singles/Doubles
-- for juniors, Men's/Women's/Mixed Singles/Doubles for adults). Move them into
-- editable Setup tables so the TD can adjust the catalog without a code change.
CREATE TABLE IF NOT EXISTS division (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  tournament_type TEXT NOT NULL CHECK (tournament_type IN ('junior', 'adult')),
  -- NULL = applies to both genders (e.g. Combo doubles), otherwise restricts
  -- to one gender so the picker filters correctly when a player is chosen.
  gender TEXT CHECK (gender IS NULL OR gender IN ('male', 'female')),
  sort_order INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tournament_event (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  tournament_type TEXT NOT NULL CHECK (tournament_type IN ('junior', 'adult')),
  -- NULL = applies to both (e.g. Mixed Doubles, junior Singles/Doubles).
  gender TEXT CHECK (gender IS NULL OR gender IN ('male', 'female')),
  sort_order INT NOT NULL DEFAULT 0
);

-- Seed: USTA junior divisions B10..G18 + adult NTRP 2.5..Open Men/Women + Combo 6.0..9.0.
INSERT INTO division (code, label, tournament_type, gender, sort_order) VALUES
  ('B10', 'Boys 10 & Under', 'junior', 'male', 10),
  ('G10', 'Girls 10 & Under', 'junior', 'female', 20),
  ('B12', 'Boys 12 & Under', 'junior', 'male', 30),
  ('G12', 'Girls 12 & Under', 'junior', 'female', 40),
  ('B14', 'Boys 14 & Under', 'junior', 'male', 50),
  ('G14', 'Girls 14 & Under', 'junior', 'female', 60),
  ('B16', 'Boys 16 & Under', 'junior', 'male', 70),
  ('G16', 'Girls 16 & Under', 'junior', 'female', 80),
  ('B18', 'Boys 18 & Under', 'junior', 'male', 90),
  ('G18', 'Girls 18 & Under', 'junior', 'female', 100),
  ('NTRP 2.5 Men',   'NTRP 2.5 Men',   'adult', 'male',   110),
  ('NTRP 2.5 Women', 'NTRP 2.5 Women', 'adult', 'female', 120),
  ('NTRP 3.0 Men',   'NTRP 3.0 Men',   'adult', 'male',   130),
  ('NTRP 3.0 Women', 'NTRP 3.0 Women', 'adult', 'female', 140),
  ('NTRP 3.5 Men',   'NTRP 3.5 Men',   'adult', 'male',   150),
  ('NTRP 3.5 Women', 'NTRP 3.5 Women', 'adult', 'female', 160),
  ('NTRP 4.0 Men',   'NTRP 4.0 Men',   'adult', 'male',   170),
  ('NTRP 4.0 Women', 'NTRP 4.0 Women', 'adult', 'female', 180),
  ('NTRP 4.5 Men',   'NTRP 4.5 Men',   'adult', 'male',   190),
  ('NTRP 4.5 Women', 'NTRP 4.5 Women', 'adult', 'female', 200),
  ('NTRP Open Men',   'NTRP Open Men',   'adult', 'male',   210),
  ('NTRP Open Women', 'NTRP Open Women', 'adult', 'female', 220),
  ('Combo 6.0', 'Combo 6.0 (doubles only)', 'adult', NULL, 230),
  ('Combo 7.0', 'Combo 7.0 (doubles only)', 'adult', NULL, 240),
  ('Combo 8.0', 'Combo 8.0 (doubles only)', 'adult', NULL, 250),
  ('Combo 9.0', 'Combo 9.0 (doubles only)', 'adult', NULL, 260)
ON CONFLICT (code) DO NOTHING;

INSERT INTO tournament_event (name, tournament_type, gender, sort_order) VALUES
  ('Singles', 'junior', NULL, 10),
  ('Doubles', 'junior', NULL, 20),
  ('Men''s Singles',   'adult', 'male',   30),
  ('Women''s Singles', 'adult', 'female', 40),
  ('Men''s Doubles',   'adult', 'male',   50),
  ('Women''s Doubles', 'adult', 'female', 60),
  ('Mixed Doubles',    'adult', NULL,     70)
ON CONFLICT (name) DO NOTHING;
