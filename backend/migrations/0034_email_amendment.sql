-- Correction / amendment handling: a follow-up email can point at the earlier
-- email it amends (a parent re-sends with a changed reason/division/etc.). The
-- link gives provenance both ways — the correction shows what it corrects, and
-- the original is flagged as superseded so the TD knows the filed row needs a
-- second look. ON DELETE SET NULL so deleting the original doesn't orphan.
ALTER TABLE email_message
    ADD COLUMN amends_email_id int REFERENCES email_message(id) ON DELETE SET NULL;
CREATE INDEX idx_email_message_amends ON email_message(amends_email_id);
