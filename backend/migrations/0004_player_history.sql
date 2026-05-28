-- CourtOps Tennis — player mutability + history (SCD Type 4)
-- Player stays the single current record; player_history keeps every past version
-- with a [valid_from, valid_to) window, maintained by a trigger. See
-- docs/data-model.md §PlayerHistory. Roster reports resolve names point-in-time.

ALTER TABLE player ADD COLUMN birthdate  date;
ALTER TABLE player ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Audit table. Intentionally NO FK on player_id so history survives a player
-- delete (an audit log must outlive the record it describes).
CREATE TABLE player_history (
    id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    player_id   int NOT NULL,
    usta_number text,
    first_name  text,
    last_name   text,
    birthdate   date,
    valid_from  timestamptz NOT NULL,
    valid_to    timestamptz NOT NULL DEFAULT now(),
    change_type text NOT NULL,            -- 'update' | 'delete'
    changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_player_history_player ON player_history(player_id);

CREATE OR REPLACE FUNCTION player_track_history() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        -- only record when a tracked field actually changed
        IF (OLD.usta_number, OLD.first_name, OLD.last_name, OLD.birthdate)
           IS DISTINCT FROM (NEW.usta_number, NEW.first_name, NEW.last_name, NEW.birthdate) THEN
            INSERT INTO player_history
                (player_id, usta_number, first_name, last_name, birthdate,
                 valid_from, valid_to, change_type)
            VALUES (OLD.id, OLD.usta_number, OLD.first_name, OLD.last_name, OLD.birthdate,
                    OLD.updated_at, now(), 'update');
            NEW.updated_at := now();
        END IF;
        RETURN NEW;
    ELSIF (TG_OP = 'DELETE') THEN
        INSERT INTO player_history
            (player_id, usta_number, first_name, last_name, birthdate,
             valid_from, valid_to, change_type)
        VALUES (OLD.id, OLD.usta_number, OLD.first_name, OLD.last_name, OLD.birthdate,
                OLD.updated_at, now(), 'delete');
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_player_history
BEFORE UPDATE OR DELETE ON player
FOR EACH ROW EXECUTE FUNCTION player_track_history();
