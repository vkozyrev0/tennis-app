"""Venue-local calendar (D25).

The container runs on UTC. Day-of defaults, deadlines, and retention cutoffs
must use the venue's zone or a US evening sees tomorrow's date.
"""
import pytest

from app.clock import today_venue, venue_tz


def test_today_venue_follows_the_configured_zone(monkeypatch):
    monkeypatch.setenv("COURTOPS_VENUE_TZ", "Pacific/Kiritimati")  # UTC+14
    east = today_venue()
    monkeypatch.setenv("COURTOPS_VENUE_TZ", "Pacific/Midway")      # UTC-11
    west = today_venue()
    assert east > west


def test_bad_zone_fails_loudly(monkeypatch):
    monkeypatch.setenv("COURTOPS_VENUE_TZ", "Mars/Olympus")
    with pytest.raises(RuntimeError, match="IANA"):
        venue_tz()
