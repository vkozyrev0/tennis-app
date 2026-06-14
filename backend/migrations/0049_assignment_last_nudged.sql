-- UX: outreach memory. The TD chases officials who haven't accepted/declined
-- via mailto nudges, but had no record of WHO they'd already contacted. Stamp
-- the last time an assignment was nudged so the pending list can show
-- "nudged 2d ago" and the TD can tell a fresh gap from a chased-but-silent one.
-- Cleared back to NULL when the official finally responds (handled in the
-- response endpoint), so a stale nudge timestamp can't linger after a reply.
ALTER TABLE assignment ADD COLUMN last_nudged_at timestamptz;
