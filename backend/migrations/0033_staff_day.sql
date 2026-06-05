-- Per-day scheduling for non-official staff (parallels assignment_day). Lets the
-- staffing-plan report show which days each support-staff member works, with the
-- same weekday columns the officials roster uses.
CREATE TABLE staff_day (
    id        int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    staff_id  int NOT NULL REFERENCES tournament_staff(id) ON DELETE CASCADE,
    work_date date NOT NULL,
    UNIQUE (staff_id, work_date)
);
CREATE INDEX idx_staff_day_staff ON staff_day(staff_id);
