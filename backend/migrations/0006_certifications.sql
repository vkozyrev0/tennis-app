-- CourtOps Tennis — certifications an official holds (audit §3.2 follow-up).
-- Used to constrain the role an official can be assigned to work on a given day.
-- certification_type enum already exists (migration 0002).

CREATE TABLE certification (
    id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    official_id int NOT NULL REFERENCES official(id) ON DELETE CASCADE,
    cert_type   certification_type NOT NULL,
    UNIQUE (official_id, cert_type)
);

CREATE INDEX idx_certification_official ON certification(official_id);
