-- Officials accept/decline (benchmark workflow gap): an official confirms or
-- declines the assignment the TD made for them. 'pending' until they respond;
-- the TD sees the status on the assignment + staffing report.
ALTER TABLE assignment
    ADD COLUMN response_status text NOT NULL DEFAULT 'pending'
        CHECK (response_status IN ('pending', 'accepted', 'declined')),
    ADD COLUMN responded_at timestamptz;
