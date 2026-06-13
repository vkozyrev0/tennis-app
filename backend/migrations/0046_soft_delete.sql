-- P2 #13 (scoped): soft-delete for the two non-PII, high-recoverability
-- entities — tournaments (a delete cascades the whole event; an accidental one
-- is catastrophic) and day-of incidents (operational notes). deleted_at NULL =
-- active; a timestamp = trashed (hidden from lists, restorable from Trash).
--
-- Deliberately NOT players/officials/emails: delete_player is a COPPA PII-ERASURE
-- (it nulls the minor's PII from player_history), and soft-delete there would
-- regress that privacy guarantee. Those stay hard-delete.
ALTER TABLE tournament ADD COLUMN deleted_at timestamptz;
ALTER TABLE tournament_incident ADD COLUMN deleted_at timestamptz;

-- Partial indexes: list queries filter `deleted_at IS NULL` (the common path).
CREATE INDEX idx_tournament_active ON tournament (id) WHERE deleted_at IS NULL;
CREATE INDEX idx_incident_active ON tournament_incident (tournament_id)
    WHERE deleted_at IS NULL;
