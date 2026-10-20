"""In-process progress for work a browser cannot see until the request ends.

The overlay reads a whole JSON response at once, so a request that classifies
ten mailboxes' worth of mail reports nothing until it is done. A background job
writes its counts here as it goes, and the browser polls the same numbers.

One store for all jobs, keyed by an unguessable token, because the two things a
user starts from the Inbox (reading the mailbox, processing stored copies) are
the same kind of work and must report in the same shape.

A job is a state machine: running -> (finished | failed | cancelled). It always
ends, because a reader that finds a stale job would otherwise wait forever; a
job that has not been touched for JOB_TTL_SECONDS is reported as failed.

Counts are per stage. `reading` covers download work (discovered, read);
`processing` covers the model pass (total, done). Nothing here calls the model
or the database.
"""
from __future__ import annotations

import os
import secrets
import threading
import time
from typing import Any

_RUNNING, _FINISHED, _FAILED, _CANCELLED = "running", "finished", "failed", "cancelled"

# A crashed process leaves an entry behind. The store is per process, so the
# age check only matters for a job whose worker died mid-request.
JOB_TTL_SECONDS = float(os.getenv("INBOX_JOB_TTL_SECONDS", "1800"))

_lock = threading.Lock()
_jobs: dict[str, dict[str, Any]] = {}
_next_id = 0


def _now() -> float:
    return time.monotonic()


def _clean(now: float) -> None:
    stale = [
        k for k, j in _jobs.items()
        if now - j["touched"] > JOB_TTL_SECONDS and j["state"] != _RUNNING
    ]
    for k in stale:
        _jobs.pop(k, None)


def new_job(kind: str, *, tournament_id: int | None = None, window=None) -> str:
    """Register a running job and return its token."""
    global _next_id
    with _lock:
        now = _now()
        _clean(now)
        _next_id += 1
        token = f"{_next_id}-{secrets.token_urlsafe(16)}"
        _jobs[token] = {
            "token": token,
            "kind": kind,
            "tournament_id": tournament_id,
            "window": list(window) if window else None,
            "state": _RUNNING,
            "stage": "reading",
            "reading": {"feeds": {}},
            "processing": {"total": 0, "done": 0},
            "error": None,
            "result": None,
            "started": now,
            "touched": now,
        }
        return token


def _update(token: str, fn) -> dict | None:
    with _lock:
        job = _jobs.get(token)
        if job is None:
            return None
        fn(job)
        job["touched"] = _now()
        return snapshot(job)


def feed_started(token: str, feed: str) -> None:
    """A feed has begun its download. Records it and makes it the busy stage."""
    def fn(job: dict) -> None:
        job["reading"]["feeds"].setdefault(feed, {
            "state": "reading", "discovered": 0, "read": 0,
        })
        job["reading"]["feeds"][feed]["state"] = "reading"
        job["stage"] = "reading"
    _update(token, fn)


def feed_progress(token: str, feed: str, *, discovered: int | None = None,
                  read: int | None = None) -> None:
    def fn(job: dict) -> None:
        entry = job["reading"]["feeds"].setdefault(
            feed, {"state": "reading", "discovered": 0, "read": 0})
        if discovered is not None:
            entry["discovered"] = max(0, int(discovered))
        if read is not None:
            entry["read"] = max(0, int(read))
    _update(token, fn)


def feed_finished(token: str, feed: str, *, discovered: int, read: int,
                  state: str = "done") -> None:
    def fn(job: dict) -> None:
        job["reading"]["feeds"][feed] = {
            "state": state, "discovered": max(0, int(discovered)), "read": max(0, int(read)),
        }
    _update(token, fn)


def counts(token: str, *, discovered: int, read: int) -> None:
    """Totals across feeds, for a caller that reports the whole download at once."""
    def fn(job: dict) -> None:
        job["reading"]["feeds"]["all"] = {
            "state": "done", "discovered": max(0, int(discovered)), "read": max(0, int(read)),
        }
    _update(token, fn)


def stage(token: str, name: str) -> None:
    _update(token, lambda job: job.__setitem__("stage", name))


def processing_total(token: str, total: int, *, done: int = 0) -> None:
    def fn(job: dict) -> None:
        job["processing"] = {"total": max(0, int(total)), "done": max(0, int(done))}
        job["stage"] = "processing"
    _update(token, fn)


def processing_done(token: str, done: int) -> None:
    def fn(job: dict) -> None:
        job["processing"]["done"] = max(0, int(done))
    _update(token, fn)


def finish(token: str, result: dict | None = None) -> None:
    def fn(job: dict) -> None:
        if job["state"] != _RUNNING:
            return  # cancelled or already ended: keep that outcome
        job["state"] = _FINISHED
        job["stage"] = "done"
        job["result"] = result
    _update(token, fn)


def fail(token: str, message: str) -> None:
    def fn(job: dict) -> None:
        if job["state"] == _CANCELLED:
            return
        job["state"] = _FAILED
        job["error"] = str(message)[:500]
    _update(token, fn)


def is_cancelled(token: str) -> bool:
    with _lock:
        job = _jobs.get(token)
        return job is not None and job["state"] == _CANCELLED


def cancel(token: str) -> dict | None:
    """Stop a job. A job already ending keeps its outcome (cancel loses)."""
    def fn(job: dict) -> None:
        if job["state"] == _RUNNING:
            job["state"] = _CANCELLED
    return _update(token, fn)


def snapshot(job: dict) -> dict:
    """The wire shape. Derived totals live here so both sides read one number."""
    feeds = job["reading"]["feeds"]
    discovered = sum(f.get("discovered", 0) for f in feeds.values())
    read = sum(f.get("read", 0) for f in feeds.values())
    elapsed = _now() - job["started"]
    if job["state"] == _RUNNING and _now() - job["touched"] > JOB_TTL_SECONDS:
        state, error = _FAILED, "the job stopped reporting"
    else:
        state, error = job["state"], job["error"]
    return {
        "token": job["token"],
        "kind": job["kind"],
        "state": state,
        "stage": job["stage"],
        "reading": {
            "discovered": discovered,
            "read": read,
            "feeds": {k: dict(v) for k, v in feeds.items()},
        },
        "processing": dict(job["processing"]),
        "error": error,
        "result": job["result"],
        "elapsed_ms": int(elapsed * 1000),
    }


def get(token: str) -> dict | None:
    with _lock:
        job = _jobs.get(token)
        return snapshot(job) if job else None


def reset() -> None:
    """Tests: drop every job."""
    with _lock:
        _jobs.clear()
