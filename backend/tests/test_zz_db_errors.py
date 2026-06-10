"""Global constraint-violation safety net (app/db_errors.py, plan P1 #4).

No router currently lets a violation escape (each either catches it with a
tailored message or guards/dedupes/cascades first), so these test the handler
MAPPING directly: a future migration that adds a UNIQUE/FK without a router
catch gets a readable 409/400 instead of a bare 500."""
import asyncio

import psycopg
import pytest

from app import db_errors
from app.main import app


class _Diag:
    def __init__(self, constraint):
        self.constraint_name = constraint


def _exc(cls, constraint=None):
    # psycopg's .diag is a read-only property, so fake it with a subclass that
    # shadows it — the handlers only getattr() their way to constraint_name.
    sub = type("_Stub", (cls,), {"diag": _Diag(constraint)})
    return sub("boom")


def test_unique_violation_maps_to_409():
    resp = asyncio.run(db_errors._unique_violation(
        None, _exc(psycopg.errors.UniqueViolation, "staff_day_staff_id_work_date_key")))
    assert resp.status_code == 409
    assert b"already exists" in resp.body
    assert b"staff_day_staff_id_work_date_key" in resp.body


def test_fk_violation_maps_to_400():
    resp = asyncio.run(db_errors._fk_violation(
        None, _exc(psycopg.errors.ForeignKeyViolation, "room_block_hotel_id_fkey")))
    assert resp.status_code == 400
    assert b"referenced record does not exist" in resp.body


def test_check_violation_maps_to_400():
    resp = asyncio.run(db_errors._check_violation(
        None, _exc(psycopg.errors.CheckViolation)))
    assert resp.status_code == 400


def test_handlers_are_registered_on_the_app():
    for cls in (psycopg.errors.UniqueViolation,
                psycopg.errors.ForeignKeyViolation,
                psycopg.errors.CheckViolation):
        assert cls in app.exception_handlers
