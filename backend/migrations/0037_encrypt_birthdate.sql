-- PII H2 (final field): encrypt player birthdate at rest. A Fernet token is
-- text, so the column changes date -> text; existing dates become plaintext text
-- (the app's decrypt() passes those through). Because Fernet is NON-deterministic
-- (same DOB -> different ciphertext each write), the history trigger can no
-- longer detect a birthdate change by equality, so birthdate is dropped from the
-- change comparison — it is still snapshotted whenever a name change fires. Names
-- remain the point-in-time audit anchor (roster name resolution is unaffected).
ALTER TABLE player         ALTER COLUMN birthdate TYPE text USING birthdate::text;
ALTER TABLE player_history ALTER COLUMN birthdate TYPE text USING birthdate::text;

CREATE OR REPLACE FUNCTION player_track_history() RETURNS trigger AS $$
BEGIN
    IF (TG_OP = 'UPDATE') THEN
        -- birthdate excluded from change detection (encrypted, non-deterministic)
        IF (OLD.usta_number, OLD.first_name, OLD.last_name)
           IS DISTINCT FROM (NEW.usta_number, NEW.first_name, NEW.last_name) THEN
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
