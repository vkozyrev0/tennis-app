"""Two-stage Inbox progress: reading the mailbox, then processing the mail.

The overlay polls a job instead of waiting on one JSON response, so the counts
it shows have to be real and have to end. These drive the store and the
reporter directly; the route test below checks the poll contract.
"""
from __future__ import annotations

import pytest

from app import job_progress
from app.inbox_progress import JobReporter, NullReporter, run_reading


@pytest.fixture(autouse=True)
def _clean_jobs():
    job_progress.reset()
    yield
    job_progress.reset()


def test_a_job_starts_running_and_reads_only_its_own_counts():
    token = job_progress.new_job("fetch", tournament_id=2)
    snap = job_progress.get(token)
    assert snap["state"] == "running"
    assert snap["stage"] == "reading"
    assert snap["reading"] == {"discovered": 0, "read": 0, "feeds": {}}
    assert snap["processing"] == {"total": 0, "done": 0}
    assert job_progress.get("not-a-token") is None


def test_reading_then_processing_is_two_separate_counts():
    token = job_progress.new_job("fetch")
    reporter = JobReporter(token)
    on_download, on_classify = _callbacks(reporter, "gmail")
    on_download(4, 0)
    on_download(4, 3)
    reporter.feed_finished("gmail", 4, 4)
    on_classify(4, 0)
    on_classify(4, 1)
    on_classify(4, 2)
    snap = job_progress.get(token)
    # Reading finished at 4 of 4 while processing has finished 2 of 4.
    assert snap["reading"]["read"] == 4
    assert snap["reading"]["discovered"] == 4
    assert snap["processing"] == {"total": 4, "done": 2}
    assert snap["reading"]["feeds"]["gmail"]["state"] == "done"


def test_two_feeds_report_into_one_job_without_overwriting_each_other():
    token = job_progress.new_job("fetch")
    reporter = JobReporter(token)
    gmail_dl, gmail_cls = _callbacks(reporter, "gmail")
    outlook_dl, outlook_cls = _callbacks(reporter, "outlook")
    gmail_dl(3, 3)
    gmail_cls(3, 0)
    gmail_cls(3, 3)
    outlook_dl(2, 2)
    outlook_cls(2, 0)
    outlook_cls(2, 2)
    snap = job_progress.get(token)
    assert set(snap["reading"]["feeds"]) == {"gmail", "outlook"}
    assert snap["reading"]["read"] == 5
    # The processing bar counts every feed's queue, so it reaches 5, not the
    # last feed's 2.
    assert snap["processing"] == {"total": 5, "done": 5}


def test_a_cancelled_job_stops_taking_reports_and_keeps_the_outcome():
    token = job_progress.new_job("fetch")
    reporter = JobReporter(token)
    on_download, _ = _callbacks(reporter, "gmail")
    on_download(5, 1)
    assert job_progress.cancel(token)["state"] == "cancelled"
    assert reporter.cancelled() is True
    on_download(5, 4)
    assert job_progress.get(token)["reading"]["read"] == 1
    job_progress.finish(token)
    assert job_progress.get(token)["state"] == "cancelled"


def test_a_failed_job_carries_its_reason():
    token = job_progress.new_job("fetch")
    job_progress.fail(token, "Gmail login failed")
    snap = job_progress.get(token)
    assert snap["state"] == "failed"
    assert "login" in snap["error"]


def test_a_job_that_stopped_reporting_reads_as_failed(monkeypatch):
    """A worker that dies mid-run must not leave the overlay polling forever."""
    token = job_progress.new_job("fetch")
    monkeypatch.setattr(job_progress, "JOB_TTL_SECONDS", -1)
    assert job_progress.get(token)["state"] == "failed"


def test_the_null_reporter_accepts_every_call():
    r = NullReporter()
    r.feed_started("gmail")
    r.feed_progress("gmail", 1, 1)
    r.feed_finished("gmail", 1, 1)
    r.processing_total(1)
    r.processing_done(1)
    r.stage("reading")
    assert r.cancelled() is False


def test_run_reading_skips_a_feed_after_cancel():
    token = job_progress.new_job("fetch")
    reporter = JobReporter(token)
    called = []

    def fetch_one(on_download, on_classify):
        called.append("gmail")
        on_download(2, 2)
        on_classify(2, 0)
        job_progress.cancel(token)
        return {"fetched": 2}

    def fetch_two(on_download, on_classify):
        called.append("outlook")
        return {"fetched": 0}

    out = run_reading(None, [("gmail", fetch_one), ("outlook", fetch_two)], reporter)
    assert called == ["gmail"]
    assert out == {"gmail": {"fetched": 2}}


def _callbacks(reporter, feed):
    from app.inbox_progress import feed_callbacks
    return feed_callbacks(reporter, feed)
