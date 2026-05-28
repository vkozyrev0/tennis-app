-- CourtOps Tennis — expand certification types to the real USTA set:
--   roving official, chair umpire, tournament referee, deputy referee,
--   referee in training.
-- Rename the three existing short values (data keeps working) and add two more.

ALTER TYPE certification_type RENAME VALUE 'roving'  TO 'roving_official';
ALTER TYPE certification_type RENAME VALUE 'chair'   TO 'chair_umpire';
ALTER TYPE certification_type RENAME VALUE 'referee' TO 'tournament_referee';
ALTER TYPE certification_type ADD VALUE IF NOT EXISTS 'deputy_referee';
ALTER TYPE certification_type ADD VALUE IF NOT EXISTS 'referee_in_training';
