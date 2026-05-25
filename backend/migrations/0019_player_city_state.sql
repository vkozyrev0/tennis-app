-- CourtOps Tennis — player city/state (sign-in sheet, audit §3.8).
-- The TD's sign-in sheet lists each player's City/State. Not name-history-tracked
-- (the 0004 trigger only snapshots usta_number/first/last/birthdate).

ALTER TABLE player ADD COLUMN city  text;
ALTER TABLE player ADD COLUMN state text;
