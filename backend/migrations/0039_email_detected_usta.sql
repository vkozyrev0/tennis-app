-- Persist the USTA # parsed from an email's text so it is server-side searchable
-- (the body itself is encrypted at rest — H2 — so it can't be ILIKE'd in SQL).
-- Populated on insert/import; existing rows are lazily backfilled on first read.
ALTER TABLE email_message
  ADD COLUMN IF NOT EXISTS detected_usta_text TEXT NULL;
