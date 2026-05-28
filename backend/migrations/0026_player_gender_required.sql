-- Make player.gender required. Any rows that pre-date the addition of the
-- column get a 'female' placeholder so the TD can correct them via the Setup →
-- Players grid (which now has an inline gender editor). After this migration:
--   * direct POST/PUT /api/players require gender (Pydantic Literal)
--   * the Roster inline-create path requires gender when player_id is null
--   * Part B handlers (late_entries, withdrawals) that need to INSERT a new
--     player because the supplied USTA # isn't on file fall back to 'female'
--     as a placeholder, matching this backfill's behaviour.
UPDATE player SET gender = 'female' WHERE gender IS NULL;
ALTER TABLE player ALTER COLUMN gender SET NOT NULL;
