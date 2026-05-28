-- CourtOps Tennis — store pay/mileage snapshots on assignments (audit §5.3).
-- Money is recomputed and frozen on every assignment change, with the rule
-- version used, so a figure is reproducible from stored inputs even if rates or
-- distances change later.

ALTER TABLE assignment ADD COLUMN snapshot_pay     numeric(10,2);
ALTER TABLE assignment ADD COLUMN snapshot_mileage numeric(10,2);
ALTER TABLE assignment ADD COLUMN snapshot_total   numeric(10,2);
ALTER TABLE assignment ADD COLUMN rule_version     text;
ALTER TABLE assignment ADD COLUMN snapshot_at      timestamptz;
