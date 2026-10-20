"""Report an Inbox mail pass to a job, stage by stage.

The reading stage is per feed: how many messages the mailbox search found and
how many have been fetched. The processing stage is the model pass over those
messages: how many were ingested and how far it got.

Each feed runs its own queue, so `fetch_latest` reports that queue's size and
its own done count. The overlay shows job-wide numbers, so `JobReporter` keeps
the feeds apart and adds them up.

`JobReporter` writes those counts to `job_progress`; `NullReporter` is the
blocking route's stand-in, so one code path serves both and cannot drift.
"""
from __future__ import annotations

from typing import Any, Callable


class NullReporter:
    """No job to report to: every method is a no-op."""

    token: str | None = None

    def set_feed(self, feed: str) -> None:
        pass

    def feed_started(self, feed: str) -> None:
        pass

    def feed_progress(self, feed: str, discovered: int, read: int) -> None:
        pass

    def feed_finished(self, feed: str, discovered: int, read: int) -> None:
        pass

    def processing_total(self, total: int) -> None:
        pass

    def processing_done(self, done: int) -> None:
        pass

    def stage(self, name: str) -> None:
        pass

    def cancelled(self) -> bool:
        return False


class JobReporter(NullReporter):
    """Reports to one registered job. Once cancelled, every report is dropped."""

    def __init__(self, token: str) -> None:
        self.token = token
        self._total = 0
        self._done_by_feed: dict[str, int] = {}
        self._feed = ""

    def set_feed(self, feed: str) -> None:
        self._feed = feed
        self._done_by_feed.setdefault(feed, 0)

    def _done(self) -> int:
        return sum(self._done_by_feed.values())

    def _call(self, fn: Callable[..., Any], *args, **kw) -> None:
        if self.cancelled():
            return
        fn(self.token, *args, **kw)

    def feed_started(self, feed: str) -> None:
        from . import job_progress
        self.set_feed(feed)
        self._call(job_progress.feed_started, feed)

    def feed_progress(self, feed: str, discovered: int, read: int) -> None:
        from . import job_progress
        self._call(job_progress.feed_progress, feed, discovered=discovered, read=read)

    def feed_finished(self, feed: str, discovered: int, read: int) -> None:
        from . import job_progress
        self._call(job_progress.feed_finished, feed, discovered=discovered, read=read)

    def processing_total(self, total: int) -> None:
        from . import job_progress
        self._total += max(0, int(total))
        self._call(job_progress.processing_total, self._total, done=self._done())

    def processing_done(self, done: int) -> None:
        from . import job_progress
        # A feed reports its own running total for its queue, so take the
        # latest rather than adding, or the job count would double-count.
        self._done_by_feed[self._feed] = max(0, int(done))
        self._call(job_progress.processing_done, self._done())

    def stage(self, name: str) -> None:
        from . import job_progress
        self._call(job_progress.stage, name)

    def cancelled(self) -> bool:
        from . import job_progress
        return bool(self.token) and job_progress.is_cancelled(self.token)


def feed_callbacks(reporter, feed: str):
    """(on_download, on_classify) for one feed's fetch_latest."""
    def on_download(discovered: int, read: int) -> None:
        reporter.feed_progress(feed, discovered, read)

    def on_classify(total: int, done: int) -> None:
        reporter.set_feed(feed)
        if done == 0:
            reporter.processing_total(total)
        else:
            reporter.processing_done(done)

    return on_download, on_classify


def finalize_feed(reporter, feed: str, out: dict | None) -> None:
    """After a feed returns: record what it read, or that it was skipped."""
    if out is None:
        return
    read = int(out.get("fetched") or 0)
    reporter.feed_finished(feed, read, read)


def run_reading(cur, sources, reporter) -> dict:
    """Download every ready feed into memory, reporting progress per feed.

    `sources` is an ordered list of (feed name, fetch callable). Each callable
    receives (on_download, on_classify). Returns {feed: result or None}.
    """
    out: dict[str, Any] = {}
    for feed, fetch in sources:
        if reporter.cancelled():
            break
        reporter.feed_started(feed)
        on_download, on_classify = feed_callbacks(reporter, feed)
        result = fetch(on_download, on_classify)
        out[feed] = result
        finalize_feed(reporter, feed, result)
    return out
