-- CourtOps Tennis — player hotels reference the hotel table (design-critique).
-- player_hotel_stay.hotel_name was free text (drift); add a hotel_id FK and link
-- each stay to a hotel row (auto-creating one per distinct name, case-insensitive).
-- hotel_name is kept as the canonical denormalized name (= hotel.name) for display.

ALTER TABLE player_hotel_stay ADD COLUMN hotel_id int REFERENCES hotel(id);

-- Create a hotel row for each distinct player-reported name not already present.
INSERT INTO hotel (name)
SELECT DISTINCT ON (lower(btrim(s.hotel_name))) btrim(s.hotel_name)
FROM player_hotel_stay s
WHERE NULLIF(btrim(s.hotel_name), '') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM hotel h WHERE lower(h.name) = lower(btrim(s.hotel_name)))
ORDER BY lower(btrim(s.hotel_name));

-- Link + canonicalize the stored name to the hotel row.
UPDATE player_hotel_stay s SET hotel_id = h.id, hotel_name = h.name
FROM hotel h WHERE lower(h.name) = lower(btrim(s.hotel_name));

CREATE INDEX IF NOT EXISTS idx_player_hotel_hotel ON player_hotel_stay(hotel_id);
