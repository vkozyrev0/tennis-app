// Overlay progress for one mail job. Pure: no DOM, no fetch.
//
// A job is the phases it runs, in order, and each phase counts work in its own
// units (files, emails). progressFor renders the overlay and describeFetch
// and countsFor render the status line, so both paths share one source.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function phaseList(phases) {
  return (Array.isArray(phases) ? phases : []).map((p, i) => ({
    key: String((p && p.key) || i),
    label: String((p && p.label) || "Working"),
    total: num(p && p.total),
    done: num(p && p.done),
  }));
}

const unknown = (label) => ({ phase: label, current: 0, total: 0, label, determined: false });

// The job's count is every phase's count added up. An uncounted phase adds
// nothing, so its end never moves a later phase's fraction backwards.
function countedAfter(list, idx) {
  return list.slice(idx + 1).reduce((n, p) => n + p.total, 0);
}

function completedBefore(list, idx) {
  return list.slice(0, idx).reduce((n, p) => n + p.total, 0);
}

/**
 * { phase, current, total, label, determined } for the overlay bar.
 *
 * A counted phase reports `innerDone` of its own `total` against the job's
 * whole count. An uncounted phase has no count of its own, so it is
 * indeterminate (total 0) unless later phases have counts, in which case it
 * shows what is already finished. Zero total means indeterminate.
 */
export function progressFor(phases, currentKey, innerDone = 0) {
  const list = phaseList(phases);
  if (!list.length) return unknown("Working");
  const idx = list.findIndex((p) => p.key === currentKey);
  if (idx < 0) return unknown(list[0].label);
  const { label, total } = list[idx];
  const after = countedAfter(list, idx);
  if (total > 0) {
    const done = completedBefore(list, idx);
    const inner = Math.max(num(innerDone), list[idx].done);
    return {
      phase: label,
      current: done + Math.min(inner, total),
      total: done + total + after,
      label,
      determined: true,
    };
  }
  return after > 0 ? { phase: label, current: 0, total: after, label, determined: true } : unknown(label);
}

/**
 * The overlay's bar and label for phase `key`. phaseView names the phase's
 * position while it has no count of its own. A phase with no count anywhere
 * in the job reads full once it has finished.
 */
export function phaseView(phases, key, innerDone = 0) {
  const list = phaseList(phases);
  const idx = list.findIndex((p) => p.key === key);
  if (idx < 0 || list[idx].total > 0) return progressFor(list, key, innerDone);
  const view = progressFor(list, key, innerDone);
  if (list.length === 1) {
    const label = list[0].label;
    const finished = view.total === 0 && num(innerDone) > 0;
    return finished ? { phase: label, current: 1, total: 1, label, determined: true } : view;
  }
  const phase = `${list[idx].label} (phase ${idx + 1} of ${list.length})`;
  return { ...view, phase, label: phase };
}

/**
 * `{ current, total, label }` once phase `key` is fully done. It reads full
 * only when nothing with a count follows it.
 */
export function completedView(phases, key) {
  const list = phaseList(phases);
  const idx = list.findIndex((p) => p.key === key);
  if (idx < 0) return progressFor(list, key);
  return progressFor(list, key, list[idx].total);
}

function feedCounts(raw) {
  if (!raw || Number(raw.downloaded) <= 0) return null;
  return {
    downloaded: num(raw.downloaded),
    imported: num(raw.imported),
    duplicates: num(raw.duplicates),
  };
}

/**
 * Phase list for Get mails. `fetched` is the server's `progress` object, or
 * null before the response. Its `total` is then 0 (unknown), and after the
 * response it is what both feeds downloaded: the server classifies each of
 * those mails inside the same request, so that count is the whole job.
 *
 * `finished` marks the job done, so a run that downloaded nothing reads as
 * complete instead of leaving the bar pulsing.
 */
export function mailFetchPhases(fetched, { finished = false } = {}) {
  const gmail = feedCounts(fetched && fetched.gmail);
  const outlook = feedCounts(fetched && fetched.outlook);
  const downloaded = (gmail ? gmail.downloaded : 0) + (outlook ? outlook.downloaded : 0);
  if (finished && downloaded === 0) {
    return [{ key: "download", label: "Loading mail from Gmail and Outlook", total: 1, done: 1 }];
  }
  return [{ key: "download", label: "Loading mail from Gmail and Outlook", total: downloaded }];
}

/**
 * `{ feed: { downloaded, imported, duplicates, label } }` for the status
 * line, one entry per feed that downloaded mail. A skipped feed is left out.
 */
export function countsFor(fetched) {
  const out = {};
  for (const [feed, name] of [["gmail", "Gmail"], ["outlook", "Outlook"]]) {
    const c = feedCounts(fetched && fetched[feed]);
    if (c) out[feed] = { ...c, label: `${name} ${c.downloaded} downloaded` };
  }
  return out;
}

/** Status-line summary of the fetched counts, every feed it includes. */
export function describeFetch(fetched) {
  const counts = countsFor(fetched);
  const feeds = Object.keys(counts);
  if (!feeds.length) return "no new mail downloaded";
  const figures = (key) => `${counts[key].downloaded} downloaded, `
    + `${counts[key].imported} imported, `
    + `${counts[key].duplicates} ${counts[key].duplicates === 1 ? "duplicate" : "duplicates"}`;
  const downloaded = feeds.reduce((n, k) => n + counts[k].downloaded, 0);
  if (feeds.length === 1) return `download: ${figures(feeds[0])}`;
  const perFeed = feeds.map((k) => `${counts[k].label.split(" ")[0]}: ${figures(k)}`).join("; ");
  return `download: ${downloaded} downloaded (${perFeed})`;
}

function feedLabel(feed) {
  if (feed === "gmail") return "Gmail";
  if (feed === "outlook") return "Outlook";
  return "Mailbox";
}

/**
 * The two bars for a running mail job. Reading ends when the mailboxes have
 * been downloaded; processing then runs over the batch. A stage that has not
 * started is indeterminate, not empty, so the overlay never shows a second bar
 * at zero before there is anything to count.
 *
 * `job` is the server's job snapshot (see `job_progress.snapshot`). A missing
 * field reads as "not known yet", never as a completed stage.
 */
export function jobBars(job) {
  if (!job) {
    return { reading: unknown("Reading mail"), processing: unknown("Processing mail") };
  }
  const reading = job.reading || {};
  const feeds = reading.feeds || {};
  const names = Object.keys(feeds).filter((f) => f !== "all");
  const discovered = num(reading.discovered);
  const read = num(reading.read);
  const readingLabel = names.length === 1
    ? `Reading ${feedLabel(names[0])}`
    : "Reading mail";
  const readingView = discovered > 0
    ? { phase: readingLabel, current: Math.min(read, discovered), total: discovered,
        label: readingLabel, determined: true }
    : unknown(readingLabel);

  const proc = job.processing || {};
  const total = num(proc.total);
  const done = num(proc.done);
  const processingView = total > 0
    ? { phase: "Processing mail", current: Math.min(done, total), total,
        label: "Processing mail", determined: true }
    : unknown("Processing mail");

  const started = job.stage === "processing";
  // Before processing begins the second bar has no count of its own and says so.
  const processing = !started && job.state === "running"
    ? unknown("Waiting for mail")
    : processingView;
  return { reading: readingView, processing, state: job.state, stage: job.stage };
}

/** The reading bar's numbers from a job, or null when it has none yet. */
export function readOnlyBars(job) {
  const bars = jobBars(job);
  return { reading: bars.reading };
}

/** Milliseconds between polls for a running job. */
export function pollDelayMs(state) {
  if (state === "running") return 400;
  return 0;
}
