-- Doubles emails involve TWO players (requester + partner), but detection only
-- linked one. Second slot for the partner; the detector fills it for
-- doubles-classified emails by re-running the layered match with the primary
-- player excluded.
ALTER TABLE email_message
    ADD COLUMN detected_partner_id int REFERENCES player(id) ON DELETE SET NULL;

COMMENT ON COLUMN email_message.detected_partner_id IS
    'Doubles: the detected PARTNER (second player) — NULL for other classifications';
