// Tabulator grid factories (plan P2 #11a) — extracted from app.js.
//
// Owns ALL generic grid wiring: the Setup master/detail CRUD (`wireEntity`),
// the workspace list grid (`makeListGrid`), and the read-only summary grid
// (`makeReadGrid`). The factories are created ONCE by app.js with a context
// object of its helpers (same names as before the extraction, so the moved
// bodies are unchanged), because they are deliberately coupled to the app's
// toast/message/modal conventions — only the construction seam is new.
// `Tabulator` itself is the vendored script-tag global.
/* global Tabulator */

export function createGridFactories(ctx) {
  const {
    api, esc, setMsg, confirmDialog, markInvalid, scheduleComboSync, formObj,
    _csvDownload, _reflectAriaSort, GRIDS, _detailBackdrop, setCloseOpenDetail,
  } = ctx;

  function _autoHeaderFilters(cols) {
    for (const col of cols) {
      if (col.headerFilter || col.noFilter || !col.field) continue;
      // Skip synthetic (`_…`) and raw key columns (id / *_id) — filtering numeric
      // keys as substrings isn't meaningful; name-bearing columns get a func instead.
      if (col.field.startsWith("_") || col.field === "id" || col.field.endsWith("_id")) continue;
      col.headerFilter = "input";
    }
    return cols;
  }
  // Enable mobile responsive-collapse on a column set: pin the interactive
  // columns (actions, selection checkbox) always-visible, then prepend the ▸
  // toggle (Tabulator doesn't auto-add it under fitColumns + renderVertical:basic,
  // so collapsed columns would otherwise be unreachable). Returns the same array.
  function _withResponsiveCollapse(cols) {
    cols.forEach((c) => {
      const cls = typeof c.cssClass === "string" ? c.cssClass : "";
      if (c.field === "_act" || c.field === "_sel" || cls.includes("grid-actions")) c.responsive = 0;
    });
    cols.unshift({
      formatter: "responsiveCollapse", width: 32, minWidth: 32, widthGrow: 0, hozAlign: "center",
      resizable: false, headerSort: false, responsive: 0, cssClass: "rcollapse-col",
    });
    return cols;
  }
  // Grid options that turn overflow columns into a tap-to-expand ▸ row on phones.
  const RESPONSIVE_OPTS = { responsiveLayout: "collapse", responsiveLayoutCollapseStartOpen: false };

  // ===================== AG Grid migration helpers =========================
  // The grids are moving from Tabulator to AG Grid Community one factory at a
  // time. These helpers translate the app's existing Tabulator-shaped column
  // defs to AG Grid colDefs and emulate the small Tabulator cell/row surface the
  // formatters + edit handlers call, so the per-grid configs don't have to change.
  /* global agGrid */
  const _AG_THEME = "ag-theme-quartz";

  // A Tabulator-like `cell` facade over AG Grid renderer/editor/event params.
  function _agCell(params) {
    const field = params.colDef && params.colDef.field;
    const rowEl = () => params.eGridCell ? params.eGridCell.closest(".ag-row") : null;
    return {
      getData: () => params.data || {},
      getValue: () => params.value,
      getOldValue: () => params.oldValue,
      getField: () => field,
      getElement: () => params.eGridCell || document.createElement("span"),
      getRow: () => ({
        getData: () => params.data || {},
        getElement: () => rowEl() || document.createElement("div"),
        getCell: (f) => ({ getElement: () => params.eGridCell, getValue: () => (params.data || {})[f] }),
      }),
      restoreOldValue: () => { if (params.node) params.node.setDataValue(field, params.oldValue); },
      setValue: (v) => { if (params.node) params.node.setDataValue(field, v); },
    };
  }

  // Translate ONE Tabulator column def → an AG Grid colDef (or null to drop it,
  // e.g. the responsiveCollapse toggle, which AG Grid handles differently).
  function _toAgCol(col) {
    if (!col || col.formatter === "responsiveCollapse") return null;
    const cd = { headerName: col.title != null ? col.title : "" };
    if (col.field) cd.colId = col.field;
    if (col.field && !col.field.startsWith("_")) cd.field = col.field;
    if (col.width) cd.width = col.width;
    if (col.minWidth) cd.minWidth = col.minWidth;
    // widthGrow 0 / fixed width → no flex; else share leftover space (fitColumns).
    if (col.width || col.widthGrow === 0) cd.flex = 0; else cd.flex = col.widthGrow || 1;
    if (col.headerSort === false) cd.sortable = false;
    if (col.resizable === false) cd.resizable = false;
    if (col.hozAlign) cd.cellStyle = { textAlign: col.hozAlign };
    if (col.cssClass) cd.cellClass = col.cssClass;
    if (col.frozen) cd.pinned = "left";
    if (col.field) cd.tooltipField = col.field;
    // formatter → cellRenderer (may return a DOM node or an HTML string).
    if (typeof col.formatter === "function") {
      const fmt = col.formatter;
      cd.cellRenderer = (params) => { try { return fmt(_agCell(params)); } catch (_) { return ""; } };
    }
    // editor → editable + cellEditor (single-click edit is a grid option below).
    if (col.editor) {
      cd.editable = true;
      cd.cellClass = (cd.cellClass ? cd.cellClass + " " : "") + "editable-cell";
      if (col.editor === "list") {
        cd.cellEditor = "agSelectCellEditor";
        cd.cellEditorParams = (params) => {
          const ep = typeof col.editorParams === "function" ? col.editorParams(_agCell(params)) : (col.editorParams || {});
          const vals = ep.values || [];
          return { values: Array.isArray(vals) ? vals : Object.keys(vals) };
        };
      } else if (col.editor === "date") {
        cd.cellEditor = "agDateStringCellEditor";
      } else {
        cd.cellEditor = "agTextCellEditor";
      }
    }
    // header filter — TODO custom dropdown for `list`; text filter for now.
    if (col.headerFilter) { cd.filter = "agTextColumnFilter"; cd.floatingFilter = true; }
    return cd;
  }

  // Create an AG Grid and return a small Tabulator-compatible facade
  // ({ setData, getData, getRows, on, download, redraw, api }). `tabOpts` is the
  // existing Tabulator options object; only the bits the app uses are honored.
  function _makeAgGrid(mount, tabOpts) {
    mount.classList.add(_AG_THEME);
    const colDefs = (tabOpts.columns || []).map(_toAgCol).filter(Boolean);
    const handlers = {};   // event name -> [fns] (Tabulator-style .on)
    let api = null;
    const opts = {
      columnDefs: colDefs,
      rowData: [],
      defaultColDef: { resizable: true, sortable: true, suppressHeaderMenuButton: true,
        ...(tabOpts.columnDefaults && tabOpts.columnDefaults.tooltip ? {} : {}) },
      getRowId: tabOpts.index ? (p) => String(p.data[tabOpts.index]) : undefined,
      singleClickEdit: tabOpts.editTriggerEvent === "click",
      stopEditingWhenCellsLoseFocus: true,
      suppressMovableColumns: true,
      overlayNoRowsTemplate: `<span class="ag-empty">${esc(tabOpts.placeholder || "No data")}</span>`,
      domLayout: "normal",
      onCellValueChanged: (p) => {
        if (p.oldValue === p.newValue) return;
        (handlers.cellEdited || []).forEach((fn) => fn(_agCell(p)));
      },
      onRowClicked: (p) => (handlers.rowClick || []).forEach((fn) => fn(p.event, {
        getData: () => p.data, getElement: () => p.event && p.event.target && p.event.target.closest(".ag-row") })),
      onFilterChanged: () => (handlers.dataFiltered || []).forEach((fn) => fn()),
      onSortChanged: () => (handlers.dataSorted || []).forEach((fn) => fn()),
      onGridReady: (e) => { api = e.api; (handlers.tableBuilt || []).forEach((fn) => fn()); },
    };
    api = agGrid.createGrid(mount, opts);
    mount.__agApi = api;   // debug/test hook (read model row count without DOM)
    const activeRows = () => { const out = []; if (api) api.forEachNodeAfterFilterAndSort((n) => out.push(n)); return out; };
    return {
      api,
      initialized: true,
      on: (evt, fn) => { (handlers[evt] ||= []).push(fn); },
      setData: (rows) => api && api.setGridOption("rowData", rows || []),
      getData: (which) => which === "active" ? activeRows().map((n) => n.data) : (() => { const o = []; api.forEachNode((n) => o.push(n.data)); return o; })(),
      getRows: (which) => (which === "active" ? activeRows() : (() => { const o = []; api.forEachNode((n) => o.push(n)); return o; })())
        .map((n) => ({ getData: () => n.data, getElement: () => (api.getRowNode && null), getCell: (f) => ({ getElement: () => null, getValue: () => n.data[f] }) })),
      getRow: (id) => { const n = api.getRowNode(String(id)); return n ? { getData: () => n.data,
        getCell: (f) => ({ getElement: () => null, getValue: () => n.data[f] }), getElement: () => null } : null; },
      setFilter: () => {},   // app-level external filter handled per grid (TODO)
      redraw: () => api && api.refreshCells({ force: true }),
      download: (_fmt, name) => api && api.exportDataAsCsv({ fileName: name }),
    };
  }

  function makeListGrid(tableId, columns, exportName, placeholder, onDelete, onEdit, onCellEdited, exportCols) {
    // Import/export #3: exportCols (when given) drives a *re-importable* CSV
    // export with snake_case headers, not just the visible Tabulator columns.
    // Each entry is { header, key, fmt? }; fmt(row) lets you compute e.g. a
    // comma-joined player USTA list for pairing-avoidance groups.
    const tableEl = document.getElementById(tableId);
    const panelId = tableEl.closest(".panel")?.id;
    const mount = document.createElement("div"); mount.className = "grid-mount";
    tableEl.parentElement.insertBefore(mount, tableEl); tableEl.remove();
    const csv = document.createElement("button");
    csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
    csv.addEventListener("click", () => {
      if (exportCols && exportCols.length) {
        const headers = exportCols.map((c) => c.header);
        const rows = grid.getData("active").map((r) =>
          exportCols.map((c) => (c.fmt ? c.fmt(r) : r[c.key])));
        _csvDownload([headers, ...rows], exportName);
      } else {
        grid.download("csv", exportName + ".csv");
      }
    });
    mount.parentElement.insertBefore(csv, mount);
    const cols = _autoHeaderFilters(columns.slice());
    cols.push({
      title: "", field: "_act", headerSort: false, widthGrow: 0, width: onEdit ? 72 : 48, cssClass: "grid-actions-cell",
      formatter: (cell) => {
        const r = cell.getData(); const wrap = document.createElement("div"); wrap.className = "grid-actions";
        if (onEdit) {
          const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-icon"; ed.textContent = "✎";
          ed.title = "Edit"; ed.setAttribute("aria-label", "Edit");
          ed.addEventListener("click", (ev) => { ev.stopPropagation(); onEdit(r); });
          wrap.append(ed);
        }
        const del = document.createElement("button"); del.type = "button"; del.className = "btn-icon danger"; del.textContent = "✕";
        del.title = "Delete"; del.setAttribute("aria-label", "Delete");
        del.addEventListener("click", (ev) => { ev.stopPropagation(); onDelete(r); });
        wrap.append(del); return wrap;
      },
    });
    let built = false, pending = null;
    mount.style.height = mount.style.height || "55vh";
    const grid = _makeAgGrid(mount, {
      index: "id", placeholder, editTriggerEvent: "click",
      columnDefaults: { tooltip: true }, columns: cols,
    });
    const _onBuilt = () => { built = true; if (pending) { grid.setData(pending); pending = null; } };
    grid.on("tableBuilt", _onBuilt);
    if (grid.initialized) _onBuilt();  // covers sync-fire race
    if (onCellEdited) grid.on("cellEdited", onCellEdited);
    if (panelId) (GRIDS[panelId] ||= []).push(grid);
    return { setData: (rows) => { if (built) grid.setData(rows); else pending = rows; } };
  }

  // Read-only Tabulator list (summaries / reference tables): sortable + optional
  // CSV, no row actions. Replaces the <table id> in place and registers for the
  // redraw-on-tab-show pass. Returns { grid, setData, setFilter }.
  function makeReadGrid(tableId, columns, exportName, placeholder, opts = {}) {
    const tableEl = document.getElementById(tableId);
    const panelId = tableEl.closest(".panel")?.id;
    const mount = document.createElement("div"); mount.className = "grid-mount";
    if (opts.compact) mount.classList.add("grid-mount--compact");
    tableEl.parentElement.insertBefore(mount, tableEl); tableEl.remove();
    if (exportName) {
      const csv = document.createElement("button");
      csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
      csv.addEventListener("click", () => grid.download("csv", exportName + ".csv"));
      mount.parentElement.insertBefore(csv, mount);
    }
    let built = false, pending = null, pendingFilter = null;
    const grid = new Tabulator(mount, {
      layout: "fitColumns", maxHeight: opts.maxHeight || "55vh", placeholder,
      renderVertical: "basic",
      // Persist the chosen SORT (sort only — see makeListGrid). Opt out with
      // opts.persist === false (the inbox does, to keep its load-time filter
      // behaviour predictable).
      ...(opts.persist === false ? {} : { persistence: { sort: true }, persistenceID: "courtops-v1-" + tableId }),
      // Mobile responsive-collapse by default; opt out (opts.responsive === false)
      // for grids with column GROUPS or heavy in-cell editing (the inbox).
      ...(opts.responsive === false ? {} : RESPONSIVE_OPTS),
      columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 },
      columns: opts.responsive === false ? _autoHeaderFilters(columns) : _withResponsiveCollapse(_autoHeaderFilters(columns)),
      ...(opts.index ? { index: opts.index } : {}),
      ...(opts.rowFormatter ? { rowFormatter: opts.rowFormatter } : {}),
      // opt-in editing (e.g. the inbox's manual player/USTA assignment) —
      // opts.editable is the trigger event; "dblclick" keeps single-click
      // links (p360, Detect) working in editable cells.
      ...(opts.editable ? { editTriggerEvent: opts.editable === true ? "click" : opts.editable } : {}),
    });
    if (opts.onCellEdited) grid.on("cellEdited", (cell) => opts.onCellEdited(cell));
    const _onBuilt = () => {
      built = true;
      if (pending) { grid.setData(pending); pending = null; }
      if (pendingFilter) { grid.setFilter(pendingFilter); pendingFilter = null; }
    };
    grid.on("tableBuilt", _onBuilt);
    if (grid.initialized) _onBuilt();  // covers sync-fire race
    if (panelId) (GRIDS[panelId] ||= []).push(grid);
    return {
      grid,
      // Read-only summary grids are often loaded async AFTER their panel becomes
      // visible (loadCvb / loadHotelSummary / …). If the grid was built while
      // hidden, fitColumns has nothing to size against — schedule a redraw once
      // data lands so columns expand to fill the now-visible container.
      setData: (rows) => {
        if (built) {
          const p = grid.setData(rows);
          if (p && typeof p.then === "function") p.then(() => { try { grid.redraw(true); } catch (_) {} });
          else requestAnimationFrame(() => { try { grid.redraw(true); } catch (_) {} });
        } else pending = rows;
      },
      setFilter: (fn) => { if (built) grid.setFilter(fn); else pendingFilter = fn; },
    };
  }

  function wireEntity(cfg) {
    const panel = document.getElementById(cfg.panelId);
    const form = document.getElementById(cfg.formId);
    const filterInput = panel.querySelector(".filter");
    const newBtn = panel.querySelector(".new-btn");
    // Add a ⬇ CSV button next to + New so Setup lists match the workspace lists
    // (Tabulator's native download writes a clean CSV from the current data).
    const csvBtn = document.createElement("button");
    csvBtn.type = "button"; csvBtn.className = "export-btn no-print"; csvBtn.textContent = "⬇ CSV";
    csvBtn.title = "Download as CSV";
    newBtn.parentNode.insertBefore(csvBtn, newBtn.nextSibling);
    // Server-search mode (cfg.serverSearch) gets a page-status note in the toolbar.
    let pageNote = null;
    if (cfg.serverSearch) {
      pageNote = document.createElement("span");
      pageNote.className = "muted"; pageNote.style.fontSize = "0.72rem";
      pageNote.setAttribute("aria-live", "polite");
      newBtn.parentNode.insertBefore(pageNote, csvBtn);
    }
    const title = panel.querySelector(".detail-title");
    const detailPane = panel.querySelector(".detail-pane");
    const submitBtn = form.querySelector('button[type="submit"]');
    const deleteBtn = form.querySelector(".delete");
    const cancelBtn = form.querySelector(".cancel");
    // (label is set in index.html now — audit P35.)
    let items = [];
    let selectedId = null;
    let built = false, pending = null;

    // prev/next record navigation (steps through the grid's active = filtered+sorted rows)
    const nav = document.createElement("div");
    nav.className = "detail-nav";
    const prevBtn = document.createElement("button");
    prevBtn.type = "button"; prevBtn.className = "nav-btn nav-btn--icon"; prevBtn.textContent = "‹";
    prevBtn.title = "Previous record"; prevBtn.setAttribute("aria-label", "Previous record");
    const nextBtn = document.createElement("button");
    nextBtn.type = "button"; nextBtn.className = "nav-btn nav-btn--icon"; nextBtn.textContent = "›";
    nextBtn.title = "Next record"; nextBtn.setAttribute("aria-label", "Next record");
    const navPos = document.createElement("span");
    navPos.className = "nav-pos";
    nav.append(prevBtn, navPos, nextBtn);
    detailPane.insertBefore(nav, detailPane.firstChild);

    // The detail form is a modal overlay (the grid owns the full page width).
    const closeBtn = document.createElement("button");
    closeBtn.type = "button"; closeBtn.className = "detail-close"; closeBtn.textContent = "×"; closeBtn.title = "Close";
    detailPane.insertBefore(closeBtn, detailPane.firstChild);
    function openModal() { detailPane.classList.add("detail-open"); _detailBackdrop.classList.add("show"); setCloseOpenDetail(closeModal); }
    function closeModal() { detailPane.classList.remove("detail-open"); _detailBackdrop.classList.remove("show"); setCloseOpenDetail(null); }
    closeBtn.addEventListener("click", closeModal);

    // Build the grid into the old .list-scroll container (reuse the thead titles).
    const tableEl = panel.querySelector(".list-table");
    const titles = [...tableEl.querySelectorAll("thead th")].map((t) => t.textContent.trim());
    const mount = tableEl.closest(".list-scroll") || tableEl.parentElement;
    mount.classList.remove("list-scroll"); mount.innerHTML = ""; mount.classList.add("grid-mount");

    // Columns may opt into in-grid editing via `c.edit` (double-click a cell).
    // Only columns whose `key` maps 1:1 to a writable DB field should set it;
    // composite/computed columns (fmt over several fields) stay form-only.
    const columns = cfg.columns.map((c, i) => {
      const col = {
        title: titles[i] || c.key, field: c.key,
        formatter: c.fmt ? (cell) => esc(c.fmt(cell.getData())) : undefined,
      };
      if (c.hozAlign) col.hozAlign = c.hozAlign;
      if (c.width) col.width = c.width;
      if (c.minWidth) col.minWidth = c.minWidth;
      // responsive priority (higher = collapses into the ▸ row sooner on narrow
      // screens). Omit → Tabulator's default 1. Set 0 to pin a column always-visible.
      if (c.responsive != null) col.responsive = c.responsive;
      // Narrow, non-growing ID column so fitColumns distributes the extra width
      // to the *meaningful* (name / city / …) columns.
      if (c.key === "id") { col.width = 64; col.widthGrow = 0; }
      if (c.edit) {
        col.editor = c.edit.editor;
        if (c.edit.params) col.editorParams = c.edit.params;
        col.cssClass = "editable-cell";
      }
      // Per-column header filter on the meaningful columns (skip the id column).
      // List-editable columns reuse their value set as a dropdown filter; computed
      // (fmt) columns filter against the rendered text.
      if (c.key !== "id") {
        if (c.edit && c.edit.editor === "list") {
          col.headerFilter = "list";
          col.headerFilterParams = { values: c.edit.params.values, clearable: true };
          // List filter: exact match on the raw field value (not substring on the
          // formatted label) — otherwise "female" matches a "male" filter, etc.
          col.headerFilterFunc = (term, _v, data) => String(data[c.key] ?? "") === String(term);
        } else {
          col.headerFilter = "input";
          if (c.fmt) col.headerFilterFunc = (term, _v, data) => c.fmt(data).toLowerCase().includes(String(term).toLowerCase());
        }
      }
      return col;
    });
    // Explicit responsive-collapse toggle (▸). Tabulator doesn't auto-add it
    // under fitColumns + renderVertical:basic, so without this the collapsed
    // columns would be unreachable on a phone. The formatter renders the ▸ only
    // when a row actually has collapsed cells, so it's empty on desktop.
    columns.unshift({
      formatter: "responsiveCollapse", width: 32, minWidth: 32, widthGrow: 0, hozAlign: "center",
      resizable: false, headerSort: false, responsive: 0, cssClass: "rcollapse-col",
    });
    columns.push({
      // a11y 6th-pass: column widened so two 44×44 .btn-icon buttons (+ optional
      // rowAction button) fit without clipping. The old 72 px was narrower than
      // 2× 44 px → edit button overflowed left and got clipped by the previous
      // cell's right edge.
      title: "", field: "_act", headerSort: false, widthGrow: 0, width: cfg.rowAction ? 160 : 84,
      cssClass: "grid-actions-cell", responsive: 0,  // edit/delete never collapse

      formatter: (cell) => {
        const item = cell.getData();
        const wrap = document.createElement("div"); wrap.className = "grid-actions";
        if (cfg.rowAction) { const ex = cfg.rowAction(item); if (ex) wrap.append(ex); }
        const e = document.createElement("button"); e.type = "button"; e.className = "btn-icon"; e.textContent = "✎";
        e.title = "Edit " + cfg.singular; e.setAttribute("aria-label", e.title);
        e.addEventListener("click", (ev) => { ev.stopPropagation(); select(item); openModal(); });
        const d = document.createElement("button"); d.type = "button"; d.className = "btn-icon danger"; d.textContent = "✕";
        d.title = "Delete " + cfg.singular; d.setAttribute("aria-label", d.title);
        d.addEventListener("click", (ev) => { ev.stopPropagation(); removeItem(item.id); });
        wrap.append(e, d); return wrap;
      },
    });

    const table = new Tabulator(mount, {
      index: "id", layout: "fitColumns", maxHeight: "calc(100vh - 16rem)",
      placeholder: `No ${cfg.singular}s yet — use the form to add one.`,
      // On a narrow viewport, columns that don't fit fold into a tap-to-expand ▸
      // row instead of forcing horizontal scroll (mobile support). Desktop shows
      // them all. Priorities come from each column's `responsive` (above).
      responsiveLayout: "collapse", responsiveLayoutCollapseStartOpen: false,
      columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 },
      editTriggerEvent: "click",  // single click opens the cell editor (discoverable in-place edit)
      renderVertical: "basic",  // small lists; avoids the virtual-render resize loop
      columns,
    });
    (GRIDS[cfg.panelId] ||= []).push(table);
    // Setup CSV exports include every importable column (not just what's visible
    // in the grid), so a round-trip via spreadsheet / re-import keeps all fields.
    csvBtn.addEventListener("click", () => {
      const filename = cfg.path.replace(/^\//, "") + ".csv";
      if (cfg.exportCols && cfg.exportCols.length) {
        const headers = cfg.exportCols.map((c) => c.header);
        const rows = table.getData("active").map((r) =>
          cfg.exportCols.map((c) => (c.fmt ? c.fmt(r) : r[c.key])));
        _csvDownload([headers, ...rows], cfg.path.replace(/^\//, ""));
      } else {
        table.download("csv", filename);
      }
    });
    // Tabulator can fire tableBuilt synchronously (small grids, hidden mount,
    // some timing windows) — in which case the listener below registers AFTER
    // the event and never sees it. Cover the sync case with an explicit check
    // on `table.initialized`. (Critical regression discovered in preview.)
    const onBuilt = () => { built = true; if (pending) { table.setData(pending); pending = null; } applySelection(); };
    table.on("tableBuilt", onBuilt);
    if (table.initialized) onBuilt();
    // Single click only highlights the row (keeps double-click free for in-grid
    // editing); use the Edit button to open the form overlay.
    table.on("rowClick", (e, row) => { selectedId = row.getData().id; applySelection(); });
    table.on("dataFiltered", () => { markRows(); updateNav(); });
    table.on("dataSorted", () => { markRows(); updateNav(); _reflectAriaSort(table); });
    // In-grid edit: PUT the whole row (the *Out record has every field the model
    // needs; Pydantic ignores extras). Refresh to pick up server normalization.
    table.on("cellEdited", async (cell) => {
      const data = cell.getRow().getData();
      if (cell.getValue() === cell.getOldValue()) return;  // no-op
      // Cell-local save feedback (plan P1 #3): the global progress bar alone is
      // easy to miss during rapid in-grid edits. Mark the cell while the PUT is
      // in flight; flash saved/error on settle (refresh() may replace the row's
      // DOM node, so the flash lands on the re-fetched cell when possible).
      const el = cell.getElement();
      el.classList.add("cell-saving");
      const flash = (cls) => {
        const node = table.getRow(data.id)?.getCell(cell.getField())?.getElement() || el;
        node.classList.add(cls);
        setTimeout(() => node.classList.remove(cls), cls === "cell-error" ? 1500 : 700);
      };
      try {
        let body = { ...data }; delete body._act;
        if (cfg.transform) body = cfg.transform(body);
        // Audit M19 + M8: send the snapshot's updated_at only when the entity
        // opts in (cfg.optimisticConcurrency); avoids implicit feature-detection
        // on payload shape if some future *Out model adds an unrelated updated_at.
        const headers = cfg.optimisticConcurrency && data.updated_at
          ? { "X-If-Updated-At": data.updated_at } : {};
        await api(`${cfg.path}/${data.id}`, { method: "PUT", body: JSON.stringify(body), headers });
        setMsg(cfg.msgId, "saved", true);
        await refresh();
        if (cfg.afterChange) cfg.afterChange();
        if (selectedId === data.id) fillForm(table.getRow(data.id)?.getData() || data);
        flash("cell-saved");
      } catch (err) {
        setMsg(cfg.msgId, err.message, false);
        try { cell.restoreOldValue(); } catch (_) {}
        await refresh();
        flash("cell-error");
      } finally {
        el.classList.remove("cell-saving");
      }
    });

    function activeData() { return built ? table.getRows("active").map((r) => r.getData()) : items; }
    function updateNav() {
      const shown = activeData();
      const idx = shown.findIndex((it) => it.id === selectedId);
      const have = selectedId != null && idx >= 0;
      navPos.textContent = shown.length ? `${have ? idx + 1 : "–"} / ${shown.length}` : "";
      prevBtn.disabled = !have || idx <= 0;
      nextBtn.disabled = !have || idx >= shown.length - 1;
    }
    function navTo(delta) {
      const shown = activeData();
      const idx = shown.findIndex((it) => it.id === selectedId);
      if (idx < 0 || !shown[idx + delta]) return;
      select(shown[idx + delta]);
      if (built) try { table.scrollToRow(selectedId, "nearest", false); } catch (_) {}
    }
    prevBtn.addEventListener("click", () => navTo(-1));
    nextBtn.addEventListener("click", () => navTo(1));

    function markRows() {  // highlight the selected row
      if (!built) return;
      for (const r of table.getRows()) r.getElement().classList.toggle("row-selected", r.getData().id === selectedId);
    }
    function applySelection() { markRows(); updateNav(); }

    function matchesFilter(data) {
      const q = filterInput.value.trim().toLowerCase();
      if (!q) return true;
      // Only match the values the user can actually *see* in the grid; otherwise
      // typing a number matches arbitrary internal ids (audit C6).
      const visible = cfg.columns
        .filter((c) => c.key !== "id")
        .map((c) => (c.fmt ? c.fmt(data) : data[c.key]))
        .filter((v) => v !== null && v !== undefined)
        .join(" ")
        .toLowerCase();
      return visible.includes(q);
    }

    function fillForm(item) {
      for (const el of form.elements) {
        if (!el.name) continue;
        const v = item ? item[el.name] : null;
        // Multi-select: split the stored comma-string back into selected options.
        if (el.tagName === "SELECT" && el.multiple) {
          const wanted = new Set(String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
          [...el.options].forEach((o) => { o.selected = wanted.has(o.value); });
          continue;
        }
        el.value = v === null || v === undefined ? "" : v;
      }
      scheduleComboSync();  // refresh type-in dropdown displays
    }
    function showNew() {
      selectedId = null; fillForm(null);
      title.textContent = "New " + cfg.singular[0].toUpperCase() + cfg.singular.slice(1);
      submitBtn.textContent = "Create";
      deleteBtn.hidden = true;
      applySelection();
      if (cfg.onNew) cfg.onNew();
    }
    function select(item) {
      selectedId = item.id; fillForm(item);
      title.textContent = `${cfg.singular[0].toUpperCase() + cfg.singular.slice(1)} #${item.id}`;
      submitBtn.textContent = "Save";
      deleteBtn.hidden = false;
      applySelection();
      if (cfg.onSelect) cfg.onSelect(item);
    }
    async function removeItem(id) {
      if (!(await confirmDialog(`Delete ${cfg.singular} #${id}?`))) return;
      try {
        await api(`${cfg.path}/${id}`, { method: "DELETE" });
        setMsg(cfg.msgId, "deleted", true);
        if (selectedId === id) showNew();
        closeModal();
        await refresh();
        if (cfg.afterChange) cfg.afterChange();
      } catch (err) { setMsg(cfg.msgId, err.message, false); }
    }
    async function refresh() {
      // Note: Tabulator 6.3.1 doesn't expose `setPlaceholder` at runtime. The
      // empty-state text is set once at construction via the `placeholder`
      // option (above). An earlier audit (P36) tried to swap to "Loading…"
      // here and back — it threw and the surrounding try/catch in adminInit
      // swallowed the error, leaving every Setup grid blank. Reverted: just
      // call setData.
      let q = "";
      if (cfg.serverSearch) {
        // Server-side search + capped page (the inbox pattern, extended): the
        // toolbar filter becomes a SQL `q`, and only the first pageSize rows
        // load. The note tells the user to refine when the page is full.
        q = filterInput.value.trim();
        const params = new URLSearchParams({ limit: String(cfg.serverSearch.pageSize) });
        if (q) params.set("q", q);
        items = await api(`${cfg.path}?${params}`);
        if (pageNote) {
          pageNote.textContent = items.length >= cfg.serverSearch.pageSize
            ? `showing the first ${cfg.serverSearch.pageSize} — refine the search to narrow`
            : (q ? `${items.length} match(es)` : "");
        }
      } else {
        items = await api(cfg.path);
      }
      if (cfg.onLoad) cfg.onLoad(items, { q });
      if (built) await table.setData(items);
      else pending = items;
      applySelection();
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;
      try {
        let body = formObj(form);
        if (cfg.transform) body = cfg.transform(body);
        const editing = selectedId != null;
        // Audit M19 + M8: include `X-If-Updated-At` only when the entity
        // opts in. items.find() returns the row-as-of-modal-open, which is
        // exactly the snapshot we want to detect "another tab wrote first".
        const orig = editing && cfg.optimisticConcurrency
          ? items.find((it) => it.id === selectedId) : null;
        const headers = orig && orig.updated_at ? { "X-If-Updated-At": orig.updated_at } : {};
        const saved = await api(editing ? `${cfg.path}/${selectedId}` : cfg.path,
          { method: editing ? "PUT" : "POST", body: JSON.stringify(body), headers });
        if (saved && saved.id != null) selectedId = saved.id;
        setMsg(cfg.msgId, editing ? "saved" : "created", true);
        await refresh();
        if (cfg.afterChange) cfg.afterChange();
        if (saved && saved.id != null) select(saved);
        closeModal();
      } catch (err) { setMsg(cfg.msgId, err.message, false); markInvalid(form, err.message); }
      finally { submitBtn.disabled = false; }
    });
    deleteBtn.addEventListener("click", () => { if (selectedId != null) removeItem(selectedId); });
    newBtn.addEventListener("click", () => { showNew(); openModal(); });
    cancelBtn.addEventListener("click", closeModal);
    // Audit M32: debounce typing so we don't run setFilter on every keystroke.
    let _filterTimer = 0;
    filterInput.addEventListener("input", () => {
      clearTimeout(_filterTimer);
      // Server-search mode: the filter box re-queries the API (SQL ILIKE) instead
      // of filtering the loaded page — otherwise a capped page would silently hide
      // matches that never loaded. Longer debounce since each keystroke is a fetch.
      if (cfg.serverSearch) { _filterTimer = setTimeout(() => refresh(), 250); return; }
      _filterTimer = setTimeout(() => { if (built) table.setFilter(matchesFilter); }, 120);
    });
    showNew();
    return { refresh };
  }

  return { wireEntity, makeListGrid, makeReadGrid, _autoHeaderFilters };
}
