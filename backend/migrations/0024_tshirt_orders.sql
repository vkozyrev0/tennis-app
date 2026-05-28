-- Per-tournament t-shirt order tracking. One row per tournament holds both the
-- current on-hand inventory and (once the order is placed) the snapshot of
-- player-requested counts at order time, so the TD can compare original
-- ordered numbers to current need after late entries / withdrawals shift them.
CREATE TABLE IF NOT EXISTS tshirt_order (
  tournament_id INTEGER PRIMARY KEY REFERENCES tournament(id) ON DELETE CASCADE,
  ordered_at    DATE NULL,
  -- Per-size counts as JSON: { "YS": n, "YM": n, ..., "AXL": n }. NULL until
  -- the order is placed; snapshot freezes the requested-by-players counts
  -- at that moment so it doesn't drift with later withdrawals/late entries.
  snapshot      JSONB NULL,
  on_hand       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
