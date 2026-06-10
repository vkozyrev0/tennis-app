"""Global constraint-violation → HTTP mapping (improvement-plan P1 #4).

Most writers translate psycopg constraint errors themselves with tailored
messages (assignments, divisions, distances, …) — those run first and are
unaffected. This module is the SAFETY NET for the routers that don't: without
it, an uncaught UniqueViolation/ForeignKeyViolation surfaces as a bare 500 and
the UI says "Internal Server Error" instead of "already exists".

Registered once in main.py via install(app). The per-request connection is
already rolled back by db_dep's except path before these handlers run.
"""
import psycopg
from fastapi import Request
from fastapi.responses import JSONResponse


def _constraint(exc: psycopg.Error) -> str:
    name = getattr(getattr(exc, "diag", None), "constraint_name", None)
    return f" ({name})" if name else ""


async def _unique_violation(request: Request, exc: psycopg.errors.UniqueViolation):
    return JSONResponse(status_code=409, content={
        "detail": f"a record with these values already exists{_constraint(exc)}"})


async def _fk_violation(request: Request, exc: psycopg.errors.ForeignKeyViolation):
    return JSONResponse(status_code=400, content={
        "detail": f"a referenced record does not exist{_constraint(exc)}"})


async def _check_violation(request: Request, exc: psycopg.errors.CheckViolation):
    return JSONResponse(status_code=400, content={
        "detail": f"value rejected by a data rule{_constraint(exc)}"})


def install(app) -> None:
    app.add_exception_handler(psycopg.errors.UniqueViolation, _unique_violation)
    app.add_exception_handler(psycopg.errors.ForeignKeyViolation, _fk_violation)
    app.add_exception_handler(psycopg.errors.CheckViolation, _check_violation)
