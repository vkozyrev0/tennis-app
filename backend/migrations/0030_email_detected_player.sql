-- Inbox triage extension: per-email detected player FK, so the inbox grid
-- can show "who is this about" alongside the classification, and the bulk
-- "populate lists" action knows which player record to file the
-- withdrawal/late-entry/doubles-request against.
--
-- The detection is optional + heuristic — the TD overrides via a picker on
-- the detail pane if the regex match was wrong.
ALTER TABLE email_message
  ADD COLUMN IF NOT EXISTS detected_player_id INT NULL
    REFERENCES player(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_email_detected_player
  ON email_message (detected_player_id);
