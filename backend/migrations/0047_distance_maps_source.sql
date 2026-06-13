-- Phase 2 (D3/U2) scaffold: distinguish an authoritative Google Maps *driving*
-- distance from the key-free great-circle estimate. The auto-distance endpoint
-- stamps 'maps' when GOOGLE_MAPS_API_KEY is set and the Distance Matrix call
-- succeeds, else 'geocoded' (the existing fallback). Adds the value only — no
-- row uses it in this migration, so it's safe inside the migration transaction.
ALTER TYPE distance_source ADD VALUE IF NOT EXISTS 'maps';
