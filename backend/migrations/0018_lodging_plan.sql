-- CourtOps Tennis — player lodging plan (audit §1.2 follow-up).
-- The TD's sign-in sheet records both a Hotel Name and a "Lodging Plans" category
-- (Hotel, Commuter, Commuter 1-2 hrs, ...). Capture the category alongside the hotel.

ALTER TABLE player_hotel_stay ADD COLUMN lodging_plan text;
