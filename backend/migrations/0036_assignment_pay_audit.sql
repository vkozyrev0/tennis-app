-- Money audit trail (audit §5.3): freeze the pay/mileage calc INPUTS (the miles
-- used + the rule constants + per-day rates), not just the outputs, so a
-- reimbursement is fully reproducible even if a distance or rate changes later.
-- Frozen alongside the existing snapshot_* columns on every assignment change.
ALTER TABLE assignment ADD COLUMN pay_audit jsonb;
