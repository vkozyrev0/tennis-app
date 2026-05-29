-- Persist WHY the detector picked a player so the Inbox can show a confidence
-- hint (usta = definitive, fullname = strong, lastname = weak guess). Set by
-- the detect endpoints alongside detected_player_id; NULL when undetected.
ALTER TABLE email_message
  ADD COLUMN IF NOT EXISTS detected_match_kind TEXT NULL;
