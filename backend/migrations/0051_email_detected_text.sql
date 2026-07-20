-- Persist derived inbox text fields so list GETs don't re-run 6–10 regex
-- extractors per row (performance audit D9). Mirrors the detected_usta_text
-- pattern from 0039: stamp on write/detect/classify; list only reads.
--
-- detected_text_ready distinguishes "never stamped" (legacy rows) from
-- "stamped but empty" (no division/reason found). List lazy-backfills only
-- when ready is false.

ALTER TABLE email_message
  ADD COLUMN IF NOT EXISTS detected_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS detected_division TEXT NULL,
  ADD COLUMN IF NOT EXISTS detected_events TEXT NULL,
  ADD COLUMN IF NOT EXISTS detected_name_pairs JSONB NULL,
  ADD COLUMN IF NOT EXISTS detected_avoid_day TEXT NULL,
  ADD COLUMN IF NOT EXISTS detected_avoid_time TEXT NULL,
  ADD COLUMN IF NOT EXISTS detected_text_ready BOOLEAN NOT NULL DEFAULT FALSE;
