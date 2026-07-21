// Part B lists: late entries, withdrawals, scheduling/div-flex, player hotels — D11.
import { makeOriginCol } from './origin_col.js';

export function createPartBPanels(ctx) {
  const {
    api,
    setMsg,
    toast,
    confirmDialog,
    markInvalid,
    formObj,
    onSubmit,
    html,
    hstr,
    raw,
    esc,
    makeListGrid,
    makeReadGrid,
    makeGrid,
    createPlayerList,
    expandPlayerRef,
    csvDownload,
    autoHeaderFilters,
    GRIDS,
    divisionListParams,
    eventListParams,
    rowGender,
    playerCell,
    printDoc,
    getActive,
    getHotelsById,
    loadInbox,
    loadRoster
  } = ctx;
  const _ORIGIN_COL = makeOriginCol({ hstr });
  const lateForm = document.getElementById('late-form');
  const wdForm = document.getElementById('withdrawal-form');
  // csvDownload alias used by wirePlayerList factory below
  const _csvDownload = csvDownload;
  const _autoHeaderFilters = autoHeaderFilters;

  const lateGrid = makeListGrid("late-table", [
    { title: "Date", field: "request_date", editor: "date", cssClass: "editable-cell",
      formatter: (c) => { const e = c.getData(); return hstr`${e.request_date}${e.past_deadline ? raw(' <span class="warn" title="Past the late-entry deadline">⚠</span>') : ""}`; } },
    { title: "Time", field: "request_time", editor: "input", cssClass: "editable-cell" },
    { title: "Player", field: "last_name", formatter: playerCell },
    { title: "USTA #", field: "usta_number" },
    { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell",
      editorParams: (cell) => divisionListParams({ gender: rowGender(cell.getData()) }) },
    { title: "Events", field: "events", editor: "list", cssClass: "editable-cell",
      editorParams: (cell) => eventListParams({ multiple: true, gender: rowGender(cell.getData()) }) },
    _ORIGIN_COL,
  ], "late-entries", "No late entries yet.",
    async (e) => { if (!(await confirmDialog("Delete late entry?"))) return; try { await api(`/late-entries/${e.id}`, { method: "DELETE" }); loadLate(); } catch (err) { setMsg("late-msg", err.message, false); } },
    undefined,
    async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const e = cell.getRow().getData();
      try {
        await api(`/late-entries/${e.id}`, { method: "PUT", body: JSON.stringify({
          age_division: e.age_division || null, events: e.events || null,
          request_date: e.request_date || null, request_time: e.request_time || null,
        }) });
        setMsg("late-msg", "saved", true); loadLate();
      } catch (err) { setMsg("late-msg", err.message, false); try { cell.restoreOldValue(); } catch (_) {} loadLate(); }
    },
    // Import/export #3: full importable column set with snake_case headers
    // matching importer.TYPES["late_entries"]["cols"] aliases.
    [
      { header: "usta_number", key: "usta_number" },
      { header: "first_name", key: "first_name" },
      { header: "last_name", key: "last_name" },
      { header: "age_division", key: "age_division" },
      { header: "events", key: "events" },
      { header: "request_date", key: "request_date" },
      { header: "request_time", key: "request_time" },
      { header: "source_email_id", key: "source_email_id" },
    ]);
  async function loadLate() {
    if (!getActive()) return;
    lateGrid.setData(await api(`/tournaments/${getActive().id}/late-entries`));
  }
  function lateReset() { lateForm.reset(); lateForm.source_email_id.value = ""; }
  onSubmit(lateForm, async (e) => {
    if (!getActive()) return;
    const b = expandPlayerRef(formObj(lateForm));
    b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
    try {
      await api(`/tournaments/${getActive().id}/late-entries`, { method: "POST", body: JSON.stringify(b) });
      setMsg("late-msg", "added", true); lateReset(); loadLate(); loadInbox();
    } catch (err) { setMsg("late-msg", err.message, false); markInvalid(lateForm, err.message); }
  });
  lateForm.querySelector(".cancel").addEventListener("click", lateReset);

  const wdGrid = makeListGrid("withdrawal-table", [
    { title: "Player", field: "last_name", formatter: playerCell },
    { title: "USTA #", field: "usta_number" },
    { title: "Division", field: "age_division" },
    { title: "Events", field: "events", editor: "list", cssClass: "editable-cell",
      editorParams: (cell) => eventListParams({ multiple: true, gender: rowGender(cell.getData()) }) },
    { title: "Alt?", field: "was_alternate", formatter: (c) => (c.getData().was_alternate ? "yes" : "") },
    { title: "Reason", field: "reason", editor: "input", cssClass: "editable-cell" },
    { title: "Notes", field: "notes", editor: "input", cssClass: "editable-cell" },
    _ORIGIN_COL,
  ], "withdrawals", "No withdrawals yet.",
    async (w) => { if (!(await confirmDialog("Delete withdrawal?"))) return; try { await api(`/withdrawals/${w.id}`, { method: "DELETE" }); loadWithdrawals(); loadRoster(); } catch (e) { setMsg("withdrawal-msg", e.message, false); } },
    undefined,
    async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const w = cell.getRow().getData();
      try {
        await api(`/withdrawals/${w.id}`, { method: "PUT", body: JSON.stringify({
          events: w.events || null, reason: w.reason || null, notes: w.notes || null,
        }) });
        setMsg("withdrawal-msg", "saved", true); loadWithdrawals();
      } catch (e) { setMsg("withdrawal-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadWithdrawals(); }
    },
    // Import/export #3: full importable column set.
    [
      { header: "usta_number", key: "usta_number" },
      { header: "first_name", key: "first_name" },
      { header: "last_name", key: "last_name" },
      { header: "events", key: "events" },
      { header: "reason", key: "reason" },
      { header: "notes", key: "notes" },
      { header: "source_email_id", key: "source_email_id" },
    ]);
  async function loadWithdrawals() {
    if (!getActive()) return;
    wdGrid.setData(await api(`/tournaments/${getActive().id}/withdrawals`));
  }
  function wdReset() { wdForm.reset(); wdForm.source_email_id.value = ""; }
  onSubmit(wdForm, async (e) => {
    if (!getActive()) return;
    const b = expandPlayerRef(formObj(wdForm));
    b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
    try {
      const wd = await api(`/tournaments/${getActive().id}/withdrawals`, { method: "POST", body: JSON.stringify(b) });
      setMsg("withdrawal-msg", "added", true); wdReset(); loadWithdrawals(); loadInbox();
      await loadRoster();
      // A slot just opened — auto-suggest the best-matching alternate(s) inline.
      await _suggestAlternates(wd);
    } catch (err) { setMsg("withdrawal-msg", err.message, false); markInvalid(wdForm, err.message); }
  });
  wdForm.querySelector(".cancel").addEventListener("click", () => { wdReset(); _hideWdSuggest(); });

  function _hideWdSuggest() {
    const box = document.getElementById("wd-suggest");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  // After a withdrawal, surface alternates to promote — same division first (the
  // best match), then any other waiting alternates — each with one-click promote.
  async function _suggestAlternates(wd) {
    const box = document.getElementById("wd-suggest");
    if (!box || !getActive()) return;
    const div = wd && wd.age_division;
    let sameDiv = [], others = [];
    try {
      if (div) sameDiv = await api(`/tournaments/${getActive().id}/alternates?age_division=${encodeURIComponent(div)}`);
      const all = await api(`/tournaments/${getActive().id}/alternates`);
      const sameIds = new Set(sameDiv.map((a) => a.id));
      others = all.filter((a) => !sameIds.has(a.id));
    } catch (_) { _hideWdSuggest(); return; }
    if (!sameDiv.length && !others.length) {
      box.hidden = false;
      box.innerHTML = html`<p class="wd-suggest-empty">No alternates waiting${div ? html` in <strong>${div}</strong> or any other division` : ""} — nothing to promote.</p>`;
      return;
    }
    const who = wd ? html`${wd.last_name}, ${wd.first_name}` : "a player";
    // per-row html`` (auto-escapes names); joined to a string + raw()'d into the
    // list so the outer html`` doesn't re-escape (see helper double-escape note).
    const row = (a, best) =>
      html`<li class="wd-alt${best ? " is-best" : ""}"><span class="wd-alt-name">${a.last_name}, ${a.first_name}${a.player_id ? raw(` <span class="p360-link" data-pid="${a.player_id}" title="Open player 360">👤</span>`) : ""}</span><span class="wd-alt-div">${a.age_division || "—"}${best ? raw(' <span class="wd-best-tag">best match</span>') : ""}</span><button type="button" class="wd-promote" data-eid="${a.id}" data-name="${a.last_name}, ${a.first_name}">↑ Promote to selected</button></li>`;
    box.hidden = false;
    box.innerHTML = html`<div class="wd-suggest-head"><strong>${who}</strong> withdrew${div ? html` from <strong>${div}</strong>` : ""} — promote an alternate to fill the slot:</div><ul class="wd-alt-list">${raw(sameDiv.map((a) => row(a, true)).join(""))}${
      others.length ? html`<li class="wd-alt-sep">Other divisions</li>${raw(others.map((a) => row(a, false)).join(""))}` : ""
    }</ul>`;
    box.querySelectorAll(".wd-promote").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/roster/${btn.dataset.eid}/promote`, { method: "POST" });
        toast(`Promoted ${btn.dataset.name} to selected`, true);
        btn.closest(".wd-alt").classList.add("wd-alt-done");
        btn.replaceWith(Object.assign(document.createElement("span"), { className: "wd-alt-promoted", textContent: "✓ promoted" }));
        await loadRoster();
      } catch (e) { toast(e.message, false); btn.disabled = false; }
    }));
  }

  // Generic player-keyed Part B list (form + table + delete + file-from-email).
  // Body extracted to app/player_list.js (P2 #11d); created here — at the point of
  // use — so `getActive()`/expandPlayerRef/loadInbox are all defined. `getActive()` is read
  // via a getter since it's a reassigned module global.
  const wirePlayerList = createPlayerList({
    api, setMsg, confirmDialog, markInvalid, formObj,
    _csvDownload: csvDownload, _autoHeaderFilters: autoHeaderFilters,
    GRIDS, expandPlayerRef, loadInbox, makeGrid,
    getActive: () => getActive(),
  });
  const schedList = wirePlayerList({
    formId: "sched-form", msgId: "sched-msg", tableId: "sched-table",
    path: "/scheduling-avoidances", del: "/scheduling-avoidances", exportName: "scheduling-avoidances",
    empty: "No scheduling avoidances yet.",
    editFields: { avoid_day: true, avoid_time_range: true },
    columns: [
      { title: "Player", field: "last_name", formatter: playerCell },
      { title: "USTA #", field: "usta_number" },
      { title: "Avoid day", field: "avoid_day", editor: "input", cssClass: "editable-cell" },
      { title: "Avoid time", field: "avoid_time_range", editor: "input", cssClass: "editable-cell" },
      _ORIGIN_COL,
    ],
    exportCols: [
      { header: "usta_number", key: "usta_number" },
      { header: "first_name", key: "first_name" },
      { header: "last_name", key: "last_name" },
      { header: "avoid_day", key: "avoid_day" },
      { header: "avoid_time_range", key: "avoid_time_range" },
      { header: "source_email_id", key: "source_email_id" },
    ],
  });
  const divflexList = wirePlayerList({
    formId: "divflex-form", msgId: "divflex-msg", tableId: "divflex-table",
    path: "/division-flex", del: "/division-flex", exportName: "division-flexibility",
    empty: "No division-flexibility entries yet.",
    editFields: { home_division: true, willing_divisions: true },
    columns: [
      { title: "Player", field: "last_name", formatter: playerCell },
      { title: "USTA #", field: "usta_number" },
      { title: "Home", field: "home_division", editor: "input", cssClass: "editable-cell" },
      { title: "Willing", field: "willing_divisions", editor: "input", cssClass: "editable-cell" },
      _ORIGIN_COL,
    ],
    exportCols: [
      { header: "usta_number", key: "usta_number" },
      { header: "first_name", key: "first_name" },
      { header: "last_name", key: "last_name" },
      { header: "home_division", key: "home_division" },
      { header: "willing_divisions", key: "willing_divisions" },
      { header: "source_email_id", key: "source_email_id" },
    ],
  });

  const cvbGrid = makeReadGrid("cvb-table", [
    { title: "Hotel", field: "hotel_name" },
    { title: "Stays", field: "stays", hozAlign: "right", width: 110, widthGrow: 0 },
  ], "cvb-hotel-totals", "No player hotel data yet.", { compact: true });
  async function loadCvb() {
    try { cvbGrid.setData(await api("/hotel-analytics")); }
    catch (e) { cvbGrid.setData([]); setMsg("photel-msg", e.message, false); }
  }
  // Per-tournament hotel summary: players per hotel (selected only, alphabetical).
  const hotelSummaryGrid = makeReadGrid("hotel-summary-table", [
    { title: "Hotel", field: "hotel_name" },
    { title: "Players", field: "players", hozAlign: "right", width: 110, widthGrow: 0 },
  ], "hotel-summary", "No hotels entered for selected players yet.", { compact: true });
  async function loadHotelSummary() {
    if (!getActive()) return;
    try { hotelSummaryGrid.setData(await api(`/tournaments/${getActive().id}/hotel-summary`)); }
    catch (e) { hotelSummaryGrid.setData([]); setMsg("photel-msg", e.message, false); }
  }
  // Per-tournament lodging-plan summary: players per plan (Hotel/Commuter/…).
  const lodgingSummaryGrid = makeReadGrid("lodging-summary-table", [
    { title: "Lodging plan", field: "lodging_plan" },
    { title: "Players", field: "players", hozAlign: "right", width: 110, widthGrow: 0 },
  ], "lodging-summary", "No lodging plans entered for selected players yet.", { compact: true });
  async function loadLodgingSummary() {
    if (!getActive()) return;
    try { lodgingSummaryGrid.setData(await api(`/tournaments/${getActive().id}/lodging-summary`)); }
    catch (e) { lodgingSummaryGrid.setData([]); setMsg("photel-msg", e.message, false); }
  }
  const photelList = wirePlayerList({
    formId: "photel-form", msgId: "photel-msg", tableId: "photel-table",
    path: "/player-hotels", del: "/player-hotels", exportName: "player-hotels",
    empty: "No player hotels reported yet.",
    editFields: { hotel_name: true, lodging_plan: true },
    // Three-column layout per requirements: division, player name, hotel name.
    // Hotel cell editor offers existing hotel names as autocomplete suggestions
    // but also accepts a new name (freetext); the backend upserts via the
    // Hotels table so the spelling stays canonical.
    columns: [
      { title: "Division", field: "age_division" },
      { title: "Player", field: "last_name", formatter: playerCell,
        headerFilterFunc: (t, _v, d) => ([d.last_name, d.first_name, d.usta_number].filter(Boolean).join(" ").toLowerCase().includes(String(t).toLowerCase())) },
      { title: "Hotel", field: "hotel_name", cssClass: "editable-cell",
        editor: "list",
        editorParams: () => ({
          values: Object.values(getHotelsById() || {}).map((h) => h.name).sort((a, b) => a.localeCompare(b)),
          autocomplete: true, freetext: true, allowEmpty: true, listOnEmpty: true,
        }) },
      _ORIGIN_COL,
    ],
    exportCols: [
      { header: "usta_number", key: "usta_number" },
      { header: "first_name", key: "first_name" },
      { header: "last_name", key: "last_name" },
      { header: "hotel_name", key: "hotel_name" },
      { header: "lodging_plan", key: "lodging_plan" },
      { header: "source_email_id", key: "source_email_id" },
    ],
    after: () => { loadCvb(); loadHotelSummary(); loadLodgingSummary(); },
  });

  // Confidential per-hotel roster: summary pivot + initials-only detail; opens
  // in a new window with a print-ready stylesheet and auto-triggers Print so
  // the TD can hand it to ops/CVB/etc. without exposing full player names.
  async function openHotelConfidentialReport() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    try {
      const data = await api(`/tournaments/${getActive().id}/hotel-confidential-report`);
      const e = esc;
      const summaryRows = data.summary.length
        ? data.summary.map((r) => `<tr><td>${e(r.hotel_name)}</td><td class="num">${r.players}</td><td class="num">${r.officials}</td><td class="num"><strong>${r.total}</strong></td></tr>`).join("")
        : `<tr><td colspan="4" class="empty">No hotel data yet.</td></tr>`;
      const playerRows = data.players.length
        ? data.players.map((p) => `<tr><td>${e(p.name)}</td><td>${e(p.hotel_name)}</td></tr>`).join("")
        : `<tr><td colspan="2" class="empty">No players with a hotel on file.</td></tr>`;
      const officialRows = data.officials.length
        ? data.officials.map((o) => `<tr><td>${e(o.name)}</td><td>${e(o.hotel_name)}</td></tr>`).join("")
        : `<tr><td colspan="2" class="empty">No officials with a hotel assignment.</td></tr>`;
      const t = getActive().name;
      printDoc({
        title: `Hotel report — ${t}`,
        printLabel: "Print this report",
        popupMsg: "Allow pop-ups for this site to print the report",
        styleExtra: `
        body { margin: 1.2cm; }
        h2 { font-size: 14px; margin: 1.4rem 0 0.4rem; border-bottom-width: 2px; }
        .meta { margin-bottom: 0.4rem; }
        .pagebreak { page-break-before: always; }`,
        body: `
        <h1>Confidential hotel report</h1>
        <div class="meta">${e(t)} · ${e(getActive().play_start_date || "")} → ${e(getActive().play_end_date || "")} · names shown as first-initial + last name</div>

        <h2>Hotel summary — ${data.totals.hotels} hotel(s), ${data.totals.total} guest(s)</h2>
        <table><thead><tr><th>Hotel</th><th class="num">Players</th><th class="num">Officials</th><th class="num">Total</th></tr></thead>
          <tbody>${summaryRows}
            <tr class="totals"><td>Totals</td><td class="num">${data.totals.players}</td><td class="num">${data.totals.officials}</td><td class="num">${data.totals.total}</td></tr>
          </tbody></table>

        <div class="pagebreak"></div>
        <h2>Players (${data.totals.players})</h2>
        <table><thead><tr><th>Name</th><th>Hotel</th></tr></thead><tbody>${playerRows}</tbody></table>

        <h2>Officials (${data.totals.officials})</h2>
        <table><thead><tr><th>Name</th><th>Hotel</th></tr></thead><tbody>${officialRows}</tbody></table>`,
      });
    } catch (err) { setMsg("photel-msg", err.message, false); }
  }
  document.getElementById("photel-report-btn").addEventListener("click", openHotelConfidentialReport);

  return { loadLate, loadWithdrawals, loadCvb, loadHotelSummary, loadLodgingSummary, schedList, divflexList, photelList };
}
