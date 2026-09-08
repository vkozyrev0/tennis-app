-- Inbox Clear hides CourtOps copies instead of DELETE. Gmail/Outlook mailboxes
-- are never touched. Get mails / Get all un-hide matching message_id rows.
ALTER TABLE email_message ADD COLUMN deleted_at timestamptz;
CREATE INDEX idx_email_active ON email_message (tournament_id)
    WHERE deleted_at IS NULL;
