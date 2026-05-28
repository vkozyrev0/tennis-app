-- CourtOps Tennis — distinguish two hotel-block purposes (TD clarification):
--   'player'   = discounted hotel rates offered to players
--   'official' = comp rooms / reservations for officials needing accommodation
-- The Assignments "Hotel assignment" draws only from 'official' blocks.

CREATE TYPE room_block_kind AS ENUM ('player', 'official');

ALTER TABLE room_block ADD COLUMN kind room_block_kind NOT NULL DEFAULT 'player';

CREATE INDEX idx_room_block_kind ON room_block(tournament_id, kind);
