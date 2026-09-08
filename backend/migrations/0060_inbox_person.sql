-- Parallel inbox people list (name + USTA), separate from Setup Players.
-- Parsed email pairs upsert here; promote copies onto player (catalog, not roster).
CREATE TABLE inbox_person (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                text NOT NULL,
    first_name          text,
    last_name           text,
    usta_number         text,
    gender              text,
    source_email_id     int REFERENCES email_message(id) ON DELETE SET NULL,
    promoted_player_id  int REFERENCES player(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX inbox_person_usta_uidx
    ON inbox_person (usta_number) WHERE usta_number IS NOT NULL;
CREATE UNIQUE INDEX inbox_person_name_uidx
    ON inbox_person (lower(name)) WHERE usta_number IS NULL;
CREATE INDEX inbox_person_source_idx ON inbox_person (source_email_id);
