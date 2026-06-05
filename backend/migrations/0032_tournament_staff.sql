-- Non-official tournament staff (Site Director, Player Amenities, Trainer,
-- Operations, Stringer, ...). The officials model covers certified officials
-- with pay/mileage; these support roles are simpler — a per-tournament roster
-- of name + role + contact — and round out the TD's staffing-plan report.
CREATE TYPE staff_role AS ENUM (
    'site_director', 'player_amenities', 'trainer', 'operations', 'stringer', 'other'
);

CREATE TABLE tournament_staff (
    id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id int NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    name          text NOT NULL,
    role          staff_role NOT NULL,
    phone         text,
    email         text,
    notes         text,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tournament_staff_tournament ON tournament_staff(tournament_id);
