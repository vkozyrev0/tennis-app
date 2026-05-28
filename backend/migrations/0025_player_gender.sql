-- Players get a gender so the division/event pickers can show the right list
-- (Boys/Men vs Girls/Women, Combo doubles applies to both). NULL is allowed
-- for legacy rows / when unknown — the picker just falls back to "all".
ALTER TABLE player ADD COLUMN IF NOT EXISTS gender TEXT
    CHECK (gender IS NULL OR gender IN ('male', 'female'));
