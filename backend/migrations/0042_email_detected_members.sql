-- Pairing-avoidance emails name 2+ players ("don't pair A with B (and C)").
-- detected_partner_id (0041) covers doubles' fixed second slot; this array
-- holds ALL detected players (primary first) for pairing_avoidance emails so
-- the inbox shows the whole group and filing pre-fills every member row.
ALTER TABLE email_message
    ADD COLUMN detected_member_ids int[];

COMMENT ON COLUMN email_message.detected_member_ids IS
    'pairing_avoidance: ALL detected players (primary first); NULL otherwise';
