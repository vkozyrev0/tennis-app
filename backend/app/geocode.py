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
import json
import logging
import math
import os
import urllib.parse
import urllib.request

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


def maps_api_key() -> str | None:
    """The Google Maps key, or None when unset (the key-free fallback path)."""
    return os.getenv("GOOGLE_MAPS_API_KEY", "").strip() or None


def road_one_way_miles(lat1: float, lon1: float, lat2: float, lon2: float) -> tuple[float, str]:
    """One-way DRIVING miles + its provenance, key-gated (Phase 2 / D3/U2):

    - `GOOGLE_MAPS_API_KEY` set → the Google Distance Matrix API → ('maps', the
      authoritative road distance).
    - unset, or the call fails for any reason → the great-circle estimate
      ('geocoded'). Mileage feeds reimbursement, so a flaky/again-misconfigured
      API must never block it — we degrade to the estimate, never raise.

    Returns (miles, source) where source ∈ {'maps', 'geocoded'}."""
    key = maps_api_key()
    if key:
        try:
            miles = _maps_driving_miles(lat1, lon1, lat2, lon2, key)
            if miles is not None:
                return round(miles, 1), "maps"
        except Exception as e:  # network / quota / parse — fall back, don't block pay
            logging.warning("Maps distance lookup failed; using great-circle estimate: %r", e)
    return estimate_one_way_miles(lat1, lon1, lat2, lon2), "geocoded"


def _maps_driving_miles(lat1, lon1, lat2, lon2, key, *, timeout=8.0):
    """One Distance Matrix call → driving miles (or None if the API has no
    route). stdlib urllib so there's no new dependency. Coordinates only (no
    address PII leaves the box beyond the lat/lng already on file)."""
    params = urllib.parse.urlencode({
        "origins": f"{lat1},{lon1}", "destinations": f"{lat2},{lon2}",
        "units": "imperial", "mode": "driving", "key": key,
    })
    url = "https://maps.googleapis.com/maps/api/distancematrix/json?" + params
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 (fixed https host)
        data = json.loads(resp.read().decode())
    el = data["rows"][0]["elements"][0]
    if el.get("status") != "OK":
        return None
    return el["distance"]["value"] / 1609.344   # meters → miles


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
