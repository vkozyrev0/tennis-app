-- CourtOps Tennis — Phase 1: certification rates + hotel room blocks
-- See docs/data-model.md (CertificationRate, HotelRoomBlock) and audit §3.2, §3.4.

-- Certification/position types an official can be paid for (audit §3.2).
CREATE TYPE certification_type AS ENUM ('roving', 'chair', 'referee');

-- ---------- certification_rate ----------
-- TD-set pay rate, per day, per certification (audit §3.2 / D2). effective_from
-- keeps rate history for auditability (audit §5.3).
CREATE TABLE certification_rate (
    id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cert_type      certification_type NOT NULL,
    rate_per_day   numeric(8,2) NOT NULL CHECK (rate_per_day >= 0),
    effective_from date NOT NULL DEFAULT CURRENT_DATE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cert_type, effective_from)
);

-- ---------- hotel_room_block ----------
-- Officials lodging inventory the TD manages (audit §1.2, §3.4). Scoped to a
-- tournament (nullable) so the per-tournament report can show availability.
-- room_count drives allocation; check_in/out define the reservation window that
-- assignment dates are validated against (a mismatch becomes a report alert).
CREATE TABLE hotel_room_block (
    id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tournament_id       int REFERENCES tournament(id) ON DELETE SET NULL,
    hotel_name          text NOT NULL,
    website             text,
    street              text,
    city                text,
    state               text,
    zip                 text,
    phone               text,
    confirmation_number text,
    cancellation_info   text,
    check_in            date,
    check_out           date,
    room_count          int NOT NULL DEFAULT 0 CHECK (room_count >= 0),
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hotel_dates_ok CHECK (
        check_in IS NULL OR check_out IS NULL OR check_out >= check_in
    )
);

CREATE INDEX idx_hotel_block_tournament ON hotel_room_block(tournament_id);
