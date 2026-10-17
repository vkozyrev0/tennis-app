-- D24: a Part B row that changes the roster must be able to undo that change
-- on delete. Store what the row replaced instead of guessing it later.
--
-- withdrawal.prior_status: the tournament_entry.selection_status the withdrawal
-- flipped to 'withdrawn' (NULL when the player had no roster row yet).
-- late_entry.created_entry: true when filing the late entry inserted the roster
-- row (false when the player was already on the roster).
ALTER TABLE withdrawal
    ADD COLUMN prior_status selection_status;

ALTER TABLE late_entry
    ADD COLUMN created_entry boolean NOT NULL DEFAULT false;
