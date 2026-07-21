// Day-of venue view — one calendar day ops (D11 slice from app.js).
// Backend: /api/tournaments/{id}/day-of, assignment-days status, coverage-fill, incidents.

/**
 * @returns {{ loadDayOf: () => Promise<void>, resetStickyDate: () => void }}
 */
export function createDayOfPanel(ctx) {
  const {
    api, toast, setMsg, html, hstr, raw, fmtMDY, certLabel, respChip,
    getActive, getCertPairs,
  } = ctx;
  void setMsg;

  // ============================== Day-of mode ==============================
  // Venue view for ONE calendar day (defaults to today). State is just the
  // focused date + a name filter; every render re-fetches /day-of and repaints
  // the #dayof-* containers. Mutations reuse the existing per-day-status /
  // incident / coverage-fill endpoints, then reload. Controls are big-touch
  // (≥44px) for tablet use on-site. One delegated click/submit/input handler is
  // wired once (guarded by _dayofWired) so re-renders don't stack listeners.
  const _DAYOF = { date: null, search: "" };
  let _dayofWired = false;
  // LOCAL calendar date (not UTC) — a TD opening the venue view at 6pm Pacific
  // must see today, not tomorrow's UTC date. (toISOString would shift across the
  // UTC boundary in either direction depending on the offset's sign.)
  function _isoLocal(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function _todayIso() { return _isoLocal(new Date()); }
  function _shiftIso(iso, days) {
    const d = new Date(iso + "T00:00:00");   // local midnight
    d.setDate(d.getDate() + days);
    return _isoLocal(d);                       // format local — no UTC round-trip
  }

  function _dayOfDefaultDate(tournament) {
    // Prefer today when the event is live; otherwise open on play_start so the
    // TD doesn't land on an empty "outside play window" day with every site red
    // (walkthrough 2026-07-19: Macon 7/9–7/12 opened as empty on 7/19).
    const today = _todayIso();
    if (!tournament) return today;
    const start = tournament.play_start_date;
    const end = tournament.play_end_date;
    if (start && end && today >= start && today <= end) return today;
    return start || today;
  }

  async function loadDayOf() {
    if (!getActive()) return;
    if (!_DAYOF.date) _DAYOF.date = _dayOfDefaultDate(getActive());
    _wireDayOf();
    let d;
    try { d = await api(`/tournaments/${getActive().id}/day-of?on=${_DAYOF.date}`); }
    catch (e) { toast("Couldn't load the day-of view: " + e.message, false); return; }
    // If we still landed outside the window (e.g. sticky date from another
    // tournament) and the API reports play dates, snap once to play_start.
    if (!d.in_window && d.play_start_date && _DAYOF.date !== d.play_start_date
        && !(_DAYOF.date >= d.play_start_date && _DAYOF.date <= d.play_end_date)) {
      _DAYOF.date = d.play_start_date;
      try { d = await api(`/tournaments/${getActive().id}/day-of?on=${_DAYOF.date}`); }
      catch (e) { toast("Couldn't load the day-of view: " + e.message, false); return; }
    }
    _dayofData = d;
    try {
      _renderDayOfHead(d);
      _renderDayOfSummary(d);
      _renderDayOfCoverage(d);
      _renderDayOfOfficials(d);
      _renderDayOfIncidents(d);
    } catch (e) { toast("Couldn't render the day-of view: " + e.message, false); }
  }
  let _dayofData = null;

  function _renderDayOfHead(d) {
    const isToday = d.date === _todayIso();
    const windowNote = d.in_window
      ? '<span class="badge badge-ok">during play</span>'
      : '<span class="badge badge-muted">outside play window</span>';
    document.getElementById("dayof-head").innerHTML = hstr`
      <div class="dayof-datebar">
        <button type="button" class="dayof-step touch-btn" data-step="-1" aria-label="Previous day">◀</button>
        <div class="dayof-dateline">
          <strong>${raw(fmtMDY(d.date))}</strong>
          ${isToday ? raw('<span class="badge badge-info">today</span>') : ""} ${raw(windowNote)}
        </div>
        <button type="button" class="dayof-step touch-btn" data-step="1" aria-label="Next day">▶</button>
        ${isToday ? "" : raw('<button type="button" class="dayof-today btn-small">Jump to today</button>')}
        ${(!d.in_window && d.play_start_date) ? raw(`<button type="button" class="dayof-playstart btn-small" data-date="${d.play_start_date}">Jump to play start</button>`) : ""}
      </div>`;
  }

  function _renderDayOfSummary(d) {
    const r = d.rooms, si = d.signin;
    const stat = (label, val, cls) =>
      hstr`<div class="dayof-stat ${cls || ""}"><span class="dayof-stat-n">${val}</span><span class="dayof-stat-l">${label}</span></div>`;
    document.getElementById("dayof-summary").innerHTML =
      stat("working", d.officials_count) +
      stat("checked in", d.present_count, d.present_count ? "ok" : "") +
      stat("sites covered", d.sites.length - d.uncovered_sites.length + "/" + d.sites.length,
           d.uncovered_sites.length ? "warn" : "ok") +
      stat("rooms used", r.assigned + "/" + r.reserved) +
      stat("players signed in", si.signed_in + "/" + si.selected);
  }

  function _renderDayOfCoverage(d) {
    const box = document.getElementById("dayof-coverage");
    const gaps = d.uncovered_sites.length
      ? hstr`<div class="dayof-gaps"><span class="dayof-gaps-l">No official today at:</span> ${
          d.uncovered_sites.map((s) => html`<span class="badge badge-warn">${s.site_label}</span>`)}</div>`
      : (d.sites.length ? '<div class="dayof-gaps ok">✓ every site has an official today</div>' : "");
    // Quick-assign: pick a role, find certified officials free that day, one tap
    // to fill. Reuses /coverage-candidates + /coverage-fill.
    const roleOpts = getCertPairs().map(([v, l]) => hstr`<option value="${v}">${l}</option>`).join("");
    box.innerHTML = gaps + hstr`
      <details class="dayof-qa">
        <summary>＋ Quick-assign an official for ${raw(fmtMDY(d.date))}</summary>
        <div class="dayof-qa-body">
          <label>Role <select class="dayof-qa-role">${raw(roleOpts)}</select></label>
          <button type="button" class="dayof-qa-go btn-small">Find available officials</button>
          <div class="dayof-qa-results" aria-live="polite"></div>
        </div>
      </details>`;
  }

  function _renderDayOfOfficials(d) {
    const box = document.getElementById("dayof-officials");
    const q = _DAYOF.search.trim().toLowerCase();
    const shown = q ? d.officials.filter((o) => o.official_name.toLowerCase().includes(q)) : d.officials;
    const card = (o) => {
      const present = o.actual_status === "worked";
      const noshow = o.actual_status === "no_show";
      return hstr`
        <div class="dayof-off">
          <div class="dayof-off-main">
            <div class="dayof-off-name">${o.official_name}</div>
            <div class="dayof-off-meta">${certLabel(o.working_as)} · ${o.site_label || "no site"} ${raw(respChip(o.response_status))}${
              noshow ? raw(' <span class="badge badge-bad">no-show</span>') : ""}${
              o.actual_status === "early_departure" ? raw(' <span class="badge badge-warn">left early</span>') : ""}</div>
          </div>
          <div class="dayof-off-actions">
            <button type="button" class="touch-btn dayof-present${present ? " on" : ""}" data-day="${o.day_id}" data-status="worked">✓ Present</button>
            <button type="button" class="touch-btn dayof-noshow${noshow ? " on" : ""}" data-day="${o.day_id}" data-status="no_show">✗ No-show</button>
          </div>
        </div>`;
    };
    const list = shown.length
      ? shown.map(card).join("")
      : (d.officials.length ? '<p class="muted">No official matches the search.</p>'
                            : '<p class="muted">No officials are scheduled to work this day.</p>');
    box.innerHTML = hstr`<h3>Officials working <span class="muted">(${d.officials_count})</span></h3>
      <input type="search" class="dayof-search" placeholder="🔍 filter by name…" value="${_DAYOF.search}" aria-label="Filter officials by name" />
      <div class="dayof-off-list">${raw(list)}</div>`;
  }

  function _renderDayOfIncidents(d) {
    const box = document.getElementById("dayof-incidents");
    const sev = { info: "muted", minor: "warn", major: "bad" };
    const row = (i) => hstr`
      <div class="dayof-inc">
        <span class="badge badge-${sev[i.severity] || "muted"}">${i.severity}</span>
        <div class="dayof-inc-body">
          <div class="dayof-inc-desc">${i.description}</div>
          <div class="dayof-inc-meta">${i.category}${i.site_label ? " · " + i.site_label : ""} · ${
            raw(new Date(i.occurred_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}${
            i.resolved ? raw(' · <span class="badge badge-ok">resolved</span>') : ""}</div>
        </div>
      </div>`;
    const list = d.incidents.length ? d.incidents.map(row).join("")
      : '<p class="muted">No incidents logged this day.</p>';
    box.innerHTML = hstr`<h3>Incidents <span class="muted">(${d.incidents.length})</span></h3>
      <form class="dayof-inc-form" autocomplete="off">
        <div class="row">
          <label>Severity <select name="severity">
            <option value="info">Info</option><option value="minor">Minor</option><option value="major">Major</option>
          </select></label>
          <label>Category <select name="category">
            <option value="weather">Weather</option><option value="injury">Injury</option>
            <option value="dispute">Dispute</option><option value="facility">Facility</option>
            <option value="conduct">Conduct</option><option value="other" selected>Other</option>
          </select></label>
        </div>
        <label class="dayof-inc-what">What happened
          <input name="description" required maxlength="2000" placeholder="e.g. Rain delay courts 1–3, play suspended 13:05" />
        </label>
        <div class="actions-row"><button type="submit" class="touch-btn">Log incident</button><span class="msg dayof-inc-msg"></span></div>
      </form>
      <div class="dayof-inc-list">${raw(list)}</div>`;
  }

  // One delegated handler set, wired once. Covers the date stepper, check-in
  // toggles, quick-assign, the name filter, and the incident quick-log form.
  function _wireDayOf() {
    if (_dayofWired) return;
    _dayofWired = true;
    const panel = document.getElementById("panel-t-dayof");

    panel.addEventListener("click", async (e) => {
      const step = e.target.closest(".dayof-step");
      if (step) { _DAYOF.date = _shiftIso(_DAYOF.date, Number(step.dataset.step)); loadDayOf(); return; }
      const playStart = e.target.closest(".dayof-playstart");
      if (playStart && playStart.dataset.date) {
        _DAYOF.date = playStart.dataset.date;
        loadDayOf();
        return;
      }
      if (e.target.closest(".dayof-today")) { _DAYOF.date = _todayIso(); loadDayOf(); return; }

      const chk = e.target.closest(".dayof-present, .dayof-noshow");
      if (chk) {
        const dayId = chk.dataset.day;
        // Toggle: tapping the already-active state clears back to "planned".
        const target = chk.classList.contains("on") ? "planned" : chk.dataset.status;
        try {
          await api(`/assignment-days/${dayId}/status`, { method: "PUT", body: JSON.stringify({ actual_status: target }) });
          loadDayOf();
        } catch (err) { toast("Couldn't update check-in: " + err.message, false); }
        return;
      }

      if (e.target.closest(".dayof-qa-go")) {
        const details = e.target.closest(".dayof-qa");
        const role = details.querySelector(".dayof-qa-role").value;
        const results = details.querySelector(".dayof-qa-results");
        results.textContent = "Looking…";
        try {
          const cands = await api(`/tournaments/${getActive().id}/coverage-candidates?role=${encodeURIComponent(role)}&date=${_DAYOF.date}`);
          if (!cands.length) { results.innerHTML = '<p class="muted">No certified official is free that day.</p>'; return; }
          results.innerHTML = hstr`${cands.slice(0, 12).map((c) => html`
            <button type="button" class="touch-btn dayof-qa-cand" data-oid="${c.official_id}" data-role="${role}">
              ${c.official_name}${c.available ? raw(' <span class="badge badge-ok">available</span>') : ""}${
              c.busy_elsewhere ? raw(' <span class="badge badge-warn">busy elsewhere</span>') : ""}${
              c.assigned_here ? raw(' <span class="badge badge-info">on roster</span>') : ""}
            </button>`)}`;
        } catch (err) { results.textContent = "Error: " + err.message; }
        return;
      }

      const cand = e.target.closest(".dayof-qa-cand");
      if (cand) {
        try {
          await api(`/tournaments/${getActive().id}/coverage-fill`, { method: "POST",
            body: JSON.stringify({ official_id: Number(cand.dataset.oid), work_date: _DAYOF.date, working_as: cand.dataset.role }) });
          toast("Assigned for " + fmtMDY(_DAYOF.date), true);
          loadDayOf();
        } catch (err) { toast("Couldn't assign: " + err.message, false); }
        return;
      }
    });

    // Name filter — re-render the officials column only (keep focus in the box).
    panel.addEventListener("input", (e) => {
      if (!e.target.classList.contains("dayof-search")) return;
      _DAYOF.search = e.target.value;
      if (_dayofData) {
        _renderDayOfOfficials(_dayofData);
        const s = document.querySelector("#panel-t-dayof .dayof-search");
        if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
      }
    });

    panel.addEventListener("submit", async (e) => {
      const form = e.target.closest(".dayof-inc-form");
      if (!form) return;
      e.preventDefault();
      const msg = form.querySelector(".dayof-inc-msg");
      const body = {
        severity: form.severity.value, category: form.category.value,
        description: form.description.value.trim(),
      };
      if (!body.description) { msg.textContent = "describe what happened"; return; }
      try {
        await api(`/tournaments/${getActive().id}/incidents`, { method: "POST", body: JSON.stringify(body) });
        form.reset();
        loadDayOf();
      } catch (err) { msg.textContent = err.message; }
    });
  }


  function resetStickyDate() { _DAYOF.date = null; }

  return { loadDayOf, resetStickyDate };
}
