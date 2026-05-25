-- CourtOps Tennis — performance indexes (design-critique follow-up).
-- The per-tournament queries (reports, Part B lists, workspace loaders) all filter
-- by tournament_id / a foreign key; index those hot columns. IF NOT EXISTS keeps
-- this safe where a unique constraint already provides an index.

CREATE INDEX IF NOT EXISTS idx_assignment_tournament       ON assignment(tournament_id);
CREATE INDEX IF NOT EXISTS idx_room_block_tournament        ON room_block(tournament_id);
CREATE INDEX IF NOT EXISTS idx_availability_tournament      ON availability(tournament_id);
CREATE INDEX IF NOT EXISTS idx_email_message_tournament     ON email_message(tournament_id);
CREATE INDEX IF NOT EXISTS idx_late_entry_tournament        ON late_entry(tournament_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_tournament        ON withdrawal(tournament_id);
CREATE INDEX IF NOT EXISTS idx_sched_avoid_tournament       ON scheduling_avoidance(tournament_id);
CREATE INDEX IF NOT EXISTS idx_div_flex_tournament          ON division_flexibility(tournament_id);
CREATE INDEX IF NOT EXISTS idx_pairing_avoid_tournament     ON pairing_avoidance(tournament_id);
CREATE INDEX IF NOT EXISTS idx_doubles_request_tournament   ON doubles_request(tournament_id);
CREATE INDEX IF NOT EXISTS idx_doubles_pair_tournament      ON doubles_pair(tournament_id);
CREATE INDEX IF NOT EXISTS idx_player_hotel_tournament_player ON player_hotel_stay(tournament_id, player_id);
CREATE INDEX IF NOT EXISTS idx_certification_official       ON certification(official_id);
CREATE INDEX IF NOT EXISTS idx_distance_official_site       ON official_site_distance(official_id, site_id);
