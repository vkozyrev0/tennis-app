-- Per-day pay for non-official staff: a flat daily rate on the staff member.
-- Report pay = daily_rate × (number of scheduled days). Kept simple (one rate
-- per person, not per day) to match the day multi-select UI; per-day-varying
-- rates would be a later refinement.
ALTER TABLE tournament_staff ADD COLUMN daily_rate numeric(8,2);
