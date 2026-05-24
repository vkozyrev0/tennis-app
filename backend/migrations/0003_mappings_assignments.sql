-- CourtOps Tennis — Phase 1: tournament hub restructure + full assignments
--   * Tournament <-> Site becomes many-to-many (a tournament can use >1 site)
--   * Split hotel_room_block into hotel (property) + room_block (inventory)
--   * official_site_distance matrix (mileage input, audit §3.7)
--   * assignment + assignment_day (per-day role/rate, audit §3.2) + hotel/site links

-- ---------- Tournament <-> Site (M2M) ----------
CREATE TABLE tournament_site (
    tournament_id int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    site_id       int NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    PRIMARY KEY (tournament_id, site_id)
);
-- carry over the existing single-site links, then drop the column
INSERT INTO tournament_site (tournament_id, site_id)
    SELECT id, site_id FROM tournament WHERE site_id IS NOT NULL;
ALTER TABLE tournament DROP COLUMN site_id;

-- ---------- Hotels: split property from room block ----------
CREATE TABLE hotel (
    id         int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       text NOT NULL,
    website    text,
    street     text,
    city       text,
    state      text,
    zip        text,
    phone      text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_block (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hotel_id            int NOT NULL REFERENCES hotel(id) ON DELETE CASCADE,
    tournament_id       int REFERENCES tournament(id) ON DELETE SET NULL,
    confirmation_number text,
    cancellation_info   text,
    check_in            date,
    check_out           date,
    room_count          int NOT NULL DEFAULT 0 CHECK (room_count >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT room_block_dates_ok CHECK (
        check_in IS NULL OR check_out IS NULL OR check_out >= check_in
    )
);

-- migrate any existing hotel_room_block rows into the split tables
DO $$
DECLARE r record; hid int;
BEGIN
    FOR r IN SELECT * FROM hotel_room_block LOOP
        INSERT INTO hotel (name, website, street, city, state, zip, phone)
            VALUES (r.hotel_name, r.website, r.street, r.city, r.state, r.zip, r.phone)
            RETURNING id INTO hid;
        INSERT INTO room_block
            (hotel_id, tournament_id, confirmation_number, cancellation_info,
             check_in, check_out, room_count)
            VALUES (hid, r.tournament_id, r.confirmation_number, r.cancellation_info,
                    r.check_in, r.check_out, r.room_count);
    END LOOP;
END $$;
DROP TABLE hotel_room_block;

CREATE INDEX idx_room_block_hotel      ON room_block(hotel_id);
CREATE INDEX idx_room_block_tournament ON room_block(tournament_id);

-- ---------- Official <-> Site distance matrix ----------
CREATE TYPE distance_source AS ENUM ('geocoded', 'manual');

CREATE TABLE official_site_distance (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    official_id   int NOT NULL REFERENCES official(id) ON DELETE CASCADE,
    site_id       int NOT NULL REFERENCES site(id) ON DELETE CASCADE,
    one_way_miles numeric(6,1) NOT NULL CHECK (one_way_miles >= 0),
    source        distance_source NOT NULL DEFAULT 'manual',
    UNIQUE (official_id, site_id)
);

-- ---------- Assignments (Tournament <-> Official) ----------
CREATE TABLE assignment (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    official_id   int NOT NULL REFERENCES official(id) ON DELETE CASCADE,
    site_id       int REFERENCES site(id) ON DELETE SET NULL,        -- venue worked (mileage)
    room_block_id int REFERENCES room_block(id) ON DELETE SET NULL,  -- lodging
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tournament_id, official_id)
);

-- one row per worked day; role can change day-to-day (audit §3.2). rate_applied
-- snapshots the certification_rate in effect for that role/day (audit §5.3).
CREATE TABLE assignment_day (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    assignment_id int NOT NULL REFERENCES assignment(id) ON DELETE CASCADE,
    work_date     date NOT NULL,
    working_as    certification_type NOT NULL,
    rate_applied  numeric(8,2) NOT NULL DEFAULT 0,
    UNIQUE (assignment_id, work_date)
);

CREATE INDEX idx_assignment_tournament ON assignment(tournament_id);
CREATE INDEX idx_assignment_official   ON assignment(official_id);
CREATE INDEX idx_assignment_day_asg    ON assignment_day(assignment_id);
