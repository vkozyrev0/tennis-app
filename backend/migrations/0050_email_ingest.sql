-- Email auto-ingest (D4): provenance columns + per-tournament routing address.
-- Dedicated forwarding addresses land in the review inbox via POST /api/ingest/email;
-- message_id uniqueness (0011) remains the dedup key.

ALTER TABLE email_message
    ADD COLUMN IF NOT EXISTS to_address text,
    ADD COLUMN IF NOT EXISTS ingest_source text NOT NULL DEFAULT 'manual';

COMMENT ON COLUMN email_message.to_address IS
    'Envelope/header To (or first recipient) when auto-ingested; null for manual paste.';
COMMENT ON COLUMN email_message.ingest_source IS
    'How the row entered the inbox: manual | webhook | form | pdf_import | …';

-- Local-part or full address used to route inbound mail to this tournament.
-- Example: "macon2026" or "macon2026@inbox.example.com". Matched case-insensitively
-- against the inbound To: address (full or local-part).
ALTER TABLE tournament
    ADD COLUMN IF NOT EXISTS ingest_address text;

COMMENT ON COLUMN tournament.ingest_address IS
    'Inbound routing key for email auto-ingest (local-part or full address).';

-- One active tournament per address; soft-deleted tournaments free the address.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_ingest_address_lower
    ON tournament (lower(ingest_address))
    WHERE ingest_address IS NOT NULL AND deleted_at IS NULL;
