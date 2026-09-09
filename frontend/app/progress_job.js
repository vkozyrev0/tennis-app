// Cancellable batch-mail progress dialog. Tracker is DOM-free so node tests
// can drive open / label / Cancel / abort without AG Grid or a mailbox.

export function jobLabel({ phase, current, total, elapsedSec } = {}) {
  const p = String(phase || "Working").trim() || "Working";
  const c = Number(current);
  const t = Number(total);
  let base = p;
  if (Number.isFinite(c) && Number.isFinite(t) && t > 0) {
    base = `${p} — ${Math.max(0, c)} of ${t}`;
  }
  const sec = Number(elapsedSec);
  if (Number.isFinite(sec) && sec >= 1) {
    base += ` · ${Math.floor(sec)}s`;
  }
  return base;
}

export function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  return /abort|cancel/i.test(String(err.message || err));
}

export function createJobTracker() {
  let state = {
    open: false, cancelled: false, phase: "", current: 0, total: 0,
    elapsedSec: 0, label: "",
  };
  let ac = null;

  function snapshot() {
    const indeterminate = !(Number(state.total) > 0);
    return {
      ...state,
      indeterminate,
      label: state.cancelled ? "Cancelled" : jobLabel(state),
    };
  }

  function open(phase, { total = 0, current = 0 } = {}) {
    ac = typeof AbortController === "function" ? new AbortController() : null;
    state = {
      open: true,
      cancelled: false,
      phase: phase || "Working",
      current: Number(current) || 0,
      total: Number(total) || 0,
      elapsedSec: 0,
      label: "",
    };
    state.label = jobLabel(state);
    return snapshot();
  }

  function update(patch = {}) {
    if (!state.open || state.cancelled) return snapshot();
    if (patch.phase != null) state.phase = patch.phase;
    if (patch.current != null) state.current = Number(patch.current) || 0;
    if (patch.total != null) state.total = Number(patch.total) || 0;
    if (patch.elapsedSec != null) state.elapsedSec = Number(patch.elapsedSec) || 0;
    state.label = jobLabel(state);
    return snapshot();
  }

  function cancel() {
    if (!state.open && !ac) return snapshot();
    state.cancelled = true;
    state.open = false;
    state.phase = "Cancelled";
    state.label = "Cancelled";
    try { if (ac && !ac.signal.aborted) ac.abort(); } catch (_) {}
    return snapshot();
  }

  function finish() {
    state.open = false;
    return snapshot();
  }

  function signal() {
    return ac ? ac.signal : undefined;
  }

  return { open, update, cancel, finish, signal, snapshot };
}

/** Tick elapsed time (and optional rotating phases) while a job is open. */
export function startJobPulse(tracker, { intervalMs = 400, phases = null, onTick } = {}) {
  const t0 = Date.now();
  let i = 0;
  const list = Array.isArray(phases) && phases.length ? phases : null;
  const id = setInterval(() => {
    const s = tracker.snapshot();
    if (!s.open || s.cancelled) {
      clearInterval(id);
      return;
    }
    const patch = { elapsedSec: (Date.now() - t0) / 1000 };
    if (list) {
      patch.phase = list[i % list.length];
      i += 1;
    }
    const next = tracker.update(patch);
    if (typeof onTick === "function") onTick(next);
  }, intervalMs);
  return () => clearInterval(id);
}

/**
 * Run `fn` while the tracker is open. Cancel / AbortError complete as
 * `{ cancelled: true }` instead of a successful full run.
 */
export async function runTrackedJob(tracker, opts, fn) {
  const phase = (opts && (opts.phase || opts.title)) || "Working";
  tracker.open(phase, opts || {});
  const stopPulse = startJobPulse(tracker, {
    intervalMs: (opts && opts.pulseMs) || 400,
    phases: (opts && opts.phases) || null,
    onTick: (s) => { if (opts && typeof opts.onPulse === "function") opts.onPulse(s); },
  });
  try {
    const result = await fn({
      signal: tracker.signal(),
      update: (p) => tracker.update(p),
      snapshot: () => tracker.snapshot(),
    });
    if (tracker.snapshot().cancelled) {
      return { ok: false, cancelled: true, result: null };
    }
    tracker.finish();
    return { ok: true, cancelled: false, result };
  } catch (err) {
    const cancelled = tracker.snapshot().cancelled || isAbortError(err);
    tracker.finish();
    if (cancelled) return { ok: false, cancelled: true, error: err };
    throw err;
  } finally {
    stopPulse();
  }
}

/**
 * Bind the tracker to #job-progress-modal. Cancel / Escape abort the job.
 */
export function createProgressModal() {
  const tracker = createJobTracker();
  const modal = document.getElementById("job-progress-modal");
  const titleEl = document.getElementById("job-progress-title");
  const labelEl = document.getElementById("job-progress-label");
  const barEl = document.getElementById("job-progress-bar");
  const cancelBtn = document.getElementById("job-progress-cancel");

  function render() {
    const s = tracker.snapshot();
    if (titleEl && s.phase && s.open) titleEl.textContent = s.phase;
    if (labelEl) labelEl.textContent = s.open ? s.label : (s.cancelled ? "Cancelled" : "");
    if (barEl) {
      if (s.open && s.indeterminate) {
        barEl.removeAttribute("value");
        barEl.max = 1;
        barEl.setAttribute("data-busy", "1");
      } else {
        barEl.removeAttribute("data-busy");
        barEl.max = s.total > 0 ? s.total : 1;
        barEl.value = s.total > 0 ? s.current : 1;
      }
    }
    if (modal) modal.hidden = !s.open;
  }

  function onCancel() { tracker.cancel(); render(); }
  if (cancelBtn) cancelBtn.addEventListener("click", onCancel);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) onCancel();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && tracker.snapshot().open) {
      e.preventDefault();
      onCancel();
    }
  });

  async function run(title, opts, fn) {
    const o = {
      ...(opts || {}),
      phase: (opts && opts.phase) || title || "Working",
      onPulse: render,
    };
    if (titleEl) titleEl.textContent = title || o.phase;
    const out = await runTrackedJob(tracker, o, async (job) => {
      render();
      return fn({
        signal: job.signal,
        update: (p) => { job.update(p); render(); },
        snapshot: job.snapshot,
      });
    });
    render();
    return out;
  }

  return { run, tracker, render };
}
