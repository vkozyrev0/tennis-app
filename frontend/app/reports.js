// Reports panel — staffing plan, coverage, conflicts, exports (D11).
import { datesInRange as datesInRangeUtil } from "./util.js";

export function createReportsPanel(ctx) {
  const {
    api, setMsg, toast, confirmDialog, markInvalid,
    html, hstr, raw, esc, money, fmtDOW, fmtMDY, dowLong, certLabel, officialLabel,
    printDoc, csvDownload, getActive, getOfficialsById, getSitesById,
    datesInRange: datesInRangeFn,
  } = ctx;
  const datesInRange = datesInRangeFn || datesInRangeUtil;
  void setMsg; void confirmDialog; void markInvalid; void getOfficialsById; void getSitesById;

  // --- Reports (officials confirmation + pay/mileage) ---
  let reportData = null;
  // money() imported from ./app/ui.js (D11)

  // Minimum officials/day the TD wants — a day/site below it (but >0) is flagged
  // "thin" (amber); zero stays a hard gap (red). Persisted so it survives reloads.
  let _coverageMin = Math.max(0, parseInt(localStorage.getItem("courtops.coverageMin"), 10) || 1);
  // Cell class for a coverage count given the threshold: red at 0, amber if below
  // the minimum, plain otherwise.
  function _covClass(n) { return n === 0 ? "warn" : (n < _coverageMin ? "cov-thin" : ""); }
  // Renders the per-day footer row, the per-site grid, and the coverage note from
  // reportData + the current threshold (no refetch — used on threshold change).
  function _renderCoverage() {
    if (!reportData) return;
    const cols = _reportColumns(reportData.tournament);
    const covByDate = {};
    for (const c of (reportData.coverage || [])) covByDate[c.date] = c.officials;
    const covCells = cols.map((c) => {
      const n = covByDate[c.date] ?? 0;
      const cls = _covClass(n);
      return `<th class="daycol${cls ? " " + cls : ""}">${n}</th>`;
    }).join("");
    document.getElementById("report-coverage").innerHTML =
      `<th colspan="6">Officials per day</th>${covCells}<th></th><th></th><th></th>`;
    // Note: zero-coverage days (hard gap) + below-minimum days (thin), separately.
    const covNote = document.getElementById("report-coverage-note");
    const uncovered = reportData.uncovered_days || [];
    const thin = (reportData.coverage || [])
      .filter((c) => c.officials > 0 && c.officials < _coverageMin)
      .map((c) => c.date);
    const bits = [];
    if (uncovered.length) bits.push(hstr`<strong>${uncovered.length} day(s) with no official</strong>: ${uncovered.map((d) => fmtDOW(d)).join(", ")}`);
    if (thin.length) bits.push(hstr`${thin.length} day(s) below the ${_coverageMin}-official minimum: ${thin.map((d) => fmtDOW(d)).join(", ")}`);
    if (bits.length) { covNote.hidden = false; covNote.innerHTML = "⚠ " + bits.join(" · ") + " — fill before the event."; }
    else { covNote.hidden = true; covNote.textContent = ""; }

    const siteCov = reportData.site_coverage || [];
    document.querySelector("#site-coverage-table thead").innerHTML =
      html`<tr><th>Site</th>${cols.map((c) => html`<th class="daycol">${c.head}</th>`)}</tr>`;
    const scBody = document.querySelector("#site-coverage-table tbody");
    scBody.innerHTML = siteCov.length
      ? html`${siteCov.map((s) => {
          const cells = s.by_date.map((b) => {
            const cls = _covClass(b.officials);
            return hstr`<td class="daycol${cls ? " " + cls : ""}">${b.officials}</td>`;
          }).join("");
          return html`<tr><td>${s.site_label}</td>${raw(cells)}</tr>`;
        })}`
      : html`<tr><td class="empty" colspan="${cols.length + 1}">No sites linked to this tournament.</td></tr>`;

    // Per-role coverage grid: rows = roles used, columns = days, cell = officials
    // working that role that day (same zero/thin highlighting as the others).
    // Conditional attribute fragments (flag/attrs) are built with hstr`` (which
    // auto-escapes + returns a string) and raw()'d into the cell, so they compose
    // without re-escaping — the documented attribute-fragment technique.
    const roleCov = reportData.role_coverage || [];
    document.querySelector("#role-coverage-table thead").innerHTML =
      html`<tr><th>Role</th>${cols.map((c) => html`<th class="daycol">${c.head}</th>`)}</tr>`;
    const rcBody = document.querySelector("#role-coverage-table tbody");
    rcBody.innerHTML = roleCov.length
      ? html`${roleCov.map((r) => {
          const holders = r.holders || 0;
          const cells = r.by_date.map((b) => {
            const n = b.officials;
            const cls = _covClass(n);
            // Cert-pool gap: a day undercovered for this role while MORE certified
            // officials are available is a *fixable* gap — flag it with a ⚑ and make
            // the cell clickable to pick a certified official and fill it on the spot.
            const below = n === 0 || n < _coverageMin;
            const fixable = below && holders > n;
            const flag = fixable
              ? hstr` <span class="cov-flag" title="${`${n} staffed, ${holders} certified available — click to fill`}">⚑</span>` : "";
            const attrs = fixable ? hstr` data-cov-role="${r.role}" data-cov-date="${b.date}"` : "";
            return hstr`<td class="daycol${cls ? " " + cls : ""}${fixable ? " cov-fixable" : ""}"${raw(attrs)} title="${`${n} staffed · ${holders} certified${fixable ? " — click to fill" : ""}`}">${n}${raw(flag)}</td>`;
          }).join("");
          return html`<tr><td>${certLabel(r.role)} <span class="muted">(${holders} certified)</span></td>${raw(cells)}</tr>`;
        })}`
      : html`<tr><td class="empty" colspan="${cols.length + 1}">No officials assigned yet.</td></tr>`;
  }

  // Coverage gap → invite: clicking a fixable role/day cell opens a popover of
  // certified officials who could fill it, each with a one-click "Fill" that
  // assigns them (if needed) + adds the day in the right role, then refreshes.
  let _covPop = null;
  function _closeCovPop() { if (_covPop) { _covPop.remove(); _covPop = null; } }
  document.addEventListener("click", (e) => {
    const cell = e.target.closest && e.target.closest("#role-coverage-table .cov-fixable");
    if (!cell) { if (!e.target.closest || !e.target.closest(".cov-pop")) _closeCovPop(); return; }
    _openCovGap(cell);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") _closeCovPop(); });

  async function _openCovGap(cell) {
    _closeCovPop();
    if (!getActive()) return;
    const role = cell.dataset.covRole, date = cell.dataset.covDate;
    const pop = document.createElement("div");
    pop.className = "cov-pop";
    pop.innerHTML = hstr`<div class="cov-pop-head">${certLabel(role)} · ${fmtDOW(date)}</div><p class="muted">Loading…</p>`;
    document.body.appendChild(pop);
    _covPop = pop;
    // Anchor below the cell, clamped to the viewport.
    const r = cell.getBoundingClientRect();
    pop.style.top = `${window.scrollY + r.bottom + 4}px`;
    pop.style.left = `${window.scrollX + Math.min(r.left, window.innerWidth - 300)}px`;
    let cands;
    try {
      cands = await api(`/tournaments/${getActive().id}/coverage-candidates?role=${encodeURIComponent(role)}&date=${encodeURIComponent(date)}`);
    } catch (err) { pop.innerHTML = hstr`<p class="msg bad">${err.message}</p>`; return; }
    if (_covPop !== pop) return;  // closed while loading
    if (!cands.length) {
      pop.innerHTML = html`<div class="cov-pop-head">${certLabel(role)} · ${fmtDOW(date)}</div><p class="cov-pop-empty">No un-booked official holds this certification. Add a certification or a new official first.</p>`;
      return;
    }
    const tag = (c) => {
      const t = [];
      if (c.available) t.push('<span class="cov-tag cov-tag-ok">available</span>');
      if (c.assigned_here) t.push('<span class="cov-tag">already on event</span>');
      if (c.busy_elsewhere) t.push('<span class="cov-tag cov-tag-warn">busy elsewhere</span>');
      return t.join(" ");
    };
    pop.innerHTML = html`<div class="cov-pop-head">Fill ${certLabel(role)} · ${fmtDOW(date)}</div><ul class="cov-cand-list">${cands.map((c) =>
      html`<li class="cov-cand"><span class="cov-cand-name">${c.official_name} ${raw(tag(c))}</span><button type="button" class="cov-fill-btn" data-oid="${c.official_id}" data-name="${c.official_name}">Fill</button></li>`)}</ul>`;
    pop.querySelectorAll(".cov-fill-btn").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/tournaments/${getActive().id}/coverage-fill`, {
          method: "POST",
          body: JSON.stringify({ official_id: Number(btn.dataset.oid), work_date: date, working_as: role }),
        });
        toast(`Assigned ${btn.dataset.name} as ${certLabel(role)} on ${fmtDOW(date)}`, true);
        _closeCovPop();
        loadReports();
      } catch (err) { toast(err.message, false); btn.disabled = false; }
    }));
  }

  // Staffing-conflict report: one consolidated, grouped list of every clash the
  // TD must resolve (double-bookings, uncertified days, off-availability/off-window
  // days, hotel-date mismatches). Officials link to their 360 for quick triage.
  async function _renderConflicts() {
    const box = document.getElementById("report-conflicts");
    if (!box || !getActive()) return;
    let rep;
    try { rep = await api(`/tournaments/${getActive().id}/conflicts`); }
    catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    if (!rep.counts.total) {
      box.innerHTML = '<p class="conflict-clean">✓ No staffing conflicts — every assignment is clean.</p>';
      return;
    }
    const name = (c) => html`<strong>${c.official_name}</strong>`;
    const groups = [];
    if (rep.double_bookings.length) {
      groups.push(html`<div class="conflict-group"><h5>⛔ Double-booked (${rep.double_bookings.length}${rep.counts.hard_double_bookings ? `, ${rep.counts.hard_double_bookings} impossible` : ""})</h5><ul>${rep.double_bookings.map((c) =>
        html`<li class="${c.different_site ? "conflict-hard" : ""}">${name(c)} on <strong>${fmtDOW(c.work_date)}</strong> — also at ${c.other_tournament || "another event"}${c.other_site ? html` (${c.other_site})` : ""}${c.different_site ? raw(' <span class="conflict-badge">different site — impossible</span>') : raw(' <span class="conflict-badge soft">same/again — verify</span>')}</li>`)}</ul></div>`);
    }
    if (rep.uncertified.length) {
      groups.push(html`<div class="conflict-group"><h5>⚠ Uncertified for the role (${rep.uncertified.length})</h5><ul>${rep.uncertified.map((c) =>
        html`<li>${name(c)} works <strong>${certLabel(c.working_as)}</strong> on ${fmtDOW(c.work_date)} without that certification</li>`)}</ul></div>`);
    }
    if (rep.outside_availability.length) {
      groups.push(html`<div class="conflict-group"><h5>📅 Worked outside declared availability (${rep.outside_availability.length})</h5><ul>${rep.outside_availability.map((c) =>
        html`<li>${name(c)} is assigned <strong>${fmtDOW(c.work_date)}</strong> but didn't declare it available</li>`)}</ul></div>`);
    }
    if (rep.out_of_window.length) {
      groups.push(html`<div class="conflict-group"><h5>🗓 Day outside the play window (${rep.out_of_window.length})</h5><ul>${rep.out_of_window.map((c) => html`<li>${name(c)} has a worked day outside the tournament dates</li>`)}</ul></div>`);
    }
    if (rep.hotel_mismatch.length) {
      groups.push(html`<div class="conflict-group"><h5>🛏 Hotel dates don't cover worked days (${rep.hotel_mismatch.length})</h5><ul>${rep.hotel_mismatch.map((c) => html`<li>${name(c)} works days outside their room-block check-in/out</li>`)}</ul></div>`);
    }
    box.innerHTML = html`<p class="conflict-summary">⚠ ${rep.counts.total} issue(s) to resolve before the event.</p>${groups}`;
  }

  // Day-by-day schedule: one block per play-day listing who works (official, role,
  // site), with a headcount and an empty-day flag — the TD's day-of sheet. Officials
  // link to their 360. Built from the lightweight /schedule aggregate.
  async function _renderSchedule() {
    const box = document.getElementById("report-schedule");
    if (!box || !getActive()) return;
    let d;
    try { d = await api(`/tournaments/${getActive().id}/schedule`); }
    catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    if (!d.days.length) { box.innerHTML = '<p class="muted">No play-date window set.</p>'; return; }
    box.innerHTML = html`${d.days.map((day) => {
      const head = html`<div class="sched-day-head">${fmtDOW(day.date)} <span class="sched-count${day.count === 0 ? " sched-empty" : ""}">${day.count} working</span></div>`;
      if (!day.count) return html`<div class="sched-day">${head}<p class="sched-none">— no officials assigned —</p></div>`;
      const rows = day.entries.map((e) =>
        html`<tr><td>${e.official_name}</td><td>${certLabel(e.working_as)}</td><td>${e.site_label || "—"}</td><td>${raw(respChip(e.response_status))}</td></tr>`);
      return html`<div class="sched-day">${head}<table class="list-table sched-table"><thead><tr><th>Official</th><th>Role</th><th>Site</th><th>Response</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    })}`;
  }

  // Dietary summary: assigned officials grouped by restriction (most common first),
  // each with a count + the names, plus a none-count — a catering-ready rollup.
  async function _renderDietary() {
    const box = document.getElementById("report-dietary");
    if (!box || !getActive()) return;
    let d;
    try { d = await api(`/tournaments/${getActive().id}/dietary-summary`); }
    catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    if (!d.total_people) { box.innerHTML = '<p class="muted">No officials staffed yet.</p>'; return; }
    if (!d.items.length) {
      box.innerHTML = `<p class="muted">No dietary restrictions on file (${d.total_people} official(s) staffed).</p>`;
      return;
    }
    const rows = d.items.map((i) =>
      html`<tr><td><strong>${i.restriction}</strong></td><td class="num">${i.count}</td><td>${i.people.join("; ")}</td></tr>`);
    box.innerHTML = html`<p class="diet-sub">${d.with_restrictions} of ${d.total_people} staffed official(s) have a dietary restriction${d.none_count ? html` · ${d.none_count} none` : ""}.</p><table class="list-table diet-table"><thead><tr><th>Restriction</th><th class="num">Count</th><th>Officials</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Missing distances: official↔site pairs with no mileage on file (mileage stays
  // null). Each row has an inline miles input + Save (POST /distances) so the TD
  // fills them all here; saving refreshes the list.
  async function _renderMissingDistances() {
    const box = document.getElementById("report-missing-dist");
    if (!box || !getActive()) return;
    let d;
    try { d = await api(`/tournaments/${getActive().id}/missing-distances`); }
    catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    if (!d.count) { box.innerHTML = '<p class="muted">✓ Every assigned official has a distance to their site.</p>'; return; }
    const rows = d.items.map((i) =>
      html`<tr data-oid="${i.official_id}" data-sid="${i.site_id}"><td>${i.official_name}</td><td>${i.site_label || "—"}</td><td class="num">${i.days}</td><td><input type="number" class="md-miles" min="0" step="0.1" placeholder="miles" style="width:6rem" /> <button type="button" class="md-save btn-small">Save</button></td></tr>`);
    box.innerHTML = html`<p class="muted md-sub">${d.count} official↔site pair(s) need a one-way distance for mileage.</p><table class="list-table md-table"><thead><tr><th>Official</th><th>Site</th><th class="num">Days</th><th>One-way miles</th></tr></thead><tbody>${rows}</tbody></table>`;
    box.querySelectorAll(".md-save").forEach((btn) => btn.addEventListener("click", async () => {
      const tr = btn.closest("tr");
      const miles = parseFloat(tr.querySelector(".md-miles").value);
      if (!(miles >= 0)) { toast("Enter a valid mileage", false); return; }
      btn.disabled = true;
      try {
        await api("/distances", { method: "POST", body: JSON.stringify({
          official_id: Number(tr.dataset.oid), site_id: Number(tr.dataset.sid),
          one_way_miles: miles, source: "manual" }) });
        toast("Distance saved", true);
        loadReports();  // re-render: the pair clears + mileage recomputes
      } catch (e) { toast(e.message, false); btn.disabled = false; }
    }));
  }

  async function loadReports() {
    if (!getActive()) return;
    reportData = await api(`/tournaments/${getActive().id}/reports/officials`);
    const t = reportData.tournament, totals = reportData.totals;
    const rule = reportData.officials.find((o) => o.rule_version);
    document.getElementById("report-meta").textContent =
      `${t.type} · ${t.play_start_date} → ${t.play_end_date} · ${totals.official_count} official(s)` +
      (rule ? ` · pay rule ${rule.rule_version}` : "");
    // TD "Staffing Plan" layout: flat roster with a weekday X column per play day.
    const cols = _reportColumns(t);
    document.querySelector("#report-table thead").innerHTML =
      "<tr><th>Name</th><th>Position</th><th>Dietary</th><th>Hotel?</th>" +
      "<th>Check-in</th><th>Check-out</th>" +
      cols.map((c) => hstr`<th class="daycol">${c.head}</th>`).join("") +
      '<th class="num">Days</th><th class="num">Pay</th><th class="num">Mileage</th></tr>';
    const tbody = document.querySelector("#report-table tbody");
    tbody.innerHTML = "";
    for (const o of reportData.officials) {
      const worked = new Set(o.days.map((d) => d.work_date));
      const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
      const flags = [
        o.has_conflict ? "double-booked" : "",
        o.missing_distance ? "no distance" : "",
        o.hotel_date_mismatch ? "hotel dates" : "",
        o.work_date_out_of_window ? "off-window day" : "",
        (o.days_outside_availability && o.days_outside_availability.length) ? "not available" : "",
        (o.uncertified_days && o.uncertified_days.length) ? "not certified" : "",
        o.response_status === "declined" ? "DECLINED" : "",
      ].filter(Boolean);
      const warn = flags.length ? hstr` <span class="warn" title="${flags.join(", ")}">⚠</span>` : "";
      const dayCells = cols.map((c) => `<td class="daycol">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
      const tr = document.createElement("tr");
      tr.innerHTML = html`<td>${o.official_name}${raw(warn)}</td><td>${roles}</td><td>${o.dietary_restrictions}</td><td>${o.hotel_name ? "Yes" : "No"}</td><td>${fmtMDY(o.check_in)}</td><td>${fmtMDY(o.check_out)}</td>${raw(dayCells)}<td class="num">${o.days.length}</td><td class="num">${money(o.pay)}</td><td class="num">${money(o.mileage)}</td>`;
      tbody.appendChild(tr);
    }
    const lead = 6 + cols.length;  // columns before the Days/Pay/Mileage trio
    if (reportData.officials.length === 0)
      tbody.innerHTML = `<tr><td class="empty" colspan="${lead + 3}">No officials assigned yet.</td></tr>`;
    const note = (totals.conflict_count ? ` · ${totals.conflict_count} double-booked` : "") +
      (totals.missing_distance_count ? ` · ${totals.missing_distance_count} missing distance` : "") +
      (totals.hotel_mismatch_count ? ` · ${totals.hotel_mismatch_count} hotel-date alert(s)` : "") +
      (totals.out_of_window_count ? ` · ${totals.out_of_window_count} off-window day alert(s)` : "") +
      (totals.availability_count ? ` · ${totals.availability_count} availability alert(s)` : "") +
      (totals.uncertified_count ? ` · ${totals.uncertified_count} cert alert(s)` : "") +
      (totals.declined_count ? ` · ${totals.declined_count} declined` : "") +
      (totals.pending_count ? ` · ${totals.pending_count} pending` : "");
    document.getElementById("report-totals").innerHTML =
      `<th colspan="${lead}">Totals${note}</th>` +
      `<th class="num">${totals.official_days_total}</th>` +
      `<th class="num">${money(totals.pay)}</th><th class="num">${money(totals.mileage)}</th>`;

    _renderCoverage();
    _renderConflicts();
    _renderSchedule();
    _renderDietary();
    _renderMissingDistances();

    // Officials needing accommodation: those with a hotel assignment, with the
    // span of days they work (the nights they need a room).
    const lodge = document.querySelector("#lodging-table tbody");
    const housed = reportData.officials.filter((o) => o.hotel_name);
    lodge.innerHTML = housed.length
      ? html`${housed.map((o) => {
          const ds = o.days.map((d) => d.work_date).sort();
          const span = ds.length ? `${fmtDOW(ds[0])} – ${fmtDOW(ds[ds.length - 1])}` : "—";
          return html`<tr><td>${o.official_name}</td><td>${o.hotel_name}</td><td>${span}</td></tr>`;
        })}`
      : '<tr><td class="empty" colspan="3">No officials have a hotel assignment yet.</td></tr>';

    // Room-block pickup: reserved vs assigned per official comp block, so the TD
    // can release unused rooms before the hotel cutoff. Unused rooms are flagged.
    const blocks = reportData.room_blocks || [];
    const pickupBody = document.querySelector("#pickup-table tbody");
    pickupBody.innerHTML = blocks.length
      ? html`${blocks.map((b) => {
          const span = (b.check_in && b.check_out)
            ? `${fmtMDY(b.check_in)} – ${fmtMDY(b.check_out)}` : "—";
          return html`<tr><td>${b.hotel_name}</td><td>${b.confirmation_number || ""}</td><td>${span}</td><td class="num">${b.room_count}</td><td class="num">${b.assigned}</td><td class="num${b.remaining > 0 ? " warn" : ""}">${b.remaining}</td></tr>`;
        })}`
      : '<tr><td class="empty" colspan="6">No official room blocks for this tournament.</td></tr>';
    document.getElementById("pickup-totals").innerHTML = blocks.length
      ? `<th colspan="3">Totals</th><th class="num">${totals.rooms_reserved}</th>` +
        `<th class="num">${totals.rooms_assigned}</th>` +
        `<th class="num${totals.rooms_remaining > 0 ? " warn" : ""}">${totals.rooms_remaining}</th>`
      : "";
    const pnote = document.getElementById("pickup-note");
    if (totals.rooms_remaining > 0) {
      pnote.hidden = false;
      pnote.innerHTML = `<span class="warn">⚠ ${totals.rooms_remaining} reserved room(s) not yet assigned</span> — release before the hotel cutoff to avoid attrition charges.`;
    } else { pnote.hidden = true; pnote.textContent = ""; }

    // Non-official support staff (Site Director, Trainer, …), grouped by role,
    // with the same weekday day-grid the officials roster uses.
    const staff = reportData.staff || [];
    const scols = _reportColumns(reportData.tournament);
    document.querySelector("#report-staff-table thead").innerHTML =
      html`<tr><th>Name</th><th>Role</th>${scols.map((c) => html`<th class="daycol">${c.head}</th>`)}<th class="num">Pay</th><th>Phone</th></tr>`;
    const staffBody = document.querySelector("#report-staff-table tbody");
    staffBody.innerHTML = staff.length
      ? html`${staff.map((s) => {
          const worked = new Set(s.days || []);
          const dayCells = scols.map((c) => `<td class="daycol">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
          return html`<tr><td>${s.name}</td><td>${STAFF_ROLES[s.role] || s.role}</td>${raw(dayCells)}<td class="num">${s.pay ? money(s.pay) : ""}</td><td>${s.phone || ""}</td></tr>`;
        })}`
      : html`<tr><td class="empty" colspan="${scols.length + 4}">No non-official staff added for this tournament.</td></tr>`;
    if (staff.length && (totals.staff_pay || 0) > 0) {
      staffBody.innerHTML += `<tr><th colspan="${scols.length + 2}">Staff pay total</th>` +
        `<th class="num">${money(totals.staff_pay)}</th><th></th></tr>`;
    }

    _renderCertPool();
  }
  // Certification pool matrix: officials (rows) × cert types (cols), ✓ where held,
  // with a holder count per cert in the footer — so the TD plans role coverage
  // against the available pool. A cert with zero holders is flagged (a gap).
  function _renderCertPool() {
    const pool = reportData.cert_pool || { officials: [], counts: {} };
    document.querySelector("#cert-pool-table thead").innerHTML =
      html`<tr><th>Official</th>${getCertPairs().map(([, lbl]) => html`<th class="num">${lbl}</th>`)}</tr>`;
    const body = document.querySelector("#cert-pool-table tbody");
    body.innerHTML = pool.officials.length
      ? html`${pool.officials.map((o) => {
          const held = new Set(o.certs);
          const cells = getCertPairs().map(([v]) => `<td class="num">${held.has(v) ? "✓" : ""}</td>`).join("");
          // An official with no certs can't be assigned ANY role — flag the name.
          const noCert = !o.certs.length;
          const name = noCert
            ? html`<span class="warn" title="holds no certification — can't be assigned any role">⚠ ${o.official_name}</span>`
            : html`${o.official_name}`;
          return html`<tr><td>${name}</td>${raw(cells)}</tr>`;
        })}`
      : html`<tr><td class="empty" colspan="${getCertPairs().length + 1}">No officials in the system yet.</td></tr>`;
    // Footer: holders per cert (zero flagged as a coverage gap in the pool).
    document.getElementById("cert-pool-totals").innerHTML =
      `<th>Holders</th>` + getCertPairs().map(([v]) => {
        const n = pool.counts[v] || 0;
        return `<th class="num${n === 0 ? " warn" : ""}">${n}</th>`;
      }).join("");
    // A note when any official holds no cert at all (chase their paperwork).
    const note = document.getElementById("cert-pool-note");
    const noneCert = pool.officials.filter((o) => !o.certs.length);
    if (note) {
      if (noneCert.length) {
        note.hidden = false;
        note.innerHTML = html`⚠ ${noneCert.length} official(s) hold no certification: <strong>${noneCert.map((o) => o.official_name).join("; ")}</strong> — can't be assigned any role.`;
      } else { note.hidden = true; note.textContent = ""; }
    }
  }
  // Weekday columns for the tournament's play window (TD staffing-plan format).
  function _reportColumns(t) {
    return datesInRange(t.play_start_date, t.play_end_date).map((d) => ({ date: d, head: dowLong(d) }));
  }
  // _dowLong / _fmtMDY now imported from ./app/util.js (A47).
  // Build the staffing-plan rows (header always; data rows when includeData).
  function _reportMatrix(includeData) {
    const cols = _reportColumns(reportData.tournament);
    const header = ["Name", "Position", "Dietary", "Hotel?", "Check-in", "Check-out",
      ...cols.map((c) => c.head), "Days", "Pay", "Mileage"];
    const rows = [header];
    if (includeData) {
      for (const o of reportData.officials) {
        const worked = new Set(o.days.map((d) => d.work_date));
        const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
        rows.push([
          o.official_name, roles, o.dietary_restrictions || "", o.hotel_name ? "Yes" : "No",
          fmtMDY(o.check_in), fmtMDY(o.check_out),
          ...cols.map((c) => (worked.has(c.date) ? "X" : "")),
          o.days.length, o.pay, o.mileage == null ? "" : o.mileage,
        ]);
      }
      const tt = reportData.totals;
      rows.push(["Totals", "", "", "", "", "", ...cols.map(() => ""),
        tt.official_days_total, tt.pay, tt.mileage]);
      // Coverage section — per-day officials count + per-site grid, aligned under
      // the same day columns so the TD can track gaps in a spreadsheet.
      const covByDate = {};
      for (const c of (reportData.coverage || [])) covByDate[c.date] = c.officials;
      rows.push([]);  // blank separator
      rows.push(["Officials per day", "", "", "", "", "",
        ...cols.map((c) => covByDate[c.date] ?? 0), "", "", ""]);
      for (const s of (reportData.site_coverage || [])) {
        const byDate = {};
        for (const b of s.by_date) byDate[b.date] = b.officials;
        rows.push([s.site_label, "", "", "", "", "",
          ...cols.map((c) => byDate[c.date] ?? 0), "", "", ""]);
      }
      for (const r of (reportData.role_coverage || [])) {
        const byDate = {};
        for (const b of r.by_date) byDate[b.date] = b.officials;
        rows.push([certLabel(r.role), "", "", "", "", "",
          ...cols.map((c) => byDate[c.date] ?? 0), "", "", ""]);
      }
    }
    return rows;
  }
  document.getElementById("report-print").addEventListener("click", () => window.print());
  // PDF export: open a clean, self-contained report (officials staffing plan +
  // lodging + other staff) in a new window and auto-print → the TD saves as PDF.
  // No PDF lib — mirrors the hotel-report print-window pattern.
  function exportReportPdf() {
    if (!reportData) { toast("Load the report first", false); return; }
    const e = esc, t = reportData.tournament, totals = reportData.totals;
    const cols = _reportColumns(t);
    const dayHead = cols.map((c) => `<th class="day">${e(c.head)}</th>`).join("");
    const offRows = reportData.officials.length ? reportData.officials.map((o) => {
      const worked = new Set(o.days.map((d) => d.work_date));
      const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
      const dayCells = cols.map((c) => `<td class="day">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
      const flags = [o.has_conflict ? "double-booked" : "", o.missing_distance ? "no distance" : "",
        o.hotel_date_mismatch ? "hotel dates" : "", o.work_date_out_of_window ? "off-window" : "",
        (o.days_outside_availability && o.days_outside_availability.length) ? "not available" : "",
        (o.uncertified_days && o.uncertified_days.length) ? "not certified" : "",
        o.response_status === "declined" ? "DECLINED" : ""].filter(Boolean).join("; ");
      return `<tr><td>${e(o.official_name)}${flags ? ` <span class="flag">⚠ ${e(flags)}</span>` : ""}</td>` +
        `<td>${e(roles)}</td><td>${e(o.dietary_restrictions || "")}</td><td>${o.hotel_name ? "Yes" : "No"}</td>` +
        `<td>${e(fmtMDY(o.check_in))}</td><td>${e(fmtMDY(o.check_out))}</td>${dayCells}` +
        `<td class="num">${o.days.length}</td>` +
        `<td class="num">${money(o.pay)}</td><td class="num">${money(o.mileage)}</td></tr>`;
    }).join("") : `<tr><td class="empty" colspan="${cols.length + 9}">No officials assigned.</td></tr>`;
    const staff = reportData.staff || [];
    const staffRows = staff.length ? staff.map((s) => {
      const worked = new Set(s.days || []);
      const dayCells = cols.map((c) => `<td class="day">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
      return `<tr><td>${e(s.name)}</td><td>${e(STAFF_ROLES[s.role] || s.role)}</td>${dayCells}` +
        `<td class="num">${s.pay ? money(s.pay) : ""}</td></tr>`;
    }).join("") : `<tr><td class="empty" colspan="${cols.length + 3}">No non-official staff.</td></tr>`;
    const housed = reportData.officials.filter((o) => o.hotel_name);
    const lodgeRows = housed.length ? housed.map((o) => {
      const ds = o.days.map((d) => d.work_date).sort();
      const span = ds.length ? `${fmtDOW(ds[0])} – ${fmtDOW(ds[ds.length - 1])}` : "—";
      return `<tr><td>${e(o.official_name)}</td><td>${e(o.hotel_name)}</td><td>${e(span)}</td></tr>`;
    }).join("") : `<tr><td class="empty" colspan="3">No officials with a hotel assignment.</td></tr>`;
    const blocks = reportData.room_blocks || [];
    const pickupRows = blocks.length ? blocks.map((b) => {
      const span = (b.check_in && b.check_out) ? `${e(fmtMDY(b.check_in))} – ${e(fmtMDY(b.check_out))}` : "—";
      const flag = b.remaining > 0 ? ' class="flag"' : "";
      return `<tr><td>${e(b.hotel_name)}</td><td>${e(b.confirmation_number || "")}</td><td>${span}</td>` +
        `<td class="num">${b.room_count}</td><td class="num">${b.assigned}</td><td class="num"${flag}>${b.remaining}</td></tr>`;
    }).join("") + `<tr class="totals"><td colspan="3">Totals</td><td class="num">${totals.rooms_reserved}</td>` +
        `<td class="num">${totals.rooms_assigned}</td><td class="num">${totals.rooms_remaining}</td></tr>`
      : `<tr><td class="empty" colspan="6">No official room blocks.</td></tr>`;
    // Certification pool matrix (officials × cert types).
    const pool = reportData.cert_pool || { officials: [], counts: {} };
    const certHead = getCertPairs().map(([, lbl]) => `<th class="num">${e(lbl)}</th>`).join("");
    const certRows = pool.officials.length ? pool.officials.map((o) => {
      const held = new Set(o.certs);
      const cells = getCertPairs().map(([v]) => `<td class="num">${held.has(v) ? "✓" : ""}</td>`).join("");
      const name = o.certs.length ? e(o.official_name) : `<span style="color:#c62828">⚠ ${e(o.official_name)}</span>`;
      return `<tr><td>${name}</td>${cells}</tr>`;
    }).join("") + `<tr class="totals"><td>Holders</td>` +
        getCertPairs().map(([v]) => { const n = pool.counts[v] || 0; return `<td class="num"${n === 0 ? ' style="color:#c62828;font-weight:700"' : ""}>${n}</td>`; }).join("") + `</tr>`
      : `<tr><td class="empty" colspan="${getCertPairs().length + 1}">No officials.</td></tr>`;
    // Coverage cells honor the same threshold as the on-screen tables: red at 0,
    // amber below the minimum.
    const _covStyle = (n) => n === 0 ? ' style="color:#c62828;font-weight:700"'
      : (n < _coverageMin ? ' style="color:#735710;background:#fff8e6;font-weight:700"' : "");
    const covByDate = {};
    for (const c of (reportData.coverage || [])) covByDate[c.date] = c.officials;
    const covCells = cols.map((c) => {
      const n = covByDate[c.date] ?? 0;
      return `<td class="day"${_covStyle(n)}>${n}</td>`;
    }).join("");
    const coverageRow = `<tr class="totals"><td colspan="6">Officials per day</td>${covCells}<td></td><td></td><td></td></tr>`;
    const siteCov = reportData.site_coverage || [];
    const siteCovRows = siteCov.length ? siteCov.map((s) => {
      const cells = s.by_date.map((b) => `<td class="day"${_covStyle(b.officials)}>${b.officials}</td>`).join("");
      return `<tr><td>${e(s.site_label)}</td>${cells}</tr>`;
    }).join("") : `<tr><td class="empty" colspan="${cols.length + 1}">No sites linked.</td></tr>`;
    const roleCov = reportData.role_coverage || [];
    const roleCovRows = roleCov.length ? roleCov.map((r) => {
      const holders = r.holders || 0;
      const cells = r.by_date.map((b) => {
        const fixable = (b.officials === 0 || b.officials < _coverageMin) && holders > b.officials;
        return `<td class="day"${_covStyle(b.officials)}>${b.officials}${fixable ? " ⚑" : ""}</td>`;
      }).join("");
      return `<tr><td>${e(certLabel(r.role))} (${holders} certified)</td>${cells}</tr>`;
    }).join("") : `<tr><td class="empty" colspan="${cols.length + 1}">No officials assigned.</td></tr>`;
    printDoc({
      title: `Staffing plan — ${e(t.name)}`,
      styleExtra: `
        body { margin: 1.2cm; }
        h2 { font-size: 14px; margin: 1.4rem 0 0.4rem; border-bottom-width: 2px; }
        .meta { margin-bottom: 0.4rem; }
        td.day, th.day { text-align: center; }
        .flag { color: #c62828; font-size: 10px; }
        @media print { @page { margin: 1cm; size: landscape; } }`,
      body: `
      <h1>Officials staffing plan</h1>
      <div class="meta">${e(t.name)} · ${e(t.play_start_date)} → ${e(t.play_end_date)}${totals.rule_version ? ` · pay rule ${e(reportData.officials.find((o) => o.rule_version)?.rule_version || "")}` : ""}</div>
      <table><thead><tr><th>Name</th><th>Position</th><th>Dietary</th><th>Hotel?</th><th>Check-in</th><th>Check-out</th>${dayHead}<th class="num">Days</th><th class="num">Pay</th><th class="num">Mileage</th></tr></thead>
        <tbody>${offRows}
          <tr class="totals"><td colspan="${cols.length + 6}">Totals — ${totals.official_count} official(s)</td><td class="num">${totals.official_days_total}</td><td class="num">${money(totals.pay)}</td><td class="num">${money(totals.mileage)}</td></tr>
          ${coverageRow}
        </tbody></table>
      ${totals.uncovered_days_count ? `<p style="color:#c62828">⚠ ${totals.uncovered_days_count} day(s) with no official assigned: ${reportData.uncovered_days.map((d) => e(fmtDOW(d))).join(", ")}</p>` : ""}
      <h2>Coverage by site &amp; day</h2>
      <table><thead><tr><th>Site</th>${dayHead}</tr></thead><tbody>${siteCovRows}</tbody></table>
      <h2>Coverage by role &amp; day</h2>
      <table><thead><tr><th>Role</th>${dayHead}</tr></thead><tbody>${roleCovRows}</tbody></table>
      <h2>Certification pool — all officials</h2>
      <table><thead><tr><th>Official</th>${certHead}</tr></thead><tbody>${certRows}</tbody></table>
      <h2>Officials needing accommodation</h2>
      <table><thead><tr><th>Official</th><th>Hotel</th><th>Nights (worked days)</th></tr></thead><tbody>${lodgeRows}</tbody></table>
      <h2>Room-block pickup (officials)</h2>
      <table><thead><tr><th>Hotel</th><th>Confirmation</th><th>Dates</th><th class="num">Reserved</th><th class="num">Assigned</th><th class="num">Unused</th></tr></thead><tbody>${pickupRows}</tbody></table>
      <h2>Other staff${totals.staff_pay ? ` — pay ${money(totals.staff_pay)}` : ""}</h2>
      <table><thead><tr><th>Name</th><th>Role</th>${dayHead}<th class="num">Pay</th></tr></thead><tbody>${staffRows}</tbody></table>`,
    });
  }
  document.getElementById("report-pdf").addEventListener("click", exportReportPdf);

  // Batch pay statements: one printable section per assigned official (worked days
  // + rate, mileage, total) + a tournament grand total — the reimbursement packet
  // the TD hands to finance. Reuses the report print-window pattern (no PDF lib).
  async function exportPayStatementsBatch() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    let d;
    try { d = await api(`/tournaments/${getActive().id}/pay-statements`); }
    catch (e) { toast(e.message, false); return; }
    if (!d.officials.length) { toast("No officials assigned yet", false); return; }
    const e = esc, t = d.tournament, tt = d.totals;
    const sections = d.officials.map((o) => {
      const dayRows = o.days.length ? o.days.map((x) =>
        `<tr><td>${e(fmtMDY(x.work_date))}</td><td>${e(certLabel(x.working_as))}</td>` +
        `<td class="num">${money(x.rate_applied)}</td></tr>`).join("")
        : `<tr><td colspan="3" class="muted">No worked days.</td></tr>`;
      const mileage = o.missing_distance ? "—  (no distance on file)"
        : `${money(o.mileage)}${o.one_way_miles != null ? `  (${o.one_way_miles} mi one-way${o.mileage === 0 ? ", within free 50 mi" : ""})` : ""}`;
      return `<h2>${e(o.official_name)}${o.official_email ? ` · ${e(o.official_email)}` : ""}</h2>` +
        `<table><thead><tr><th>Date</th><th>Role</th><th class="num">Rate</th></tr></thead>` +
        `<tbody>${dayRows}</tbody></table>` +
        `<p class="line">Pay: <strong>${money(o.pay)}</strong> · Mileage: <strong>${mileage}</strong>` +
        ` · Total: <strong>${money(o.total)}</strong></p>`;
    }).join("");
    printDoc({
      title: `Pay statements — ${t.name}`,
      styleExtra: `
        .grand { margin-top: 1rem; padding: 0.5rem 0.7rem; background: #e7f1ea; border: 1px solid #2e6f40; border-radius: 6px; font-size: 13px; }`,
      body: `
      <h1>Officiating pay statements</h1>
      <div class="sub">${e(t.name)} · ${e(t.play_start_date)} → ${e(t.play_end_date)} · generated ${e(fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
      ${sections}
      <div class="grand"><strong>Tournament total: ${money(tt.total)}</strong> ` +
        `(pay ${money(tt.pay)} + mileage ${money(tt.mileage)}) · ${tt.days} day(s) across ${tt.officials} official(s)</div>`,
    });
  }
  document.getElementById("report-pay-statements").addEventListener("click", exportPayStatementsBatch);

  // Rooming list → print window: one table per hotel block (official, nights they
  // need, dietary) for the TD to hand to the hotel. A ⬇ CSV button is embedded in
  // the print window for hotels that want a spreadsheet. Reuses the print pattern.
  async function exportRoomingList() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    let d;
    try { d = await api(`/tournaments/${getActive().id}/rooming-list`); }
    catch (e) { toast(e.message, false); return; }
    if (!d.blocks.length) { toast("No official room blocks for this tournament", false); return; }
    const e = esc, t = d.tournament, tt = d.totals;
    // CSV rows for the embedded download (flat: one row per occupant).
    const csv = [["Hotel", "Confirmation", "Official", "First night", "Last night", "Dietary", "Phone"]];
    const sections = d.blocks.map((b) => {
      const span = (b.check_in && b.check_out)
        ? `${e(fmtMDY(b.check_in))} – ${e(fmtMDY(b.check_out))}` : "dates TBD";
      const rows = b.occupants.length ? b.occupants.map((o) => {
        csv.push([b.hotel_name, b.confirmation_number || "", o.official_name,
                  o.first_night || "", o.last_night || "", o.dietary_restrictions || "", o.official_phone || ""]);
        const nights = (o.first_night && o.last_night)
          ? `${e(fmtMDY(o.first_night))} – ${e(fmtMDY(o.last_night))}` : "—";
        return `<tr><td>${e(o.official_name)}</td><td>${nights}</td>` +
          `<td>${e(o.dietary_restrictions || "")}</td><td>${e(o.official_phone || "")}</td></tr>`;
      }).join("") : `<tr><td colspan="4" class="muted">No officials assigned to this block.</td></tr>`;
      return `<h2>${e(b.hotel_name)}${b.confirmation_number ? ` · conf. ${e(b.confirmation_number)}` : ""}</h2>` +
        `<p class="line">Block dates: ${span} · ${b.occupants.length}/${b.room_count} room(s) used</p>` +
        `<table><thead><tr><th>Official</th><th>Nights needed</th><th>Dietary</th><th>Phone</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`;
    }).join("");
    const csvData = csv.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    printDoc({
      title: `Rooming list — ${t.name}`,
      popupMsg: "Allow pop-ups to export",
      csv: { data: csvData, filename: "rooming-list-" + (t.name || "").replace(/\s+/g, "_") + ".csv" },
      styleExtra: `
        h2 { margin-bottom: 0.2rem; }
        .line { color: #556070; margin: 0.1rem 0 0.4rem; }`,
      body: `
      <h1>Hotel rooming list</h1>
      <div class="sub">${e(t.name)} · ${tt.blocks} block(s) · ${tt.occupants} room night-guest(s) · ${tt.rooms_reserved} room(s) reserved · generated ${e(fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
      ${sections}`,
    });
  }
  document.getElementById("report-rooming-list").addEventListener("click", exportRoomingList);

  // Day-by-day schedule → print window: one table per play-day (official, role,
  // site) with an embedded CSV download — the day-of sheet to hand to sites.
  async function exportSchedule() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    let d;
    try { d = await api(`/tournaments/${getActive().id}/schedule`); }
    catch (e) { toast(e.message, false); return; }
    if (!d.days.length) { toast("No play-date window set", false); return; }
    const e = esc, t = d.tournament;
    const csv = [["Date", "Official", "Role", "Site", "Response"]];
    const sections = d.days.map((day) => {
      const rows = day.entries.length ? day.entries.map((en) => {
        csv.push([day.date, en.official_name, certLabel(en.working_as), en.site_label || "", en.response_status || ""]);
        return `<tr><td>${e(en.official_name)}</td><td>${e(certLabel(en.working_as))}</td>` +
          `<td>${e(en.site_label || "—")}</td><td>${e(en.response_status || "")}</td></tr>`;
      }).join("") : `<tr><td colspan="4" class="muted">No officials assigned.</td></tr>`;
      return `<h2>${e(fmtMDY(day.date))} <span class="cnt">(${day.count} working)</span></h2>` +
        `<table><thead><tr><th>Official</th><th>Role</th><th>Site</th><th>Response</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>`;
    }).join("");
    const csvData = csv.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    printDoc({
      title: `Schedule — ${t.name}`,
      popupMsg: "Allow pop-ups to export",
      csv: { data: csvData, filename: "schedule-" + (t.name || "").replace(/\s+/g, "_") + ".csv" },
      styleExtra: `
        h2 { margin-bottom: 0.2rem; }
        h2 .cnt { font-weight: 400; color: #556070; font-size: 11px; }`,
      body: `
      <h1>Day-by-day schedule</h1>
      <div class="sub">${e(t.name)} · generated ${e(fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
      ${sections}`,
    });
  }
  document.getElementById("report-schedule-export").addEventListener("click", exportSchedule);
  async function reportCsvExport() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    await loadReports();
    if (reportData) csvDownload(_reportMatrix(true), `staffing-plan-${(getActive().name || "").replace(/\s+/g, "_")}`);
  }
  async function reportTemplateExport() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    await loadReports();
    if (reportData) csvDownload(_reportMatrix(false), "staffing-plan-template");
  }


  return { loadReports, reportCsvExport, reportTemplateExport, exportReportPdf, exportPayStatementsBatch, exportRoomingList, exportSchedule };
}
