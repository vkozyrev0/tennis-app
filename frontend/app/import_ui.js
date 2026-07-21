// Data → Import page (upload / staging / merge) — D11.
export function createImportPage(ctx) {
  const {
    api,
    setMsg,
    toast,
    confirmDialog,
    html,
    hstr,
    raw,
    esc,
    makeMenuButton,
    makeGrid,
    scheduleComboSync,
    activateGroup,
    getActive,
    importRefresh
  } = ctx;

  // --- Data → Import page: per-type upload → staging → merge (built from /api/import/types) ---
  // After a successful merge, importRefresh (from app.js) reloads every grid
  // an importer can touch (roster, Part B, players/distances CRUD, …).
  // USTA #/id-shaped columns: digits only when present.
  const _IMPORT_ID_COLS = new Set(["usta_number", "partner_usta", "usta_1", "usta_2",
    "usta_3", "usta_4", "usta_5", "usta_6", "official_id", "site_id", "source_email_id"]);
  // Money/score columns: must be a number when present.
  const _IMPORT_NUM_COLS = new Set(["amount_paid", "amount_refunded", "amount_due",
    "amount_outstanding", "wtn_singles", "wtn_doubles", "suspension_points"]);
  // Pattern/enum rules per column (case-insensitive), each with a hint.
  const _IMPORT_RULES = {
    gender: { re: /^(m|f|male|female)$/i, msg: "male / female" },
    wants_random: { re: /^(y|n|yes|no|true|false|1|0)$/i, msg: "yes / no" },
    relationship: { re: /^(siblings|same_club)$/i, msg: "siblings / same_club" },
    selection_status: { re: /^(selected|alternate|withdrawn)$/i, msg: "selected / alternate / withdrawn" },
    request_date: { re: /^\d{4}-\d{2}-\d{2}$/, msg: "YYYY-MM-DD" },
    year_of_birth: { re: /^(19|20)\d{2}$/, msg: "4-digit year" },
    age_division: { re: /^[a-z]{0,3}\s?\d{1,2}\b/i, msg: "e.g. B14 / G16" },
  };
  // Client-side, per-cell validation for the import preview grid — the instant
  // first pass (the server's validate() still has the final say: USTA existence,
  // reason-required-on-merge, etc.). Returns an error string, or "" when fine.
  function _importCellError(col, val, required) {
    const v = (val == null ? "" : String(val)).trim();
    if (required.has(col) && !v) return "required";
    if (!v) return "";
    if (_IMPORT_ID_COLS.has(col) && !/^\d+$/.test(v)) return "digits only";
    if (col === "one_way_miles") return Number(v) >= 0 ? "" : "number ≥ 0";
    if (_IMPORT_NUM_COLS.has(col)) return isNaN(Number(v)) ? "must be a number" : "";
    if (col === "emails") return /@/.test(v) ? "" : "missing @";
    const rule = _IMPORT_RULES[col];
    if (rule && !rule.re.test(v)) return rule.msg;
    return "";
  }

  // Per-import-type tab metadata: an icon + a short label (the backend labels are
  // verbose) so the per-import tabs scan fast. Plus the preferred display order
  // (roster variants grouped together).
  const _IMPORT_TAB_META = {
    roster: { icon: "📋", short: "Roster (simple)" },
    roster_initial: { icon: "📥", short: "Roster: Initial" },
    roster_correction: { icon: "✏️", short: "Roster: Correction" },
    late_entries: { icon: "⏰", short: "Late entries" },
    withdrawals: { icon: "🚫", short: "Withdrawals" },
    scheduling_avoidances: { icon: "📅", short: "Scheduling" },
    division_flexibility: { icon: "🔀", short: "Division flex" },
    pairing_avoidances: { icon: "⛔", short: "Pairing avoid" },
    doubles_requests: { icon: "👥", short: "Doubles" },
    player_hotels: { icon: "🏨", short: "Player hotels" },
    tshirt_hotel_dietary: { icon: "👕", short: "Shirt + Hotel + Diet" },
    emails_pdf: { icon: "✉️", short: "Emails (PDF)" },
    distances: { icon: "📏", short: "Distances" },
  };
  const _IMPORT_TAB_ORDER = ["roster", "roster_initial", "roster_correction", "late_entries",
    "withdrawals", "scheduling_avoidances", "division_flexibility", "pairing_avoidances",
    "doubles_requests", "player_hotels", "tshirt_hotel_dietary", "emails_pdf", "distances"];

  // Show/clear a "staged rows waiting" badge on an import type's tab, so the TD can
  // switch tabs without losing track of an in-progress batch.
  function _importTabBadge(key, count) {
    const btn = document.querySelector(`.import-tab[data-key="${key}"]`);
    if (!btn) return;
    let b = btn.querySelector(".import-tab-badge");
    if (!count) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement("span"); b.className = "import-tab-badge"; btn.appendChild(b); }
    b.textContent = String(count);
  }

  // Import preview: an editable grid of the staged rows. The TD sees exactly what
  // the file contained, fixes bad cells in place (each edit PATCHes + re-validates
  // server-side), bulk-fixes (delete flagged / set a column for all), then merges
  // the ready rows (flagged rows are skipped, not blocked, and stay for fixing).
  async function _renderPreviewGrid(el, body, meta) {
    const required = new Set(meta.required || []);
    const cols = meta.columns || [];
    const bid = body.batch_id;
    el.innerHTML = "";

    const head = document.createElement("div"); head.className = "import-preview-head";
    const counts = document.createElement("span"); counts.className = "import-counts";
    // Bulk-set: pick a column, type a value, apply to every row.
    const setWrap = document.createElement("span"); setWrap.className = "import-bulkset";
    const setCol = document.createElement("select"); setCol.title = "Column to set for all rows";
    setCol.innerHTML = '<option value="">Set column…</option>' + cols.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    const setVal = document.createElement("input"); setVal.type = "text"; setVal.placeholder = "value"; setVal.className = "import-bulkset-val";
    const setBtn = document.createElement("button"); setBtn.type = "button"; setBtn.className = "export-btn"; setBtn.textContent = "Apply to all";
    setWrap.append(setCol, setVal, setBtn);
    const delFlagged = document.createElement("button");
    delFlagged.type = "button"; delFlagged.className = "export-btn"; delFlagged.textContent = "🗑 Delete flagged";
    const merge = document.createElement("button");
    merge.type = "button"; merge.className = "export-btn primary";
    const disc = document.createElement("button");
    disc.type = "button"; disc.className = "export-btn"; disc.textContent = "Discard";
    head.append(counts, setWrap, delFlagged, merge, disc);
    const mount = document.createElement("div"); mount.className = "import-preview-grid grid-mount";
    const after = document.createElement("div"); after.className = "import-result-after";
    el.append(head, mount, after);

    let grid, dupUstas = new Set();
    // cellErr = the standard rules PLUS the cross-row "duplicate USTA # in file"
    // check (which needs the whole dataset, so it lives here as a closure).
    const cellErr = (col, val) => {
      const base = _importCellError(col, val, required);
      if (base) return base;
      if (col === "usta_number" && val && dupUstas.has(String(val).trim())) return "duplicate USTA # in file";
      return "";
    };
    const _rowClientBad = (d) => cols.some((c) => cellErr(c, d[c]));
    const _rowReady = (d) => d._valid && !_rowClientBad(d);

    const refresh = () => {
      const rows = grid.getData();
      // recompute in-file duplicate USTA #s
      const seen = {}; dupUstas = new Set();
      rows.forEach((d) => { const u = (d.usta_number || "").trim(); if (!u) return; seen[u] = (seen[u] || 0) + 1; if (seen[u] > 1) dupUstas.add(u); });
      grid.getRows().forEach((r) => r.reformat());   // re-tint cells for the new dup set
      const ready = rows.filter(_rowReady).length;
      const flagged = rows.length - ready;
      counts.innerHTML = hstr`Staged ${String(rows.length)}: ${raw(`<strong>${ready} ready</strong>`)}${flagged ? `, ${flagged} to fix` : ""}.`;
      merge.disabled = ready === 0;
      merge.textContent = `Merge ${ready} ready row${ready === 1 ? "" : "s"}`;
      delFlagged.disabled = flagged === 0;
      delFlagged.textContent = `🗑 Delete ${flagged} flagged`;
      _importTabBadge(meta.key, rows.length);
    };

    const mapRow = (r) => ({ _id: r.id, _num: r.row_num, _valid: r.valid, _error: r.error,
      ...Object.fromEntries(cols.map((c) => [c, r.data[c] == null ? "" : r.data[c]])) });
    // (re)load the unmerged staged rows from the server into the grid.
    async function reloadGrid() {
      const b = await api(`/import/batches/${bid}`);
      const unmerged = b.rows.filter((r) => !r.merged).map(mapRow);
      await grid.replaceData(unmerged);
      refresh();
      return unmerged.length;
    }

    let batch;
    try { batch = await api(`/import/batches/${bid}`); }
    catch (e) { el.textContent = e.message; return; }

    const colDefs = [
      { title: "", field: "_status", width: 42, headerSort: false, frozen: true,
        formatter: (c) => { const d = c.getData();
          if (_rowReady(d)) return '<span class="ok" title="ready — will merge">✓</span>';
          const why = d._error || (_rowClientBad(d) ? "check the highlighted cell(s)" : "invalid");
          return `<span class="bad" title="${esc(why)}">⚠</span>`; } },
      { title: "#", field: "_num", width: 46, headerSort: false, frozen: true, cssClass: "muted" },
      ...cols.map((col) => ({
        title: required.has(col) ? col + " *" : col, field: col,
        editor: "input", editableTitle: false, minWidth: 90, widthGrow: 1, cssClass: "editable-cell",
        formatter: (c) => { const err = cellErr(col, c.getValue());
          const v = c.getValue() == null ? "" : String(c.getValue());
          return err ? `<span class="import-cell-bad" title="${esc(err)}">${esc(v) || "—"}</span>` : esc(v); },
      })),
      { title: "", field: "_del", width: 40, headerSort: false,
        formatter: () => '<button type="button" class="btn-icon" title="Remove this row">✕</button>',
        cellClick: async (e, cell) => {
          const d = cell.getData();
          try { await api(`/import/batches/${bid}/rows/${d._id}`, { method: "DELETE" });
            cell.getRow().delete(); refresh(); }
          catch (err) { toast(err.message, false); }
        } },
    ];

    mount.style.height = "52vh";
    grid = makeGrid(mount, {
      index: "_id", editTriggerEvent: "click",
      placeholder: "No rows in this file.", columns: colDefs,
    });
    grid.setData(batch.rows.filter((r) => !r.merged).map(mapRow));
    refresh();
    grid.on("tableBuilt", refresh);

    grid.on("cellEdited", async (cell) => {
      const row = cell.getRow(); const d = row.getData();
      const payload = Object.fromEntries(cols.map((c) => [c, (d[c] ?? "") === "" ? null : d[c]]));
      try {
        const res = await api(`/import/batches/${bid}/rows/${d._id}`,
          { method: "PATCH", body: JSON.stringify({ data: payload }) });
        row.update({ _valid: res.valid, _error: res.error }); row.reformat();
        refresh();
      } catch (err) { toast(err.message, false); }
    });

    setBtn.addEventListener("click", async () => {
      if (!setCol.value) { toast("pick a column to set", false); return; }
      setBtn.disabled = true;
      try {
        await api(`/import/batches/${bid}/bulk-set`, { method: "POST",
          body: JSON.stringify({ column: setCol.value, value: setVal.value }) });
        await reloadGrid();
        toast(`Set ${setCol.value} for all rows`, true);
      } catch (e) { toast(e.message, false); }
      finally { setBtn.disabled = false; }
    });

    delFlagged.addEventListener("click", async () => {
      const ids = grid.getData().filter((d) => !_rowReady(d)).map((d) => d._id);
      if (!ids.length) return;
      if (!(await confirmDialog(`Delete ${ids.length} flagged row(s)? This drops them from the staged batch (the file isn't changed).`, "Delete flagged", "danger"))) return;
      try {
        await api(`/import/batches/${bid}/rows-delete`, { method: "POST", body: JSON.stringify({ ids }) });
        await reloadGrid();
      } catch (e) { toast(e.message, false); }
    });

    const showMerged = (r) => {
      const nConf = (r.conflicts || []).length;
      toast(`Merged ${r.merged}${r.failed ? `, ${r.failed} failed` : ""}${nConf ? `, ${nConf} conflict(s)` : ""}`, !r.failed);
      let html = `<div class="muted">✓ Merged ${r.merged} row(s)${r.failed ? `; ${r.failed} failed` : ""}.</div>`;
      if (nConf) html += `<div class="warn" style="margin-top:.2rem">⚠ ${nConf} conflict(s) — merged anyway:</div>` +
        '<ul class="import-errors" style="color:var(--warn-ink,#8a6d1b)">' +
        r.conflicts.map((c) => hstr`<li>row ${c.row}: ${c.detail}</li>`).join("") + "</ul>";
      if (r.errors && r.errors.length) html += '<ul class="import-errors">' +
        r.errors.map((e) => hstr`<li>row ${e.row}: ${e.error}</li>`).join("") + "</ul>";
      after.innerHTML = html;
    };

    merge.addEventListener("click", async () => {
      const readyIds = grid.getData().filter(_rowReady).map((d) => d._id);
      if (!readyIds.length) return;
      merge.disabled = true;
      try {
        const r = await api(`/import/batches/${bid}/merge`,
          { method: "POST", body: JSON.stringify({ row_ids: readyIds }) });
        // Merged the ready rows; flagged ones stay staged for fixing.
        const remaining = await reloadGrid();
        if (remaining === 0) {
          head.style.display = "none"; mount.style.display = "none";
          showMerged(r); _importTabBadge(meta.key, 0);
        } else {
          toast(`Merged ${r.merged} ready row(s); ${remaining} still need fixing.`, true);
        }
        importRefresh();
      } catch (e) { toast(e.message, false); merge.disabled = false; }
    });
    disc.addEventListener("click", async () => {
      try { await api(`/import/batches/${bid}`, { method: "DELETE" }); el.innerHTML = ""; _importTabBadge(meta.key, 0); }
      catch (e) { toast(e.message, false); }
    });
  }
  // Which import types are Setup catalogs (no active tournament needed) vs
  // tournament-scoped. Used to split the Import page into two groups and to
  // gate the getActive()-tournament needs-note.
  const _IMPORT_SETUP_KEYS = new Set(["distances", "divisions", "events", "players", "officials"]);

  // Build one import type's section (template downloads + upload + preview grid),
  // appended (hidden) to the shared panel. Returns the section element.
  function _buildImportSection(t, panelRoot) {
    const sec = document.createElement("section");
    sec.className = "export-section import-section";
    sec.id = "import-" + t.key;     // deep-link target for per-panel ⬆ Import buttons
    sec.hidden = true;
    const needsT = !_IMPORT_SETUP_KEYS.has(t.key)
      ? '<span class="import-scope-chip" title="Imports into the active tournament">tournament</span>'
      : '<span class="import-scope-chip setup" title="Global Setup catalog — no active tournament needed">Setup catalog</span>';
    // a11y 9th-pass: tabindex="-1" makes the heading programmatically focusable so
    // gotoImport() can land focus here after switching tabs.
    sec.innerHTML = hstr`<h4 tabindex="-1">${t.label} ${raw(needsT)}</h4><p class="muted">${t.desc} <span class="muted">Columns: ${t.columns.join(", ")}${t.required.length ? ` (required: ${t.required.join(", ")})` : ""}.</span></p>`;
    const row = document.createElement("div"); row.className = "export-grid";
    for (const fmt of ["csv", "xlsx"]) {
      const a = document.createElement("a"); a.className = "export-btn"; a.setAttribute("download", "");
      a.href = `/api/import/template/${t.key}?fmt=${fmt}`;
      a.textContent = fmt === "csv" ? "⬇ Template CSV" : "⬇ Template Excel";
      row.appendChild(a);
    }
    // CSV/XLSX for the row-shaped importers; PDF for the emails_pdf type.
    const file = document.createElement("input"); file.type = "file";
    file.accept = t.key === "emails_pdf" ? ".pdf" : ".csv,.xlsx,.xlsm";
    const up = document.createElement("button"); up.type = "button"; up.className = "export-btn"; up.textContent = "Upload & stage";
    const msg = document.createElement("span"); msg.className = "msg";
    row.append(file, up, msg);
    const result = document.createElement("div"); result.className = "import-result";
    sec.append(row, result);
    up.addEventListener("click", async () => {
      if (!getActive()) { msg.textContent = "select a tournament first"; msg.className = "msg bad"; return; }
      if (!file.files[0]) { msg.textContent = "choose a file"; msg.className = "msg bad"; return; }
      up.disabled = true; msg.textContent = "";
      try {
        // Audit M25: route through api() so the progress bar runs and 422
        // detail arrays get the same humanizer as the rest of the app.
        const fd = new FormData(); fd.append("file", file.files[0]);
        const body = await api(`/import/tournaments/${getActive().id}/${t.key}`, { method: "POST", body: fd });
        file.value = "";
        _renderPreviewGrid(result, body, t);
      } catch (e) { msg.textContent = e.message; msg.className = "msg bad"; }
      finally { up.disabled = false; }
    });
    panelRoot.appendChild(sec);
    return sec;
  }

  async function buildImportPage() {
    const tabsRoot = document.getElementById("import-tabs");
    const panelRoot = document.getElementById("import-panel");
    const note = document.getElementById("import-needs-getActive()");
    if (!tabsRoot || !panelRoot) return;
    // Toggle the needs-getActive() hint based on current selection.
    if (note) note.hidden = !!getActive();
    if (tabsRoot.dataset.built) return;
    // Set the guard BEFORE the await so a second concurrent call (e.g. the tab
    // click handler + gotoImport both firing) doesn't race past this check.
    tabsRoot.dataset.built = "1";
    let types;
    try { types = await api("/import/types"); }
    catch (e) { panelRoot.textContent = e.message; tabsRoot.dataset.built = ""; return; }

    const sections = {};   // key -> section element
    const tabBtns = {};    // key -> tab button
    const activate = (key) => {
      if (!sections[key]) return;
      Object.entries(sections).forEach(([k, sec]) => { sec.hidden = k !== key; });
      Object.entries(tabBtns).forEach(([k, btn]) => {
        const on = k === key; btn.classList.toggle("getActive()", on);
        btn.setAttribute("aria-selected", on ? "true" : "false"); btn.tabIndex = on ? 0 : -1;
      });
    };
    buildImportPage._activate = activate;   // gotoImport() drives this

    // Each import type gets its own tab. Tournament-data importers first, then the
    // global Setup catalogs (which don't need an active tournament). Within a
    // group, order by _IMPORT_TAB_ORDER (roster variants grouped together).
    const _ord = (t) => { const i = _IMPORT_TAB_ORDER.indexOf(t.key); return i < 0 ? 99 : i; };
    const groups = [
      { label: "Tournament data", keys: types.filter((t) => !_IMPORT_SETUP_KEYS.has(t.key)).sort((a, b) => _ord(a) - _ord(b)) },
      { label: "Setup catalogs", keys: types.filter((t) => _IMPORT_SETUP_KEYS.has(t.key)).sort((a, b) => _ord(a) - _ord(b)) },
    ];
    for (const g of groups) {
      if (!g.keys.length) continue;
      const lbl = document.createElement("div"); lbl.className = "import-tabgroup-label"; lbl.textContent = g.label;
      tabsRoot.appendChild(lbl);
      for (const t of g.keys) {
        const tm = _IMPORT_TAB_META[t.key] || {};
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "import-tab"; btn.dataset.key = t.key;
        btn.setAttribute("role", "tab"); btn.tabIndex = -1; btn.title = t.label;   // full label on hover
        btn.innerHTML = `<span class="import-tab-ico" aria-hidden="true">${tm.icon || "•"}</span><span class="import-tab-lbl">${esc(tm.short || t.label)}</span>`;
        btn.addEventListener("click", () => activate(t.key));
        tabsRoot.appendChild(btn); tabBtns[t.key] = btn;
        sections[t.key] = _buildImportSection(t, panelRoot);
      }
    }
    const first = (groups.find((g) => g.keys.length) || { keys: [] }).keys[0];
    if (first) activate(first.key);
  }

  // Deep-link helper: activates the Setup → Import tab, builds the page if
  // it hasn't been opened yet, and scrolls to the target section. Used by the
  // per-panel ⬆ Import… buttons so users get contextual entry without the
  // page having to duplicate every importer's UI.
  async function gotoImport(typeKey) {
    // 1. Switch to the Setup group + Import tab.
    const setupGroupBtn = document.querySelector('.gbtn[data-group="setup"]');
    if (setupGroupBtn) setupGroupBtn.click();
    const importTab = document.querySelector('.tab[data-target="panel-import"]');
    if (importTab) importTab.click();
    // 2. Build the page if it hasn't been built yet, then SELECT that type's tab.
    await buildImportPage();
    if (typeof buildImportPage._activate === "function") buildImportPage._activate(typeKey);
    const target = document.getElementById("import-" + typeKey);
    if (target) {
      target.classList.add("import-section-flash");
      setTimeout(() => target.classList.remove("import-section-flash"), 1400);
      // a11y 9th-pass: focus the now-visible section's heading so keyboard users
      // land at the right place. The activation cascade (group → tab → import-tab
      // clicks → buildImportPage → redraws) keeps resetting focus during the
      // ~200 ms it takes to settle, so re-apply a few times. Cheap + idempotent.
      const h = target.querySelector("h4");
      const reapply = () => { if (h && document.activeElement !== h) h.focus({ preventScroll: true }); };
      reapply();
      [40, 120, 250, 450].forEach((ms) => setTimeout(reapply, ms));
    }
  }
  // Expose for inline handlers + tests.
  window.gotoImport = gotoImport;

  // Per-panel ⬆ Import… entry points. data-import-type can be a single key OR
  // a comma-separated list — the Roster panel has two (`roster_initial` for
  // the bulk pre-tournament load + `roster_correction` for the post-deadline
  // status patch). Each key gets its own button.
  let _importTypeLabels = null;
  async function _ensureImportLabels() {
    if (_importTypeLabels) return _importTypeLabels;
    try {
      const types = await api("/import/types");
      _importTypeLabels = Object.fromEntries(types.map((t) => [t.key, t.label]));
    } catch (_) { _importTypeLabels = {}; }
    return _importTypeLabels;
  }
  async function _wirePanelImportButtons() {
    const labels = await _ensureImportLabels();
    document.querySelectorAll(".panel[data-import-type]").forEach((panel) => {
      if (panel.querySelector(".panel-import-btn")) return;
      const keys = panel.dataset.importType.split(",").map((k) => k.trim()).filter(Boolean);
      if (!keys.length) return;
      const target = panel.querySelector(".list-toolbar")
        || panel.querySelector(".actions-row")
        || panel.querySelector(".t-content > h3, .card > h3");
      if (!target) return;
      // design-crit R-1: panels with more than one import type collapse into a
      // single "⬆ Import ▾" menu (one item per type) instead of N side-by-side
      // buttons that truncate the toolbar. Single-type panels keep the compact
      // "⬆ Import…" button.
      if (keys.length > 1) {
        const items = keys.map((key) => {
          const label = labels[key] || "Import";
          // Strip the shared "Roster — " prefix so menu items read "Initial…",
          // "Correction…" rather than repeating the noun on every line.
          const tail = label.replace(/^[^—]*—\s*/, "");
          return { label: `${tail}…`, title: `Open the Import page and jump to "${label}"`, onClick: () => gotoImport(key) };
        });
        const menu = makeMenuButton(`<span aria-hidden="true">⬆</span> Import`, items, { className: "export-btn no-print panel-import-btn" });
        target.appendChild(menu);
        return;
      }
      const key = keys[0];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "export-btn no-print panel-import-btn";
      const label = labels[key] || "Import";
      btn.title = `Open the Import page and jump to "${label}"`;
      btn.innerHTML = `<span aria-hidden="true">⬆</span> Import…`;
      btn.addEventListener("click", () => gotoImport(key));
      target.appendChild(btn);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _wirePanelImportButtons);
  } else {
    _wirePanelImportButtons();
  }

  return { gotoImport, buildImportPage };
}
