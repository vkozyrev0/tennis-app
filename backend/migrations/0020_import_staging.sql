-- CourtOps Tennis — import staging (audit §3.8): uploads land in a staging area,
-- are validated per-row, then merged into the main tables on confirm.

CREATE TABLE import_batch (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id int REFERENCES tournament(id) ON DELETE CASCADE,
    import_type   text NOT NULL,            -- roster | late_entries | ... (see app/importer.py)
    filename      text,
    status        text NOT NULL DEFAULT 'staged',  -- staged | merged
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_row (
    id        int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id  int NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
    row_num   int NOT NULL,                 -- source row (1 = first data row)
    data      jsonb NOT NULL,               -- canonicalized field -> value
    valid     boolean NOT NULL,
    error     text,
    merged    boolean NOT NULL DEFAULT false
);

CREATE INDEX idx_import_row_batch ON import_row(batch_id);
