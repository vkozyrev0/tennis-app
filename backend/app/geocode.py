"""Geocoding + distance estimation for auto-mileage (Phase 2 / D3/U2).

The **authoritative** mileage source is a routing API (Google Maps *driving*
distance). That needs a billed API key + network egress + cost approval and is
**not** wired up here. This module is the seam plus a key-free fallback:

- `geocode_address(addr)` resolves an address → (lat, lng). Default provider is
  `none` (returns None = "not configured"); a `google` provider is stubbed
  behind `GEOCODER=google` but deliberately unimplemented (no live call without
  a key). Note: geocoding an official's **home** address sends PII off-site —
  see docs/pii-hardening-plan.md §H5 before enabling.
- `haversine_miles()` is the great-circle distance; `estimate_one_way_miles()`
  applies a road-circuity factor for a rough ONE-WAY *driving* estimate.

The estimate is explicitly a **fallback**, surfaced as `source='geocoded'`, and
the TD can edit it before it drives reimbursement — it is NOT a substitute for a
real routing lookup.
"""
import math
import os

# Straight-line → road distance ratio (circuity). ~1.2–1.3 is typical for US
# metro driving; 1.2 is a conservative default that won't over-reimburse much.
ROAD_CIRCUITY_FACTOR = 1.2
_EARTH_RADIUS_MILES = 3958.7613


def haversine_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/long points, in miles."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * _EARTH_RADIUS_MILES * math.asin(math.sqrt(a))


def estimate_one_way_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Rough one-way driving miles = great-circle × road-circuity factor."""
    return round(haversine_miles(lat1, lon1, lat2, lon2) * ROAD_CIRCUITY_FACTOR, 1)


def geocoder_name() -> str:
    return os.getenv("GEOCODER", "none").strip().lower()


def geocode_address(address: str):
    """Resolve a free-text address to (lat, lng), or None if no geocoder.

    Provider seam: `none` (default) → None, so callers fall back to manually
    entered coordinates. `google` is where a Maps Geocoding call belongs; it
    raises rather than silently returning None so a misconfigured deployment
    fails loudly (needs GOOGLE_MAPS_API_KEY + the implementation)."""
    name = geocoder_name()
    if name in ("", "none", "manual"):
        return None
    if name == "google":
        raise NotImplementedError(
            "Google geocoding is not wired up — set GOOGLE_MAPS_API_KEY and "
            "implement the Maps Geocoding call (D3/U2; see docs/roadmap.md).")
    raise ValueError(f"unknown GEOCODER={name!r} (use none|google)")
