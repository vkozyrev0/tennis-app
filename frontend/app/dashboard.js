// Home / Today dashboard — D11.

export function createDashboardPanel(ctx) {
  const {
    api, toast, html, hstr, raw, esc, money, fmtDOW, fmtMDY, certLabel, respChip, chip,
    getActive, activateGroup, setActive, openOfficial360, filterAssignments,
  } = ctx;
  void chip; void toast; void esc; void money; void certLabel; void respChip;

  // --- Home / "Today" dashboard ---
  // Cross-tournament overview (always) + a status board for the active tournament,
  // aggregating the numbers that otherwise live behind Inbox/Assignments/Reports.
  function _daysUntil(iso) {
    if (!iso) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return Math.round((new Date(iso + "T00:00:00") - today) / 86400000);
  }
  function _deadlineCell(iso) {
    const n = _daysUntil(iso);
    if (n === null) return '<span class="muted">—</span>';
    if (n < 0) return hstr`${fmtMDY(iso)} <span class="muted">(passed)</span>`;
    if (n === 0) return hstr`${fmtMDY(iso)} <span class="warn">(today)</span>`;
    return hstr`${fmtMDY(iso)} <span class="${n <= 7 ? "warn" : "muted"}">(in ${n}d)</span>`;
  }
  function _dashGo(group, tab) {
    activateGroup(group);
    const el = document.querySelector(`.tab[data-target="${tab}"]`);
    if (el) el.click();
  }
  /** During live play (or on play-start day), open Day-of; otherwise Reports. */
  function _coverageGo() {
    const t = getActive();
    if (!t || !t.play_start_date) {
      _dashGo("staffing", "panel-t-reports");
      return;
    }
    const n = _daysUntil(t.play_start_date);
    // Live or past start → venue view; still pre-event → coverage report.
    if (n != null && n <= 0) _dashGo("staffing", "panel-t-dayof");
    else _dashGo("staffing", "panel-t-reports");
  }
  const _DEADLINE_LABEL = { registration: "Registration deadline", late_entry: "Late-entry deadline", play_start: "Play starts" };
  async function _renderDeadlines() {
    const el = document.getElementById("dash-deadlines");
    if (!el) return;
    let data;
    try { data = await api("/dashboard/deadlines"); } catch (_) { el.hidden = true; return; }
    const items = data.deadlines || [];
    if (!items.length) { el.hidden = true; el.innerHTML = ""; return; }
    const urgency = (n) => n < 0 ? html`<span class="resp-bad">${Math.abs(n)}d ago</span>`
      : (n === 0 ? html`<span class="resp-bad">today</span>`
        : html`<span class="${n <= 7 ? "warn" : "muted"}">in ${n}d</span>`);
    el.hidden = false;
    el.innerHTML = html`<div class="dash-dl-head">⏰ ${items.length} deadline${items.length === 1 ? "" : "s"} in the next ${data.within_days} days</div><ul class="dash-dl-list">${items.map((x) =>
      html`<li class="dash-dl-item" data-tid="${x.tournament_id}" tabindex="0" role="button"><strong>${x.tournament_name}</strong> — ${_DEADLINE_LABEL[x.kind] || x.kind} ${fmtMDY(x.date)} · ${urgency(x.days_until)}</li>`)}</ul>`;
    el.querySelectorAll(".dash-dl-item").forEach((li) => {
      const go = () => setActive(Number(li.dataset.tid));
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }
  // Cross-tournament digest: every active event's open-task tally + soonest key
  // date, most-urgent first, so the TD triages across all tournaments at once.
  const _DIGEST_TASKS = [
    ["unfiled_inbox", "unfiled", ["inbox", "panel-t-inbox"]],
    ["officials_pending", "pending", ["staffing", "panel-t-assignments"]],
    ["officials_declined", "declined", ["staffing", "panel-t-assignments"]],
    ["uncovered_days", "uncovered days", ["staffing", "panel-t-reports"]],
    ["conflicts", "conflicts", ["staffing", "panel-t-reports"]],
    ["roster_incomplete", "roster gaps", ["tournament", "panel-t-roster"]],
  ];
  async function _renderDigest() {
    const el = document.getElementById("dash-digest");
    if (!el) return;
    let dg;
    try { dg = await api("/dashboard/digest"); } catch (_) { el.hidden = true; return; }
    const rows = dg.tournaments || [];
    if (!rows.length) { el.hidden = true; el.innerHTML = ""; return; }
    const due = (nd) => {
      if (!nd) return "";
      const n = nd.days_until;
      const when = n < 0 ? `${Math.abs(n)}d ago` : (n === 0 ? "today" : `in ${n}d`);
      const cls = n <= 0 ? "resp-bad" : (n <= 7 ? "warn" : "muted");
      return html` · <span class="${cls}">${_DEADLINE_LABEL[nd.kind] || nd.kind} ${when}</span>`;
    };
    const t = dg.totals;
    el.hidden = false;
    el.innerHTML = html`<div class="dash-dg-head">📋 ${t.open_tasks} open task${t.open_tasks === 1 ? "" : "s"} across ${t.active_tournaments} active tournament${t.active_tournaments === 1 ? "" : "s"}</div><ul class="dash-dg-list">${rows.map((r) => {
        const chips = _DIGEST_TASKS.filter(([k]) => r.tasks[k] > 0).map(([k, label, go]) =>
          html`<button type="button" class="dash-dg-chip" data-go-group="${go[0]}" data-go-tab="${go[1]}" data-tid="${r.tournament_id}">${r.tasks[k]} ${label}</button>`);
        const clean = r.open_tasks === 0 ? html`<span class="dash-dg-clean">✓ all clear</span>` : "";
        return html`<li class="dash-dg-row"><span class="dash-dg-name" data-tid="${r.tournament_id}" tabindex="0" role="button"><strong>${r.tournament_name}</strong>${due(r.next_deadline)}</span><span class="dash-dg-chips">${chips}${clean}</span></li>`;
      })}</ul>`;
    // chip → set that tournament active AND jump to the relevant tab.
    el.querySelectorAll(".dash-dg-chip").forEach((b) => b.addEventListener("click", () => {
      setActive(Number(b.dataset.tid));
      _dashGo(b.dataset.goGroup, b.dataset.goTab);
    }));
    el.querySelectorAll(".dash-dg-name").forEach((n) => {
      const go = () => setActive(Number(n.dataset.tid));
      n.addEventListener("click", go);
      n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
  }
  // Official workload (cross-tournament): days/assignments per official, busiest
  // first, with zero-load officials flagged — so the TD balances staffing. Links to
  // each official's 360. No active tournament needed.
  async function _renderWorkload() {
    const box = document.getElementById("dash-workload");
    if (!box) return;
    let w;
    try { w = await api("/officials/workload"); } catch (_) { box.innerHTML = ""; return; }
    if (!w.officials.length) { box.innerHTML = hstr`<p class="muted">No officials yet.</p>`; return; }
    const t = w.totals;
    const maxDays = Math.max(1, ...w.officials.map((o) => o.days));
    const rows = w.officials.map((o) => {
      const cls = o.assignments === 0 ? "wl-zero" : "";
      const bar = `<span class="wl-bar" style="width:${Math.round((o.days / maxDays) * 100)}%"></span>`;
      const mix = o.assignments
        ? `<span class="muted">${o.accepted}✓ ${o.pending}⏳ ${o.declined}✗</span>` : "";
      return html`<tr class="${cls}"><td><span class="wl-off-link" data-oid="${o.official_id}">${o.official_name}</span></td><td class="num">${o.days}</td><td class="num">${o.assignments}</td><td class="num">${o.tournaments}</td><td class="wl-barcell">${raw(bar)}</td><td>${raw(mix)}</td></tr>`;
    });
    box.innerHTML = html`<p class="muted wl-sub">${t.assigned} of ${t.officials} official(s) staffed · ${t.days} day(s) across ${t.assignments} assignment(s)${t.unused ? html` · <span class="warn">${t.unused} unused</span>` : ""}.</p><table class="list-table wl-table"><thead><tr><th>Official</th><th class="num">Days</th><th class="num">Assigns</th><th class="num">Events</th><th>Load</th><th>Responses</th></tr></thead><tbody>${rows}</tbody></table>`;
    box.querySelectorAll(".wl-off-link[data-oid]").forEach((el) =>
      el.addEventListener("click", () => openOfficial360(Number(el.dataset.oid))));
  }

  async function loadDashboard() {
    _renderDeadlines();  // cross-tournament approaching-deadline banner
    _renderDigest();     // cross-tournament open-task digest
    _renderWorkload();   // cross-tournament official workload balance
    // Cross-tournament overview table.
    let tournaments = [];
    try { tournaments = await api("/tournaments"); } catch (_) {}
    const body = document.querySelector("#dash-overview-table tbody");
    body.innerHTML = tournaments.length
      ? html`${tournaments.slice().sort((a, b) => String(a.play_start_date).localeCompare(String(b.play_start_date)))
          .map((t) => {
            const su = _daysUntil(t.play_start_date);
            const startsIn = su === null ? "" : (su < 0 ? html`<span class="muted">started / past</span>`
              : (su === 0 ? html`<span class="warn">today</span>` : html`in ${su}d`));
            const isActive = getActive() && getActive().id === t.id;
            return html`<tr class="dash-trow${isActive ? " is-active" : ""}" data-tid="${t.id}" tabindex="0" role="button"><td>${t.name}${isActive ? raw(' <span class="badge badge-ok">active</span>') : ""}</td><td>${t.type}</td><td>${fmtMDY(t.play_start_date)} – ${fmtMDY(t.play_end_date)}</td><td>${startsIn}</td><td>${raw(_deadlineCell(t.registration_deadline))}</td><td>${raw(_deadlineCell(t.late_entry_deadline))}</td></tr>`;
          })}`
      : `<tr><td class="empty" colspan="6">No tournaments yet — add one in Setup → Tournaments.</td></tr>`;
    body.querySelectorAll(".dash-trow").forEach((tr) => {
      const pick = () => setActive(Number(tr.dataset.tid));
      tr.addEventListener("click", pick);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
    });

    // Active-tournament status board (tiles).
    const tiles = document.getElementById("dash-tiles");
    const sub = document.getElementById("dash-sub");
    if (!getActive()) {
      tiles.hidden = true; tiles.innerHTML = "";
      sub.textContent = "Pick a tournament below (or in the bar above) to see its status board.";
      return;
    }
    sub.textContent = `Status board — ${getActive().name}`;
    let d;
    try { d = await api(`/tournaments/${getActive().id}/dashboard`); }
    catch (_) { tiles.hidden = true; return; }
    const tile = (label, n, opts = {}) => {
      const alert = opts.alert && n > 0;
      return hstr`<button type="button" class="dash-tile${alert ? " alert" : ""}" data-go-group="${opts.go[0]}" data-go-tab="${opts.go[1]}"><span class="dash-num">${n}</span><span class="dash-label">${label}</span></button>`;
    };
    tiles.hidden = false;
    tiles.innerHTML =
      tile(`unfiled email${d.inbox.new === 1 ? "" : "s"}`, d.inbox.new, { alert: true, go: ["inbox", "panel-t-inbox"] }) +
      tile("officials awaiting reply", d.officials.pending, { alert: true, go: ["staffing", "panel-t-assignments"] }) +
      tile("declined — re-staff", d.officials.declined, { alert: true, go: ["staffing", "panel-t-assignments"] }) +
      tile("uncovered day(s)", d.coverage.uncovered_days_count, {
        alert: true,
        go: (_daysUntil(getActive()?.play_start_date) != null && _daysUntil(getActive().play_start_date) <= 0)
          ? ["staffing", "panel-t-dayof"] : ["staffing", "panel-t-reports"],
      }) +
      tile("staffing conflict(s)", d.conflicts ?? 0, { alert: true, go: ["staffing", "panel-t-reports"] }) +
      tile("rooms unused", d.rooms.unused, { alert: true, go: ["staffing", "panel-t-reports"] }) +
      tile("on roster", d.roster.selected, { go: ["tournament", "panel-t-roster"] }) +
      tile("alternates", d.roster.alternate, { go: ["tournament", "panel-t-roster"] }) +
      tile("withdrawn", d.roster.withdrawn, { go: ["playerlists", "panel-t-withdrawals"] });
    tiles.querySelectorAll("[data-go-group]").forEach((b) =>
      b.addEventListener("click", () => _dashGo(b.dataset.goGroup, b.dataset.goTab)));
    _renderDeclinedAlert(d.officials.declined);
    _renderPendingNudges(d.officials.pending);
    _renderRosterIncomplete();
    _renderCoverageGap(d.coverage);
    _renderReadiness();
  }

  // Coverage-gap nudge: which play days have NO official assigned. The tile shows
  // the count; this names the actual dates (from the dashboard payload, no extra
  // fetch) so the TD knows exactly which days to staff. Deep-links to the coverage
  // report (same target as the uncovered-days tile).
  function _renderCoverageGap(cov) {
    const box = document.getElementById("dash-coverage");
    if (!box || !getActive()) return;
    const days = cov?.uncovered_days || [];
    if (!days.length) { box.hidden = true; box.innerHTML = ""; return; }
    const item = (iso) => html`<li class="dash-pend-item"><span class="dash-pend-name">${fmtDOW(iso)}</span></li>`;
    box.hidden = false;
    const live = _daysUntil(getActive()?.play_start_date) != null && _daysUntil(getActive().play_start_date) <= 0;
    const covBtn = live ? "Open Day-of venue →" : "View coverage on Reports →";
    box.innerHTML = html`<div class="dash-pend-head">📅 ${String(days.length)} play day${days.length === 1 ? raw("") : raw("s")} with no official</div><ul class="dash-pend-list">${days.map(item)}</ul><button type="button" id="dash-cov-go" class="btn-small">${covBtn}</button>`;
    document.getElementById("dash-cov-go")?.addEventListener("click", _coverageGo);
  }

  // Pre-tournament readiness scorecard: one pass/warn/fail row per area, with an
  // overall "ready / N blockers" headline. Each row deep-links to where it's fixed.
  function _readyGoCoverage() {
    const live = _daysUntil(getActive()?.play_start_date) != null && _daysUntil(getActive().play_start_date) <= 0;
    return live ? ["staffing", "panel-t-dayof"] : ["staffing", "panel-t-reports"];
  }
  const _READY_GO = {
    // coverage resolved at click time via _readyGoCoverage (live → Day-of)
    coverage: null, conflicts: ["staffing", "panel-t-reports"],
    declined: ["staffing", "panel-t-assignments"], responses: ["staffing", "panel-t-assignments"],
    roster: ["tournament", "panel-t-roster"], rooms: ["staffing", "panel-t-reports"],
    inbox: ["inbox", "panel-t-inbox"],
  };
  const _READY_ICON = { pass: "✓", warn: "▲", fail: "✗" };
  async function _renderReadiness() {
    const box = document.getElementById("dash-readiness");
    if (!box || !getActive()) return;
    let r;
    try { r = await api(`/tournaments/${getActive().id}/readiness`); }
    catch (_) { box.hidden = true; return; }
    const s = r.summary;
    const headClass = s.fail ? "rdy-fail" : (s.warn ? "rdy-warn" : "rdy-pass");
    const headText = s.fail
      ? `✗ Not ready — ${s.fail} blocker${s.fail === 1 ? "" : "s"}${s.warn ? `, ${s.warn} warning${s.warn === 1 ? "" : "s"}` : ""}`
      : (s.warn ? `▲ Ready with ${s.warn} warning${s.warn === 1 ? "" : "s"}` : "✓ Ready — all checks pass");
    box.hidden = false;
    box.innerHTML = html`<div class="rdy-head ${headClass}">${headText}</div><ul class="rdy-list">${r.checks.map((c) =>
      html`<li class="rdy-row rdy-${c.status}" data-key="${c.key}" tabindex="0" role="button"><span class="rdy-icon">${_READY_ICON[c.status]}</span><span class="rdy-label">${c.label}</span><span class="rdy-detail">${c.detail}</span></li>`)}</ul>`;
    box.querySelectorAll(".rdy-row").forEach((row) => {
      const go = row.dataset.key === "coverage" ? _readyGoCoverage() : _READY_GO[row.dataset.key];
      if (!go) return;
      const jump = () => _dashGo(go[0], go[1]);
      row.addEventListener("click", jump);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } });
    });
  }

  // Named declined-assignment alert: when officials have declined, show WHO (+ the
  // slot they vacated) right on the dashboard, each with a one-click jump to the
  // Assignments tab filtered to declined for re-staffing. (The tile shows only the
  // count; this is the actionable list.)
  async function _renderDeclinedAlert(declinedCount) {
    const box = document.getElementById("dash-declined");
    if (!box || !getActive()) return;
    if (!declinedCount) { box.hidden = true; box.innerHTML = ""; return; }
    let d;
    try { d = await api(`/tournaments/${getActive().id}/declined`); }
    catch (_) { box.hidden = true; return; }
    if (!d.count) { box.hidden = true; return; }
    const item = (r) => {
      const slot = [r.site_label, r.day_count ? `${r.day_count} day${r.day_count === 1 ? "" : "s"}` : ""]
        .filter(Boolean).join(" · ");
      return html`<li class="dash-dec-item"><span class="dash-dec-name">${r.official_name}</span>${slot ? html` <span class="dash-dec-slot">${slot}</span>` : ""}</li>`;
    };
    box.hidden = false;
    box.innerHTML = html`<div class="dash-dec-head">✗ ${d.count} declined — needs re-staffing</div><ul class="dash-dec-list">${d.declined.map(item)}</ul><button type="button" id="dash-dec-go" class="btn-small">Re-staff on Assignments →</button>`;
    document.getElementById("dash-dec-go")?.addEventListener("click", () => {
      _dashGo("staffing", "panel-t-assignments");
      // pre-filter the assignments list to declined so the TD lands on the work.
      setTimeout(() => { try { filterAssignments?.("declined"); } catch (_) {} }, 300);
    });
  }

  // Pending-response nudges: officials assigned but not yet accept/declined. Lists
  // each with a ✉ mailto nudge (pre-filled confirmation ask) — fits the app's
  // mailto-only model (no send infra). Parallel to the declined alert above.
  async function _renderPendingNudges(pendingCount) {
    const box = document.getElementById("dash-pending");
    if (!box || !getActive()) return;
    if (!pendingCount) { box.hidden = true; box.innerHTML = ""; return; }
    let d;
    try { d = await api(`/tournaments/${getActive().id}/pending`); }
    catch (_) { box.hidden = true; return; }
    if (!d.count) { box.hidden = true; return; }
    const tName = getActive().name || "the tournament";
    // Outreach memory: "nudged today / Nd ago" so a fresh gap reads differently
    // from a chased-but-silent one.
    const ago = (iso) => {
      if (!iso) return "";
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
      return days <= 0 ? "nudged today" : days === 1 ? "nudged 1d ago" : `nudged ${days}d ago`;
    };
    const item = (r) => {
      const slot = r.day_count ? `${r.day_count} day${r.day_count === 1 ? "" : "s"}` : "";
      // a pre-filled mailto so the TD can chase a confirmation in one click; only
      // shown when an email is on file (else just the name).
      let nudge = "";
      if (r.official_email) {
        const subj = encodeURIComponent(`Assignment confirmation — ${tName}`);
        const body = encodeURIComponent(
          `Hi ${r.first_name || ""},\n\nPlease confirm (accept or decline) your officiating ` +
          `assignment for ${tName}${slot ? ` (${slot})` : ""}.\n\nThanks!`);
        nudge = html` <a class="dash-pend-nudge" data-aid="${String(r.assignment_id)}" href="mailto:${r.official_email}?subject=${raw(subj)}&body=${raw(body)}">✉ Nudge</a>`;
      }
      const lastNudged = r.last_nudged_at ? html` <span class="dash-pend-ago" title="last contacted">· ${ago(r.last_nudged_at)}</span>` : "";
      return html`<li class="dash-pend-item"><span class="dash-pend-name">${r.official_name}</span>${
        slot ? html` <span class="dash-pend-slot">${slot}</span>` : ""}${nudge}${lastNudged}</li>`;
    };
    box.hidden = false;
    const emails = d.pending.map((p) => p.official_email).filter(Boolean);
    // "Nudge all" only when ≥2 have an email — for one, the per-row ✉ is enough.
    const bulk = emails.length >= 2
      ? html`<button type="button" id="dash-pend-all" class="btn-small">✉ Nudge all (${String(emails.length)})</button>`
      : "";
    box.innerHTML = html`<div class="dash-pend-head">⏳ ${d.count} awaiting accept/decline</div><ul class="dash-pend-list">${d.pending.map(item)}</ul><button type="button" id="dash-pend-go" class="btn-small">Chase on Assignments →</button>${bulk}`;
    document.getElementById("dash-pend-go")?.addEventListener("click", () => {
      _dashGo("staffing", "panel-t-assignments");
      setTimeout(() => { try { filterAssignments?.("pending"); } catch (_) {} }, 300);
    });
    // Per-row ✉: the mailto opens the mail client; we ALSO record the outreach so
    // the row shows "nudged today" next time (best-effort — never block the mailto).
    box.querySelectorAll(".dash-pend-nudge[data-aid]").forEach((a) => {
      a.addEventListener("click", () => {
        api(`/assignments/${a.dataset.aid}/nudged`, { method: "POST" })
          .then(() => _renderPendingNudges(d.count)).catch(() => {});
      });
    });
    document.getElementById("dash-pend-all")?.addEventListener("click", async () => {
      // one bcc mailto to the whole pending group (same pattern as bulk invite).
      const subj = encodeURIComponent(`Assignment confirmation — ${tName}`);
      const body = encodeURIComponent(
        `Hi,\n\nOur records show your officiating assignment for ${tName} is still ` +
        `unconfirmed. Please reply to accept or decline.\n\nThanks!`);
      window.open(`mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${subj}&body=${body}`, "_blank");
      // record the bulk outreach, then refresh so every row shows "nudged today".
      try { await api(`/tournaments/${getActive().id}/pending/nudged`, { method: "POST" }); _renderPendingNudges(d.count); } catch (_) {}
    });
  }

  // Roster-completeness nudge: selected/alternate entries missing required data.
  // Reuses the existing /roster-completeness endpoint (one row per incomplete
  // entry + per-issue `issues`), naming each player + which fields are missing,
  // with a deep-link to the Roster tab. Self-fetches (the dashboard payload
  // doesn't carry the count).
  const _ROSTER_ISSUE_LABEL = {
    missing_division: "division", missing_gender: "gender",
    missing_shirt: "shirt size", outstanding_balance: "balance due",
  };
  async function _renderRosterIncomplete() {
    const box = document.getElementById("dash-roster-incomplete");
    if (!box || !getActive()) return;
    let c;
    try { c = await api(`/tournaments/${getActive().id}/roster-completeness`); }
    catch (_) { box.hidden = true; return; }
    const n = c.counts?.incomplete_entries || 0;
    if (!n) { box.hidden = true; box.innerHTML = ""; return; }
    const item = (e) => html`<li class="dash-pend-item"><span class="dash-pend-name">${e.player_name}</span> <span class="dash-pend-slot">missing: ${
      e.issues.map((i) => _ROSTER_ISSUE_LABEL[i] || i).join(", ")}</span></li>`;
    box.hidden = false;
    box.innerHTML = html`<div class="dash-pend-head">📋 ${String(n)} incomplete roster entr${n === 1 ? raw("y") : raw("ies")}</div><ul class="dash-pend-list">${c.entries.map(item)}</ul><button type="button" id="dash-ri-go" class="btn-small">Fix on Roster →</button>`;
    document.getElementById("dash-ri-go")?.addEventListener("click", () => _dashGo("tournament", "panel-t-roster"));
  }


  return { loadDashboard };
}
