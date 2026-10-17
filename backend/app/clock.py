"""Venue-local calendar dates (D25).

Timestamps stay UTC. Calendar decisions (the day-of default, deadline counts,
retention cutoffs) belong to the venue's clock, not the container's: a UTC
container is already on tomorrow's date during a US evening.
"""
from datetime import date, datetime
from zoneinfo import ZoneInfo

from .config import settings


def venue_tz() -> ZoneInfo:
    """The configured IANA zone. A bad value fails loudly instead of silently
    using UTC and reintroducing the off-by-one."""
    name = settings.venue_tz or "America/New_York"
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError) as exc:
        raise RuntimeError(
            f"COURTOPS_VENUE_TZ={name!r} is not a valid IANA timezone"
        ) from exc


def today_venue() -> date:
    """Today's date on the venue's clock."""
    return datetime.now(venue_tz()).date()
