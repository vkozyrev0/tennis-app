-- Stamp how long the local classifier took (ms) so the inbox can show
-- "classified in X ms" without re-running triage on list GET.

ALTER TABLE email_message
    ADD COLUMN IF NOT EXISTS classified_ms integer;

COMMENT ON COLUMN email_message.classified_ms IS
    'Wall time of the last local classify() run for this row, in milliseconds.';
