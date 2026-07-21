// Tournament roster master/detail — D11.
export function createRosterPanel(ctx) {
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
    money,
    chip,
    makeMenuButton,
    makeGrid,
    scheduleComboSync,
    syncCombos,
    prereqCallout,
    openForm,
    divisionListParams,
    rowGender,
    inferFormGender,
    refreshDivisionLists,
    SHIRT_LABELS,
    csvDownload,
    detailBackdrop,
    setCloseOpenDetail,
    GRIDS,
    getActive,
    getPlayersById,
    openPlayer360,
    loadInbox,
    playersCrudRefresh,
  } = ctx;
  const _csvDownload = csvDownload;
  const _detailBackdrop = detailBackdrop;
  void openForm;

  // --- Roster (master/detail, like the Setup entities) ---
  const rosterForm = document.getElementById("roster-form");
  const rosterTitle = document.getElementById("roster-title");
  const rosterSubmit = rosterForm.querySelector('button[type="submit"]');
  let rosterRows = [];
  let rosterEditId = null;
  // Roster detail form is a modal overlay (parity with the Setup pages).
  const rosterDetail = rosterForm.closest(".detail-pane");
  const rosterCloseBtn = document.createElement("button");
  rosterCloseBtn.type = "button"; rosterCloseBtn.className = "detail-close"; rosterCloseBtn.textContent = "×"; rosterCloseBtn.title = "Close";
  rosterDetail.insertBefore(rosterCloseBtn, rosterDetail.firstChild);
  function rosterOpenModal() {
    rosterDetail.classList.add("detail-open"); detailBackdrop.classList.add("show");
    setCloseOpenDetail(rosterCloseModal);
    scheduleComboSync();
  }
  function rosterCloseModal() {
    rosterDetail.classList.remove("detail-open"); detailBackdrop.classList.remove("show");
    setCloseOpenDetail(null); _rosterAddQueue = [];
  }
  rosterCloseBtn.addEventListener("click", rosterCloseModal);
  async function loadRoster() {
    if (!getActive()) return;
    prereqCallout("panel-t-roster", !Object.keys(getPlayersById()).length,
      "The players catalog is empty — register players first, then add them to this roster (or use Import).",
      "tab-panel-players");
    rosterRows = await api(`/tournaments/${getActive().id}/players`);  // kept for the sign-in export
    if (rosterBuilt) await rosterGrid.setData(rosterRows); else rosterPending = rosterRows;
    applyRosterSel();
    _updateRosterCounts();
    _renderRosterCompleteness();
  }

  // Roster completeness: surface active-tournament entries missing data the TD needs
  // before the event (division, gender, t-shirt, or an unpaid balance) so they can
  // be chased. Clicking a flagged player selects them in the grid for editing.
  const _COMPLETE_LABEL = {
    missing_division: "no division", missing_gender: "no gender",
    missing_shirt: "no t-shirt size", outstanding_balance: "balance due",
  };
  async function _renderRosterCompleteness() {
    const box = document.getElementById("roster-completeness");
    if (!box || !getActive()) return;
    let c;
    try { c = await api(`/tournaments/${getActive().id}/roster-completeness`); }
    catch (e) { box.innerHTML = ""; return; }
    if (!c.counts.incomplete_entries) {
      box.innerHTML = c.counts.total_active
        ? hstr`<p class="rc-clean">✓ All ${c.counts.total_active} active roster entries are complete.</p>` : "";
      return;
    }
    const k = c.counts;
    const chips = [
      k.missing_division ? `${k.missing_division} no division` : "",
      k.missing_gender ? `${k.missing_gender} no gender` : "",
      k.missing_shirt ? `${k.missing_shirt} no t-shirt` : "",
      k.outstanding_balance ? `${k.outstanding_balance} balance due` : "",
    ].filter(Boolean).join(" · ");
    box.innerHTML = html`<details class="rc-details" open><summary>⚠ ${k.incomplete_entries} of ${k.total_active} active entr${k.incomplete_entries === 1 ? "y is" : "ies are"} incomplete <span class="rc-chips">(${chips})</span></summary><ul class="rc-list">${c.entries.map((e) =>
      html`<li class="rc-row" data-eid="${e.entry_id}"><span class="rc-name">${e.player_name} <span class="muted">#${e.usta_number || "—"}</span></span><span class="rc-issues">${e.issues.map((i) =>
        html`<span class="rc-issue${i === "outstanding_balance" ? " rc-issue-pay" : ""}">${_COMPLETE_LABEL[i] || i}${i === "outstanding_balance" && e.amount_outstanding != null ? ` ${money(e.amount_outstanding)}` : ""}</span>`)}</span></li>`)}</ul></details>`;
    box.querySelectorAll(".rc-row").forEach((row) => row.addEventListener("click", () => {
      const id = Number(row.dataset.eid);
      const r = (rosterRows || []).find((x) => x.id === id);
      if (!r) return;
      rosterSelect(r);          // select + load into the editor
      rosterOpenModal();        // open the edit form so the TD can fill the gap
      try { rosterGrid.scrollToRow(id, "center", false); } catch (_) {}
    }));
  }
  // R-4: a one-line summary strip above the roster grid.
  function _updateRosterCounts() {
    const el = document.getElementById("roster-counts");
    if (!el) return;
    const rows = rosterRows || [];
    const n = (s) => rows.filter((r) => r.selection_status === s).length;
    if (!rows.length) { el.textContent = ""; return; }
    const sel = rows.filter((r) => r.selection_status === "selected");
    const inN = sel.filter((r) => r.signed_in).length;
    el.textContent =
      `${rows.length} on roster · ${n("selected")} selected · ${n("alternate")} alternate · ${n("withdrawn")} withdrawn` +
      (sel.length ? ` · checked in ${inN}/${sel.length}` : "");
  }
  const rosterName = (e) => [e.last_name, e.first_name].filter(Boolean).join(", ") || e.usta_number;

  // Tabulator grid for the roster (master/detail like the Setup entities).
  const rosterTableEl = document.getElementById("roster-table");
  const rosterMount = rosterTableEl.closest(".list-scroll") || rosterTableEl.parentElement;
  rosterMount.classList.remove("list-scroll"); rosterMount.innerHTML = ""; rosterMount.classList.add("grid-mount");
  let rosterBuilt = false, rosterPending = null;
  // Final height set by sizeLists() to remaining viewport; interim until shown.
  rosterMount.style.height = rosterMount.style.height || "50vh";
  const rosterGrid = makeGrid(rosterMount, {
    index: "id",
    placeholder: "No players on this roster yet.",
    columnDefaults: { tooltip: true },
    editTriggerEvent: "click",  // single click opens the cell editor (discoverable in-place edit)
    // Active-row highlight (replaces the old per-element rowFormatter); re-evaluated
    // by redrawRows() in applyRosterSel().
    rowClassRules: { "row-selected": (p) => p.data && p.data.id === rosterEditId },
    columns: [
      { title: "Player", field: "last_name",
        // design-crit R-1: show just the name (the USTA # was truncating the cell
        // mid-paren); the number is still searchable and shown on hover.
        formatter: (cell) => { const e = cell.getData(); const u = e.usta_number ? ` (USTA ${e.usta_number})` : "";
          return hstr`<span title="${rosterName(e) + u}">${rosterName(e)}</span>`; },
        headerFilter: "input", headerFilterFunc: (term, _v, e) => (rosterName(e) + " " + (e.usta_number || "")).toLowerCase().includes(String(term).toLowerCase()) },
      { title: "Div", field: "age_division", editor: "list", cssClass: "editable-cell",
        editorParams: (cell) => divisionListParams({ gender: rowGender(cell.getData()) }),
        headerFilter: "input" },
      // Gender is a primary axis when a TD splits work by Boys'/Girls' draws, but
      // it was only used internally (division scoping) — surface + filter it.
      { title: "Gender", field: "gender", width: 84,
        formatter: (c) => { const g = rowGender(c.getData());
          return g === "male" ? "M" : g === "female" ? "F" : '<span class="muted">—</span>'; },
        headerFilter: "list",
        headerFilterParams: { values: { "": "All", male: "Boys / M", female: "Girls / F" }, clearable: true },
        headerFilterFunc: (sel, _v, data) => !sel || rowGender(data) === sel },
      { title: "Status", field: "selection_status", cssClass: "editable-cell",
        editor: "list", editorParams: { values: ["selected", "alternate", "withdrawn"] },
        headerFilter: "list", headerFilterParams: { values: ["selected", "alternate", "withdrawn"], clearable: true },
        formatter: (cell) => chip(cell.getData().selection_status) },
      // Day-of check-in (P4-2): click toggles. The sign-in SHEET exports still
      // exist for the clipboard; this records the result so no-shows are queryable.
      { title: "In", field: "signed_in", width: 56, widthGrow: 0, hozAlign: "center",
        headerTooltip: "Day-of check-in — click to toggle",
        formatter: (cell) => cell.getValue()
          ? '<span class="ok" title="Checked in — click to undo">✓</span>'
          : '<span class="muted" title="Not checked in — click to check in">—</span>',
        headerFilter: "list",
        headerFilterParams: { values: { "": "All", "true": "checked in", "false": "not in" }, clearable: true },
        headerFilterFunc: (term, v) => String(!!v) === String(term),
        cellClick: async (ev, cell) => {
          ev.stopPropagation();
          const e = cell.getData();
          try {
            await api(`/roster/${e.id}/signin`, { method: "PUT", body: JSON.stringify({ signed_in: !e.signed_in }) });
            toast(`${rosterName(e)}: ${e.signed_in ? "check-in undone" : "checked in"}`, true);
            await loadRoster();
          } catch (err) { toast(err.message, false); }
        } },
      { title: "Shirt", field: "t_shirt_size", cssClass: "editable-cell",
        // Audit M28: source from the canonical list defined alongside _SHIRT_LABEL
        // so the roster grid editor and the t-shirt order page can't drift.
        editor: "list", editorParams: () => ({ values: ["", ...SHIRT_LABELS] }),
        formatter: (c) => c.getValue() ? hstr`${c.getValue()}` : `<span class="muted">—</span>`,
        headerFilter: "input" },
      { title: "Dietary", field: "dietary_preference", editor: "input", cssClass: "editable-cell",
        formatter: (c) => c.getValue() ? hstr`${c.getValue()}` : `<span class="muted">—</span>`,
        headerFilter: "input" },
      // B3 lodging — canonical plan from the combined import. Falls back to
      // the raw free-text answer (rendered in muted italic) when the mapper
      // couldn't categorize it. Click-to-edit lets the TD upgrade a raw answer
      // into a canonical bucket without leaving the grid.
      { title: "Lodging", field: "lodging_plan", cssClass: "editable-cell",
        editor: "list", editorParams: { values: ["", "Hotel", "Local / family", "Commuter", "Commuter 1-2 hrs", "Commuter 2+ hrs"] },
        formatter: (cell) => {
          const e = cell.getData();
          if (e.lodging_plan) return hstr`${e.lodging_plan}`;
          if (e.lodging_plan_raw) return hstr`<span class="muted" style="font-style:italic" title="Unmapped — click to set a canonical plan">${e.lodging_plan_raw}</span>`;
          return "";
        },
        headerFilter: "input",
        headerFilterFunc: (term, _v, e) => ((e.lodging_plan || e.lodging_plan_raw || "").toLowerCase().includes(String(term).toLowerCase())) },
      { title: "", field: "_act", headerSort: false, widthGrow: 0, width: 140, cssClass: "grid-actions-cell",
        formatter: (cell) => {
          const e = cell.getData();
          const wrap = document.createElement("div"); wrap.className = "grid-actions";
          // Edit is the primary action; Withdraw + Remove fold into a ⋯ overflow
          // menu (design-crit R-2) so the destructive verbs don't sit on every row.
          const v360 = document.createElement("button"); v360.type = "button"; v360.className = "btn-icon"; v360.textContent = "👤";
          v360.title = "View everything about this player (360)"; v360.setAttribute("aria-label", v360.title);
          v360.addEventListener("click", (ev) => { ev.stopPropagation(); openPlayer360(e.player_id, getActive() ? getActive().id : null); });
          const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-icon"; ed.textContent = "✎";
          ed.title = "Edit roster entry"; ed.setAttribute("aria-label", ed.title);
          ed.addEventListener("click", (ev) => { ev.stopPropagation(); rosterSelect(e); rosterOpenModal(); });

          const withdrawn = e.selection_status === "withdrawn";
          const doWithdraw = () => {
            if (withdrawn) return;
            // Switch tab first — the tab handler refreshes some selects, which
            // would otherwise wipe our preset value. Set the player after, then
            // open the modal so syncCombos shows the chosen name in the combobox.
            document.querySelector('.tab[data-target="panel-t-withdrawals"]').click();
            const wdForm = document.getElementById("withdrawal-form");
            wdForm.player_ref.value = e.player_id;
            openForm(wdForm);
            scheduleComboSync();
          };
          const doDelete = async () => {
            if (!(await confirmDialog("Remove player from roster?"))) return;
            try { await api(`/roster/${e.id}`, { method: "DELETE" }); if (rosterEditId === e.id) { rosterShowNew(); rosterCloseModal(); } await loadRoster(); }
            catch (err) { toast(err.message, false); }
          };
          // Promote an alternate to selected (the move when a slot opens up).
          const isAlt = e.selection_status === "alternate";
          const doPromote = async () => {
            try {
              await api(`/roster/${e.id}/promote`, { method: "POST" });
              toast(`Promoted ${rosterName(e)} to selected`, true);
              await loadRoster();
            } catch (err) { toast(err.message, false); }
          };
          const items = [
            ...(isAlt ? [{ label: "↑ Promote to selected",
              title: "Move this alternate into a selected slot", onClick: doPromote }] : []),
            { label: withdrawn ? "Already withdrawn" : "Withdraw…",
              title: withdrawn ? "Player is already withdrawn" : "File a withdrawal for this player",
              onClick: doWithdraw },
            { separator: true },
            { label: "Remove from roster", danger: true, onClick: doDelete },
          ];
          const menu = makeMenuButton("⋯", items, { className: "btn-icon row-more", title: "More actions", anchor: true, noCaret: true });
          wrap.append(v360, ed, menu); return wrap;
        } },
    ],
  });
  (GRIDS["panel-t-roster"] ||= []).push(rosterGrid);
  function _rosterOnBuilt() { rosterBuilt = true; if (rosterPending) { rosterGrid.setData(rosterPending); rosterPending = null; } applyRosterSel(); }
  rosterGrid.on("tableBuilt", _rosterOnBuilt);
  // AG's facade reports initialized:true synchronously, but applyRosterSel() reads
  // module consts (rosterPos/Prev/Next) declared further down — running it inline
  // here would hit the temporal dead zone and abort the whole module. Defer to a
  // microtask so the rest of the module finishes evaluating first.
  if (rosterGrid.initialized) queueMicrotask(_rosterOnBuilt);
  // Single click only highlights (keeps double-click free for in-grid editing);
  // the Edit button opens the form overlay.
  rosterGrid.on("rowClick", (e, row) => { rosterEditId = row.getData().id; applyRosterSel(); });
  rosterGrid.on("dataFiltered", applyRosterSel);
  rosterGrid.on("dataSorted", () => { applyRosterSel(); });   // AG sets aria-sort natively
  // In-grid edit: PUT the whole entry (RosterEntryOut has every field the model
  // needs; the backend re-normalizes t_shirt_size). Refresh to reflect that.
  rosterGrid.on("cellEdited", async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const e = cell.getRow().getData();
    try {
      const body = {
        player_id: e.player_id, age_division: e.age_division || null, events: e.events || null,
        selection_status: e.selection_status, t_shirt_size: e.t_shirt_size || null,
        dietary_preference: e.dietary_preference || null,
        lodging_plan: e.lodging_plan || null,
      };
      await api(`/roster/${e.id}`, { method: "PUT", body: JSON.stringify(body) });
      setMsg("roster-msg", "saved", true);
      await loadRoster();
    } catch (err) {
      setMsg("roster-msg", err.message, false);
      try { cell.restoreOldValue(); } catch (_) {}
      await loadRoster();
    }
  });
  function rosterMatches(data) {
    const q = document.getElementById("roster-filter").value.trim().toLowerCase();
    if (!q) return true;
    // Match only the fields a TD can see in the grid — not internal ids
    // (audit C6: typing "1" used to match player_id:1 et al.).
    const hay = [data.first_name, data.last_name, data.usta_number,
      data.age_division, data.events, data.selection_status,
      data.t_shirt_size, data.dietary_preference]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }
  function rosterActiveData() { return rosterBuilt ? rosterGrid.getRows("active").map((r) => r.getData()) : rosterRows; }
  function rosterMarkRows() {
    if (!rosterBuilt) return;
    rosterGrid.redrawRows();   // re-evaluates rowClassRules { row-selected }
  }
  function applyRosterSel() { rosterMarkRows(); rosterUpdateNav(); }
  function rosterSelect(e) {
    rosterEditId = e.id; _rosterFromEmailId = null;  // editing, not an email-seeded add
    rosterSetMode("pick");  // editing an existing entry — always pick mode
    rosterForm.player_id.value = e.player_id;
    // Filter the division + events lists by the picked player's gender BEFORE
    // we set the age_division value, so the existing value finds its <option>.
    refreshDivisionLists(inferFormGender(rosterForm));
    rosterForm.age_division.value = e.age_division || "";
    // Multi-select: `events` is stored comma-joined ("Singles, Doubles") so a
    // plain `.value =` won't match any single <option>. Split + select each.
    _setMultiSelect(rosterForm.events, e.events);
    rosterForm.selection_status.value = e.selection_status;
    rosterForm.t_shirt_size.value = e.t_shirt_size || "";
    rosterForm.dietary_preference.value = e.dietary_preference || "";
    rosterTitle.textContent = "Edit: " + rosterName(e);
    rosterSubmit.textContent = "Save";  // audit P40: one verb across all forms
    if (typeof syncCombos === "function") syncCombos();
    applyRosterSel();
  }

  // Set the selected options on a <select multiple> from a comma-joined string
  // (the format the backend stores for events + willing_divisions).
  function _setMultiSelect(sel, csv) {
    if (!sel || !sel.multiple) return;
    const wanted = new Set(String(csv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    [...sel.options].forEach((o) => { o.selected = wanted.has(o.value); });
  }
  // When the roster add-form was opened from an inbox email ("Add to roster"),
  // this holds that email's id so a successful save can re-run detection and link
  // the email to the just-added player. Cleared on any other form open.
  let _rosterFromEmailId = null;
  // "Add both" (a name-only doubles pair) opens the add-form once per player; the
  // second player's prefill waits here and is opened after the first SAVE. Cleared
  // if the TD cancels (so a half-finished pair doesn't pop the second form).
  let _rosterAddQueue = [];
  function rosterShowNew() {
    rosterEditId = null; _rosterFromEmailId = null; rosterForm.reset();
    rosterTitle.textContent = "New roster entry";
    rosterSubmit.textContent = "Create";  // audit P40: matches wireEntity's "Create" on new
    rosterSetMode("pick");
    if (typeof syncCombos === "function") syncCombos();
    applyRosterSel();
  }
  // Two-mode add: pick an existing player, or inline-create a new one (handler
  // upserts via the backend). Single-source-of-truth flag drives the form fields
  // and the submit body shape.
  let rosterMode = "pick";
  function rosterSetMode(mode) {
    rosterMode = mode;
    const pickRow = rosterForm.querySelector(".roster-pick-row");
    const newRow = rosterForm.querySelector(".roster-new-row");
    const pickBtn = document.getElementById("roster-mode-pick");
    const newBtn = document.getElementById("roster-mode-new");
    const picker = rosterForm.querySelector("[name='player_id']");
    pickRow.hidden = mode !== "pick";
    newRow.hidden = mode !== "new";
    picker.required = mode === "pick";
    picker.disabled = mode !== "pick";
    newRow.querySelectorAll("input, select").forEach((el) => { el.disabled = mode !== "new"; });
    // Design-crit #4: segmented control reflects the active mode via class +
    // aria-selected so screen readers also see the toggle.
    pickBtn.classList.toggle("seg-active", mode === "pick");
    newBtn.classList.toggle("seg-active", mode === "new");
    pickBtn.setAttribute("aria-selected", mode === "pick" ? "true" : "false");
    newBtn.setAttribute("aria-selected", mode === "new" ? "true" : "false");
    // a11y re-review #2: roving tabindex so the tablist matches the WAI-ARIA
    // pattern — Tab enters the selected tab, then arrow keys move between tabs.
    pickBtn.tabIndex = mode === "pick" ? 0 : -1;
    newBtn.tabIndex = mode === "new" ? 0 : -1;
  }
  document.getElementById("roster-mode-pick").addEventListener("click", () => rosterSetMode("pick"));
  document.getElementById("roster-mode-new").addEventListener("click", () => rosterSetMode("new"));
  // Arrow-key navigation between the two roster-source tabs.
  [["roster-mode-pick", "roster-mode-new"], ["roster-mode-new", "roster-mode-pick"]].forEach(([from, to]) => {
    document.getElementById(from).addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        e.preventDefault();
        const target = document.getElementById(to);
        rosterSetMode(to === "roster-mode-pick" ? "pick" : "new");
        target.focus();
      }
    });
  });
  // Prev/Next record navigation (parity with the Setup master/detail forms).
  const rosterNav = document.createElement("div"); rosterNav.className = "detail-nav";
  const rosterPrev = document.createElement("button"); rosterPrev.type = "button"; rosterPrev.className = "nav-btn nav-btn--icon"; rosterPrev.textContent = "‹"; rosterPrev.title = "Previous record"; rosterPrev.setAttribute("aria-label", "Previous record");
  const rosterNext = document.createElement("button"); rosterNext.type = "button"; rosterNext.className = "nav-btn nav-btn--icon"; rosterNext.textContent = "›"; rosterNext.title = "Next record"; rosterNext.setAttribute("aria-label", "Next record");
  const rosterPos = document.createElement("span"); rosterPos.className = "nav-pos";
  rosterNav.append(rosterPrev, rosterPos, rosterNext);
  rosterTitle.parentNode.insertBefore(rosterNav, rosterTitle);
  function rosterUpdateNav() {
    const shown = rosterActiveData();
    const idx = shown.findIndex((e) => e.id === rosterEditId);
    const have = rosterEditId != null && idx >= 0;
    rosterPos.textContent = shown.length ? `${have ? idx + 1 : "–"} / ${shown.length}` : "";
    rosterPrev.disabled = !have || idx <= 0;
    rosterNext.disabled = !have || idx >= shown.length - 1;
  }
  function rosterNavTo(delta) {
    const shown = rosterActiveData();
    const idx = shown.findIndex((e) => e.id === rosterEditId);
    if (idx < 0 || !shown[idx + delta]) return;
    rosterSelect(shown[idx + delta]);
    if (rosterBuilt) try { rosterGrid.scrollToRow(rosterEditId, "nearest", false); } catch (_) {}
  }
  rosterPrev.addEventListener("click", () => rosterNavTo(-1));
  rosterNext.addEventListener("click", () => rosterNavTo(1));
  onSubmit(rosterForm, async () => {
    const b = formObj(rosterForm);
    // pick mode → numeric player_id; new mode → usta_number/first/last (player_id null).
    if (rosterMode === "pick") {
      b.player_id = Number(b.player_id); delete b.usta_number; delete b.first_name; delete b.last_name;
    } else {
      b.player_id = null;
    }
    try {
      const editing = rosterEditId != null;
      const saved = editing
        ? await api(`/roster/${rosterEditId}`, { method: "PUT", body: JSON.stringify(b) })
        : await api(`/tournaments/${getActive().id}/players`, { method: "POST", body: JSON.stringify(b) });
      setMsg("roster-msg", editing ? "saved" : "added", true);
      // If we just inline-created a player, refresh the Setup Players list so
      // the picker has the new option next time.
      if (!editing && rosterMode === "new") { try { await playersCrudRefresh(); } catch (_) {} }
      // If this entry was added from an inbox email, re-run detection on that
      // email so it now links to the player we just put on the roster — no manual
      // "Detect" needed. (Best-effort; the roster save itself already succeeded.)
      const fromEmail = _rosterFromEmailId; _rosterFromEmailId = null;
      if (fromEmail) {
        try {
          const det = await api(`/emails/${fromEmail}/detect-player`, { method: "POST" });
          if (typeof loadInbox === "function") loadInbox();
          if (det && det.detected_player_name) toast(`Linked email to ${det.detected_player_name}`, true);
        } catch (_) { /* detection is a convenience; ignore failures */ }
      }
      await loadRoster();
      // "Add both": grab the queued second player BEFORE the close handlers run
      // (rosterCloseModal clears the queue, so capture it first).
      const _nextAdd = _rosterAddQueue.shift();
      const row = saved && saved.id != null && rosterRows.find((r) => r.id === saved.id);
      if (row) rosterSelect(row); else rosterShowNew();
      rosterCloseModal();
      // "Add both" queue — re-enter this module's prefill (not inbox's free vars).
      if (_nextAdd) setTimeout(() => inboxAddToRoster(_nextAdd.m, _nextAdd.plan), 60);
    } catch (err) { setMsg("roster-msg", err.message, false); markInvalid(rosterForm, err.message); }
  });
  rosterForm.querySelector(".cancel").textContent = "Cancel";
  rosterForm.querySelector(".cancel").addEventListener("click", rosterCloseModal);
  document.getElementById("roster-new").addEventListener("click", () => { rosterShowNew(); rosterOpenModal(); });
  document.getElementById("roster-filter").addEventListener("input", () => { if (rosterBuilt) rosterGrid.setFilter(rosterMatches); });

  // Open the roster form pre-filled from an inbox email (USTA #, name, division).
  // Owned here so D11 free-vars (rosterForm / rosterShowNew / …) stay in-module.
  // Called from the inbox panel via the returned `inboxAddToRoster` export.
  function inboxAddToRoster(m, plan) {
    plan = plan || {};
    document.querySelector('.tab[data-target="panel-t-roster"]')?.click();
    rosterShowNew();
    _rosterFromEmailId = m.id;   // re-detect this email after the save links it
    rosterSetMode(plan.mode);
    if (plan.mode === "pick") {
      const picker = rosterForm.elements.player_id;
      if (picker) {
        picker.value = plan.player_id;
        if (typeof picker._comboSync === "function") picker._comboSync();
      }
      refreshDivisionLists(inferFormGender(rosterForm));
    } else {
      if (plan.gender && rosterForm.elements.gender) rosterForm.elements.gender.value = plan.gender;
      refreshDivisionLists(plan.gender || inferFormGender(rosterForm));
      if (plan.usta_number != null) rosterForm.elements.usta_number.value = plan.usta_number;
      if (plan.first_name) rosterForm.elements.first_name.value = plan.first_name;
      if (plan.last_name) rosterForm.elements.last_name.value = plan.last_name;
      const g = rosterForm.elements.gender;
      if (g && typeof g._comboSync === "function") g._comboSync();
    }
    const div = rosterForm.elements.age_division;
    if (div && plan.age_division && [...div.options].some((o) => o.value === plan.age_division)) {
      div.value = plan.age_division;
      if (typeof div._comboSync === "function") div._comboSync();
    }
    rosterOpenModal();
    scheduleComboSync();
    const who = [plan.first_name, plan.last_name].filter(Boolean).join(" ");
    toast(plan.offRoster
      ? `${m.detected_player_name || who || "Player"} is in the system — pick a division and Save to add them to this roster`
      : `Pre-filled ${who || "from the email"} — ${plan.usta_number ? "confirm gender/division" : "add the USTA #, gender/division"}, then Save`, true);
  }
  // "Add both" for a name-only doubles pair: open the add-form for the first
  // player now, queue the second so it opens after the first SAVE.
  function inboxAddBothToRoster(m, plan0, plan1) {
    _rosterAddQueue = [{ m, plan: plan1 }];
    inboxAddToRoster(m, plan0);
    const who1 = [plan1.first_name, plan1.last_name].filter(Boolean).join(" ");
    toast(`Adding both — confirm this player, then ${who1 || "the partner"} opens next`, true);
  }

  // Sign-in sheet: the workbook's roster format (status/events/size/hotel/lodging),
  // joining the loaded roster with this tournament's player-hotel rows.
  const SIGNIN_HEADERS = ["Status", "Events", "Player", "USTA #", "City", "State",
    "Division", "T-shirt", "Hotel", "Lodging plan", "Dietary"];
  function rosterSignInTemplate() { csvDownload([SIGNIN_HEADERS], "sign-in-sheet-template"); }
  async function rosterSignInExport() {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    let hotelByPlayer = {};
    try {
      for (const r of await api(`/tournaments/${getActive().id}/player-hotels`)) {
        hotelByPlayer[r.player_id] = { hotel: r.hotel_name || "", lodging: r.lodging_plan || "" };
      }
    } catch (e) { /* hotels optional — sheet still useful without them */ }
    const rows = [SIGNIN_HEADERS.slice()];
    for (const e of [...rosterRows].sort((a, b) =>
      (a.last_name || "").localeCompare(b.last_name || "") || (a.first_name || "").localeCompare(b.first_name || ""))) {
      const h = hotelByPlayer[e.player_id] || {};
      const p = getPlayersById()[e.player_id] || {};
      rows.push([
        e.selection_status, e.events || "",
        [e.last_name, e.first_name].filter(Boolean).join(", "), e.usta_number,
        p.city || "", p.state || "", e.age_division || "", e.t_shirt_size || "",
        h.hotel || "", h.lodging || "", e.dietary_preference || "",
      ]);
    }
    csvDownload(rows, `sign-in-sheet-${(getActive().name || "").replace(/\s+/g, "_")}`);
  }

  return {
    loadRoster,
    rosterSignInExport,
    rosterSignInTemplate,
    rosterGrid,
    inboxAddToRoster,
    inboxAddBothToRoster,
  };
}
