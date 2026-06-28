// Tabulator grid factories (plan P2 #11a) — extracted from app.js.
//
// Owns ALL generic grid wiring: the Setup master/detail CRUD (`wireEntity`),
// the workspace list grid (`makeListGrid`), and the read-only summary grid
// (`makeReadGrid`). The factories are created ONCE by app.js with a context
// object of its helpers (same names as before the extraction, so the moved
// bodies are unchanged), because they are deliberately coupled to the app's
// toast/message/modal conventions — only the construction seam is new.
// All grids now build on AG Grid Community (the `agGrid` script-tag global).

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

  // ===================== AG Grid migration helpers =========================
  // The grids are moving from Tabulator to AG Grid Community one factory at a
  // time. These helpers translate the app's existing Tabulator-shaped column
  // defs to AG Grid colDefs and emulate the small Tabulator cell/row surface the
  // formatters + edit handlers call, so the per-grid configs don't have to change.
  /* global agGrid */
  const _AG_THEME = "ag-theme-quartz";

  // A Tabulator-like `row` facade over an AG row node. Covers the imperative row
  // API the per-grid code calls: update() (merge a patch into the row data),
  // reformat() (re-run cell renderers for this row), delete() (drop the row).
  function _agRow(node, api, el) {
    return {
      getData: () => (node && node.data) || {},
      getElement: () => el || document.createElement("div"),
      getCell: (f) => ({ getElement: () => el || document.createElement("span"),
        getValue: () => ((node && node.data) || {})[f] }),
      update: (patch) => { if (node) node.setData({ ...node.data, ...patch }); },
      reformat: () => { if (api && node) api.refreshCells({ rowNodes: [node], force: true }); },
      delete: () => { if (api && node) api.applyTransaction({ remove: [node.data] }); },
    };
  }

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
      getRow: () => _agRow(params.node, params.api, rowEl()),
      restoreOldValue: () => { if (params.node) params.node.setDataValue(field, params.oldValue); },
      setValue: (v) => { if (params.node) params.node.setDataValue(field, v); },
    };
  }

  // ---- custom AG floating filters (Tabulator headerFilter parity) -----------
  // AG Community has no Set/dropdown filter, and its text filter only sees the
  // cell value (not the row), so columns that filtered against a *computed*
  // string (e.g. "Last, First (USTA …)") or did exact-match enum filtering need
  // bespoke components. These pairs (filter + floating UI) cover both cases.

  // values: ["a","b"] or { value: "Label" } (an "" key is treated as the
  // all/clear option). Returns [[value,label], …].
  function _valuePairs(values) {
    if (Array.isArray(values)) return values.map((v) => [String(v), String(v)]);
    return Object.keys(values || {}).map((k) => [k, String(values[k])]);
  }

  // Exact-match dropdown filter. `predicate(selected, _v, rowData)` overrides the
  // default `String(rowData[field]) === selected` when supplied (Tabulator's
  // headerFilterFunc), so gender/signed-in style virtual columns filter correctly.
  function _agListFilter(predicate, field) {
    const C = class {
      init(params) { this.params = params; this.sel = ""; this.gui = document.createElement("div");
        this.gui.className = "ag-filter-body-wrapper ag-custom-filter"; }
      getGui() { return this.gui; }
      isFilterActive() { return this.sel !== "" && this.sel != null; }
      doesFilterPass(p) {
        const data = p.node.data;
        if (predicate) return predicate(this.sel, data[field], data);
        return String(data[field] ?? "") === String(this.sel);
      }
      getModel() { return this.isFilterActive() ? { value: this.sel } : null; }
      setModel(m) { this.sel = m ? m.value : ""; }
      onFloating(v) { this.sel = v; this.params.filterChangedCallback(); }   // called by floating UI
    };
    C.__kind = "list";   // setHeaderFilterValue → model { value }
    return C;
  }
  function _agListFloating(values) {
    const pairs = _valuePairs(values);
    return class {
      init(params) {
        const sel = document.createElement("select");
        sel.className = "ag-floating-filter-input ag-list-floating";
        if (!pairs.some(([v]) => v === "")) sel.appendChild(new Option("All", ""));
        for (const [v, label] of pairs) sel.appendChild(new Option(label, v));
        sel.addEventListener("change", () => params.parentFilterInstance((inst) => inst.onFloating(sel.value)));
        this.eSelect = sel;
      }
      onParentModelChanged(model) { this.eSelect.value = model ? model.value : ""; }
      getGui() { return this.eSelect; }
    };
  }

  // Substring text filter that runs the column's headerFilterFunc against the
  // whole row (so the Player column can match name + USTA #, not just last_name).
  function _agTextFuncFilter(fn, field) {
    const C = class {
      init(params) { this.params = params; this.term = ""; }
      getGui() { const d = document.createElement("div"); d.className = "ag-filter-body-wrapper ag-custom-filter";
        const i = document.createElement("input"); i.type = "text"; i.className = "ag-input-field-input ag-text-field-input";
        i.value = this.term; i.addEventListener("input", () => { this.term = i.value; this.params.filterChangedCallback(); });
        d.appendChild(i); this.eInput = i; return d; }
      isFilterActive() { return !!this.term; }
      doesFilterPass(p) { const data = p.node.data; return fn(this.term, data[field], data); }
      getModel() { return this.term ? { term: this.term } : null; }
      setModel(m) { this.term = m ? m.term : ""; }
      onFloating(v) { this.term = v; this.params.filterChangedCallback(); }
      afterGuiAttached() { if (this.eInput) this.eInput.focus(); }
    };
    C.__kind = "textfunc";   // setHeaderFilterValue → model { term }
    return C;
  }
  function _agTextFuncFloating() {
    return class {
      init(params) {
        const i = document.createElement("input"); i.type = "text";
        i.className = "ag-input-field-input ag-text-field-input ag-floating-filter-input";
        i.addEventListener("input", () => params.parentFilterInstance((inst) => inst.onFloating(i.value)));
        this.eInput = i;
      }
      onParentModelChanged(model) { this.eInput.value = model ? model.term : ""; }
      getGui() { return this.eInput; }
    };
  }

  // Header cell rendered from a Tabulator titleFormatter (e.g. the inbox's
  // select-all checkbox). AG calls getGui() once; we render the formatter's node.
  function _agHeaderFromFormatter(fn) {
    return class {
      init() { this.e = document.createElement("div"); this.e.className = "ag-header-cell-custom";
        const out = fn(); if (out instanceof HTMLElement) this.e.appendChild(out); else this.e.innerHTML = out || ""; }
      getGui() { return this.e; }
      refresh() { return false; }
    };
  }

  // Typeahead cell editor for the rich `list` editors whose options are
  // { label, value } pairs (the inbox player/partner pickers — agSelectCellEditor
  // only handles plain string values). A filter input narrows a scrollable list;
  // picking commits the option's value (a player id). Options come from
  // cellEditorParams.values, resolved per-open like agSelect.
  function _agAutocompleteEditor() {
    return class {
      init(params) {
        this.params = params;
        const vals = params.values || [];
        this.opts = vals.map((v) => (v && typeof v === "object")
          ? { label: String(v.label), value: String(v.value) } : { label: String(v), value: String(v) });
        this.value = params.value == null ? "" : String(params.value);
        const wrap = document.createElement("div"); wrap.className = "ag-autocomplete-editor";
        const input = document.createElement("input"); input.type = "text";
        input.className = "ag-input-field-input"; input.placeholder = params.placeholderEmpty || "type to filter…";
        const list = document.createElement("div"); list.className = "ag-autocomplete-list";
        wrap.append(input, list);
        const cur = this.opts.find((o) => o.value === this.value); if (cur) input.value = cur.label;
        const render = () => {
          const q = input.value.trim().toLowerCase();
          list.innerHTML = "";
          if (params.clearable) { const c = document.createElement("div"); c.className = "ag-autocomplete-opt muted";
            c.textContent = "— clear —"; c.onmousedown = (e) => { e.preventDefault(); this.value = ""; params.stopEditing(); }; list.appendChild(c); }
          for (const o of (q ? this.opts.filter((o) => o.label.toLowerCase().includes(q)) : this.opts).slice(0, 50)) {
            const d = document.createElement("div"); d.className = "ag-autocomplete-opt"; d.textContent = o.label;
            d.onmousedown = (e) => { e.preventDefault(); this.value = o.value; params.stopEditing(); }; list.appendChild(d);
          }
        };
        input.addEventListener("input", render); render();
        this.wrap = wrap; this.input = input;
      }
      getGui() { return this.wrap; }
      afterGuiAttached() { this.input.focus(); this.input.select(); }
      getValue() { return this.value; }
      isPopup() { return true; }
    };
  }

  // Translate ONE Tabulator column def → an AG Grid colDef (or null to drop it,
  // e.g. the responsiveCollapse toggle, which AG Grid handles differently).
  function _toAgCol(col) {
    if (!col || col.formatter === "responsiveCollapse") return null;
    // Column GROUP (Tabulator nests via `columns`) → AG group colDef with children.
    if (Array.isArray(col.columns)) {
      const children = col.columns.map(_toAgCol).filter(Boolean);
      return { headerName: col.title != null ? col.title : "", marryChildren: true, children };
    }
    const cd = { headerName: col.title != null ? col.title : "" };
    if (col.field) cd.colId = col.field;
    if (col.field && !col.field.startsWith("_")) cd.field = col.field;
    if (col.width) cd.width = col.width;
    if (col.minWidth) cd.minWidth = col.minWidth;
    // widthGrow 0 / fixed width → no flex; else share leftover space (fitColumns).
    if (col.width || col.widthGrow === 0) cd.flex = 0; else cd.flex = col.widthGrow || 1;
    if (col.headerSort === false) cd.sortable = false;
    // initial sort: AG with getRowId set does delta updates and doesn't preserve
    // the rowData array order, so grids that want a deterministic default order
    // (e.g. by id) must declare it on the column.
    if (col.sort) cd.sort = col.sort;
    if (col.sortIndex != null) cd.sortIndex = col.sortIndex;
    if (col.resizable === false) cd.resizable = false;
    if (col.hozAlign) cd.cellStyle = { textAlign: col.hozAlign };
    if (col.cssClass) cd.cellClass = col.cssClass;
    if (col.frozen) cd.pinned = "left";
    if (col.field) cd.tooltipField = col.field;
    // titleFormatter → a custom header component (e.g. the inbox select-all box).
    if (typeof col.titleFormatter === "function") cd.headerComponent = _agHeaderFromFormatter(col.titleFormatter);
    // formatter → cellRenderer (may return a DOM node or an HTML string).
    if (typeof col.formatter === "function") {
      const fmt = col.formatter;
      cd.cellRenderer = (params) => { try { return fmt(_agCell(params)); } catch (_) { return ""; } };
    }
    // Composite editor: a display column backed by several DB fields (e.g. Name =
    // first+last, City/St = city+state). valueGetter feeds the editor the combined
    // text; valueSetter parses the typed value back into the underlying fields on
    // the row so the row-PUT persists them. Takes precedence over a plain editor.
    if (col.composite) {
      cd.editable = true;
      cd.cellClass = (cd.cellClass ? cd.cellClass + " " : "") + "editable-cell";
      cd.cellEditor = "agTextCellEditor";
      cd.valueGetter = (p) => (p.data ? col.composite.get(p.data) : "");
      cd.valueSetter = (p) => {
        if (!p.data) return false;
        const upd = col.composite.set(p.newValue, p.data);
        if (!upd) return false;
        Object.assign(p.data, upd);
        return true;
      };
    }
    // editor → editable + cellEditor (single-click edit is a grid option below).
    else if (col.editor) {
      cd.editable = true;
      cd.cellClass = (cd.cellClass ? cd.cellClass + " " : "") + "editable-cell";
      if (col.editor === "list") {
        // Rich label/value pickers (editorAutocomplete) use the typeahead editor;
        // plain enum lists use AG's built-in select.
        cd.cellEditor = col.editorAutocomplete ? _agAutocompleteEditor() : "agSelectCellEditor";
        cd.cellEditorPopup = !!col.editorAutocomplete;
        cd.cellEditorParams = (params) => {
          const ep = typeof col.editorParams === "function" ? col.editorParams(_agCell(params)) : (col.editorParams || {});
          let vals = ep.values || [];
          if (!Array.isArray(vals)) vals = Object.keys(vals);
          if (col.editorAutocomplete) return { values: vals, clearable: ep.clearable, placeholderEmpty: ep.placeholderEmpty };
          // agSelectCellEditor only renders plain string options; for { label, value }
          // option objects pass just the values (labels are shown via valueFormatter).
          const objOpts = vals.length && typeof vals[0] === "object";
          return { values: objOpts ? vals.map((v) => String(v.value)) : vals.map((v) => String(v)) };
        };
        // Static { label, value } option set → show the labels in the select's
        // dropdown via a valueFormatter (the cell itself keeps its own cellRenderer).
        const _ep = typeof col.editorParams !== "function" ? col.editorParams : null;
        if (!col.editorAutocomplete && _ep && Array.isArray(_ep.values)
            && _ep.values.length && typeof _ep.values[0] === "object") {
          const _lab = Object.fromEntries(_ep.values.map((v) => [String(v.value), String(v.label)]));
          cd.valueFormatter = (p) => (p.value == null || p.value === "" ? "" : (_lab[String(p.value)] ?? String(p.value)));
        }
      } else if (col.editor === "date") {
        cd.cellEditor = "agDateStringCellEditor";
      } else {
        cd.cellEditor = "agTextCellEditor";
      }
    }
    // header filter — `list` → exact-match dropdown; `input` with a custom
    // headerFilterFunc → whole-row substring filter; plain `input` → built-in
    // text filter. Floating (always-visible in the header) in every case.
    if (col.headerFilter) {
      if (col.headerFilter === "list") {
        const vals = (col.headerFilterParams && col.headerFilterParams.values) || [];
        cd.filter = _agListFilter(col.headerFilterFunc, col.field);
        cd.floatingFilterComponent = _agListFloating(vals);
      } else if (typeof col.headerFilterFunc === "function") {
        cd.filter = _agTextFuncFilter(col.headerFilterFunc, col.field);
        cd.floatingFilterComponent = _agTextFuncFloating();
      } else {
        cd.filter = "agTextColumnFilter";
      }
      cd.floatingFilter = true;
      // The inline floating control IS the filter UI (like Tabulator) — hide AG's
      // funnel button that would otherwise sit beside every column's filter and
      // eat the width the dropdown/input needs.
      cd.suppressFloatingFilterButton = true;
    }
    // cellClick → onCellClicked (e.g. the roster's signed-in toggle column).
    if (typeof col.cellClick === "function") {
      cd.onCellClicked = (params) => { try { col.cellClick(params.event, _agCell(params)); } catch (_) {} };
    }
    return cd;
  }

  // Mobile responsive-collapse popup: AG Community has no row-expander, so the ▸
  // button opens a small panel listing the columns hidden at the current width.
  function _showCollapsePopup(anchorEl, rowData, meta) {
    document.querySelectorAll(".ag-collapse-popup").forEach((p) => p.remove());
    const pop = document.createElement("div"); pop.className = "ag-collapse-popup";
    for (const m of meta) {
      let v; try { v = m.value(rowData); } catch (_) { v = ""; }
      if (v == null || v === "") continue;
      const row = document.createElement("div"); row.className = "ag-collapse-row";
      const k = document.createElement("span"); k.className = "ag-collapse-key"; k.textContent = m.headerName;
      const val = document.createElement("span"); val.className = "ag-collapse-val";
      if (v instanceof HTMLElement) val.appendChild(v); else val.innerHTML = String(v);
      row.append(k, val); pop.appendChild(row);
    }
    if (!pop.childElementCount) { const e = document.createElement("div"); e.className = "ag-collapse-row muted"; e.textContent = "No additional fields"; pop.appendChild(e); }
    document.body.appendChild(pop);
    const r = anchorEl.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + "px";
    pop.style.top = (r.bottom + 4) + "px";
    const close = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchorEl) { pop.remove(); document.removeEventListener("click", close, true); } };
    setTimeout(() => document.addEventListener("click", close, true), 0);
  }

  // Create an AG Grid and return a small Tabulator-compatible facade
  // ({ setData, getData, getRows, on, download, redraw, api }). `tabOpts` is the
  // existing Tabulator options object; only the bits the app uses are honored.
  function _makeAgGrid(mount, tabOpts) {
    mount.classList.add(_AG_THEME);
    const colDefs = (tabOpts.columns || []).map(_toAgCol).filter(Boolean);
    // Responsive-collapse: columns that opted into a Tabulator responsive priority
    // (>=1) hide below a breakpoint; a ▸ expander reveals their values in a popup.
    // Highest priority collapses first (listed first in the popup). responsive:0
    // and unmarked columns stay visible. Grids opt out with responsive:false.
    const _collapseMeta = tabOpts.responsive === false ? [] : (tabOpts.columns || [])
      .filter((c) => typeof c.responsive === "number" && c.responsive >= 1 && c.field && !c.columns)
      .sort((a, b) => b.responsive - a.responsive)
      .map((c) => ({ colId: c.field, headerName: c.title || c.field,
        value: (data) => { try { return c.formatter ? c.formatter(_agCell({ data, value: data[c.field], colDef: { field: c.field } })) : (data[c.field] ?? ""); } catch (_) { return data[c.field] ?? ""; } } }));
    if (_collapseMeta.length) {
      colDefs.unshift({
        colId: "_expand", pinned: "left", width: 36, minWidth: 36, sortable: false, filter: false,
        resizable: false, hide: true, headerName: "", cellClass: "rcollapse-col",
        cellRenderer: (params) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "btn-icon rcollapse-toggle";
          b.textContent = "▸"; b.title = "Show more"; b.setAttribute("aria-label", "Show hidden fields");
          b.addEventListener("click", (ev) => { ev.stopPropagation(); _showCollapsePopup(b, params.data, _collapseMeta); });
          return b;
        },
      });
    }
    const handlers = {};   // event name -> [fns] (Tabulator-style .on)
    let api = null;
    let extFilter = null;  // Tabulator-style setFilter(fn) → AG external filter
    const opts = {
      columnDefs: colDefs,
      rowData: [],
      isExternalFilterPresent: () => !!extFilter,
      doesExternalFilterPass: (node) => !extFilter || extFilter(node.data),
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
      onSortChanged: () => {
        // Sort persistence (Tabulator's persistence:{sort:true}): remember the
        // active sort per grid across reloads.
        if (tabOpts.persistKey && api) {
          try {
            const st = api.getColumnState().filter((c) => c.sort)
              .map((c) => ({ colId: c.colId, sort: c.sort, sortIndex: c.sortIndex }));
            localStorage.setItem(tabOpts.persistKey, JSON.stringify(st));
          } catch (_) {}
        }
        (handlers.dataSorted || []).forEach((fn) => fn());
      },
      onGridReady: (e) => { api = e.api; _restoreSort(); (handlers.tableBuilt || []).forEach((fn) => fn()); },
      // Also restore once rows first render — a grid created inside a hidden tab
      // defers layout, so applyColumnState at onGridReady can be dropped; reapply
      // when it actually renders. Idempotent, so running in both hooks is safe.
      onFirstDataRendered: () => _restoreSort(),
    };
    // Restore the persisted sort (Tabulator's persistence:{sort:true}).
    function _restoreSort() {
      if (!tabOpts.persistKey || !api) return;
      try {
        const saved = JSON.parse(localStorage.getItem(tabOpts.persistKey) || "null");
        if (Array.isArray(saved) && saved.length) api.applyColumnState({ state: saved, defaultState: { sort: null } });
      } catch (_) {}
    }
    if (tabOpts.rowClassRules) opts.rowClassRules = tabOpts.rowClassRules;
    api = agGrid.createGrid(mount, opts);
    mount.__agApi = api;   // debug/test hook (read model row count without DOM)
    // Toggle the collapse on/off at the mobile breakpoint: hide the collapsible
    // columns + show the ▸ expander on narrow screens, reverse on wide.
    if (_collapseMeta.length) {
      const ids = _collapseMeta.map((m) => m.colId);
      const mq = window.matchMedia("(max-width: 760px)");
      const applyCollapse = () => {
        if (!api) return;
        api.setColumnsVisible(ids, !mq.matches);
        api.setColumnsVisible(["_expand"], mq.matches);
      };
      applyCollapse();
      mq.addEventListener("change", applyCollapse);
    }
    const activeRows = () => { const out = []; if (api) api.forEachNodeAfterFilterAndSort((n) => out.push(n)); return out; };
    return {
      api,
      initialized: true,
      on: (evt, fn) => { (handlers[evt] ||= []).push(fn); },
      setData: (rows) => api && api.setGridOption("rowData", rows || []),
      replaceData: (rows) => api && api.setGridOption("rowData", rows || []),
      getData: (which) => which === "active" ? activeRows().map((n) => n.data) : (() => { const o = []; api.forEachNode((n) => o.push(n.data)); return o; })(),
      getRows: (which) => (which === "active" ? activeRows() : (() => { const o = []; api.forEachNode((n) => o.push(n)); return o; })())
        .map((n) => _agRow(n, api)),
      getRow: (id) => { const n = api.getRowNode(String(id)); return n ? _agRow(n, api) : null; },
      setFilter: (fn) => { extFilter = fn || null; if (api) api.onFilterChanged(); },
      // Programmatically set a column header filter (inbox default-scoping to the
      // active tournament + status=new). The model shape depends on the filter:
      // our custom list/text-func use { value }/{ term }; AG's text filter uses
      // its own contains model.
      setHeaderFilterValue: (field, value) => {
        if (!api) return;
        const col = api.getColumn(field); if (!col) return;
        const f = col.getColDef().filter;
        const v = value == null ? "" : String(value);
        let model = null;
        if (v !== "") {
          if (f && f.__kind === "list") model = { value: v };
          else if (f && f.__kind === "textfunc") model = { term: v };
          else if (f === "agTextColumnFilter") model = { filterType: "text", type: "contains", filter: v };
          else model = { value: v };
        }
        Promise.resolve(api.setColumnFilterModel(field, model)).then(() => api.onFilterChanged());
      },
      redraw: () => api && api.refreshCells({ force: true }),
      // Re-apply the selection rowClassRules to the *rendered* rows by hand rather
      // than calling api.redrawRows() — redrawRows destroys + recreates the row
      // DOM, which rips out an in-progress single-click cell editor (the row-click
      // selection handler fires on the same click that opens the editor, so the
      // redraw would immediately revert the cell to read-only). Off-screen rows
      // still get the class from rowClassRules when they virtualize in.
      redrawRows: () => {
        if (!api) return;
        const rules = tabOpts.rowClassRules;
        if (!rules) return;
        api.forEachNode((node) => {
          const id = String(node.id);
          const sel = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
          mount.querySelectorAll('.ag-row[row-id="' + sel + '"]').forEach((el) => {
            for (const cls in rules) { try { el.classList.toggle(cls, !!rules[cls]({ data: node.data, node })); } catch (_) {} }
          });
        });
      },
      scrollToRow: (id) => { const n = api && api.getRowNode(String(id)); if (n) api.ensureNodeVisible(n); },
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
      // Sort persistence across reloads (Tabulator's persistence:{sort:true}).
      // makeListGrid has no persist opt-out (unlike makeReadGrid), so always set it.
      persistKey: "courtops-ag-sort-" + tableId,
    });
    const _onBuilt = () => { built = true; if (pending) { grid.setData(pending); pending = null; } };
    grid.on("tableBuilt", _onBuilt);
    if (grid.initialized) _onBuilt();  // covers sync-fire race
    if (onCellEdited) grid.on("cellEdited", onCellEdited);
    if (panelId) (GRIDS[panelId] ||= []).push(grid);
    return { setData: (rows) => { if (built) grid.setData(rows); else pending = rows; } };
  }

  // AG Grid version of makeReadGrid (summaries / reference tables). Same return
  // shape { grid, setData, setFilter } so consumers don't change.
  function _makeReadGridAg(tableId, columns, exportName, placeholder, opts) {
    const tableEl = document.getElementById(tableId);
    const panelId = tableEl.closest(".panel")?.id;
    const mount = document.createElement("div"); mount.className = "grid-mount";
    if (opts.compact) mount.classList.add("grid-mount--compact");
    mount.style.height = mount.style.height || (opts.maxHeight || "55vh");
    tableEl.parentElement.insertBefore(mount, tableEl); tableEl.remove();
    const grid = _makeAgGrid(mount, {
      placeholder, columns,
      ...(opts.index ? { index: opts.index } : {}),
      ...(opts.editable ? { editTriggerEvent: opts.editable === true ? "click" : opts.editable } : {}),
      // rowClassRules replaces Tabulator's rowFormatter for row-level styling
      // (e.g. multi-select tint by set membership); re-applied via grid.redraw().
      ...(opts.rowClassRules ? { rowClassRules: opts.rowClassRules } : {}),
    });
    if (exportName) {
      const csv = document.createElement("button");
      csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
      csv.addEventListener("click", () => grid.download("csv", exportName + ".csv"));
      mount.parentElement.insertBefore(csv, mount);
    }
    let built = false, pending = null, pendingFilter = null;
    const _onBuilt = () => { built = true;
      if (pending) { grid.setData(pending); pending = null; }
      if (pendingFilter) { grid.setFilter(pendingFilter); pendingFilter = null; } };
    grid.on("tableBuilt", _onBuilt);
    if (grid.initialized) _onBuilt();
    if (opts.onCellEdited) grid.on("cellEdited", (cell) => opts.onCellEdited(cell));
    if (panelId) (GRIDS[panelId] ||= []).push(grid);
    return {
      grid,
      setData: (rows) => { if (built) { grid.setData(rows); requestAnimationFrame(() => grid.redraw()); } else pending = rows; },
      setFilter: (fn) => { if (built) grid.setFilter(fn); else pendingFilter = fn; },
    };
  }

  // Read-only list (summaries / reference tables): sortable + optional CSV, no
  // row actions. AG Grid by default; pass opts.engine === "tabulator" to keep the
  // legacy Tabulator path (the inbox + event-sites grids, pending migration).
  // Returns { grid, setData, setFilter }.
  function makeReadGrid(tableId, columns, exportName, placeholder, opts = {}) {
    return _makeReadGridAg(tableId, columns, exportName, placeholder, opts);
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
      if (c.key === "id") { col.width = 64; col.widthGrow = 0; col.sort = "asc"; }
      if (c.edit) {
        col.editor = c.edit.editor;
        if (c.edit.params) col.editorParams = c.edit.params;
        if (c.edit.composite) col.composite = c.edit.composite;  // multi-field inline edit
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

    mount.style.height = mount.style.height || "calc(100vh - 16rem)";
    const table = _makeAgGrid(mount, {
      index: "id", editTriggerEvent: "click",
      placeholder: `No ${cfg.singular}s yet — use the form to add one.`,
      columns,
      // selected-row highlight via a class rule (re-evaluated on redrawRows()),
      // since AG has no per-row imperative element access like Tabulator.
      rowClassRules: { "row-selected": (p) => p.data && p.data.id === selectedId },
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
    table.on("dataSorted", () => { markRows(); updateNav(); });   // AG sets aria-sort natively
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

    function markRows() {  // highlight the selected row (rowClassRules + redraw)
      if (!built) return;
      try { table.redrawRows(); } catch (_) {}
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

  // makeGrid exposes the AG facade for the few direct grids app.js still builds
  // itself (roster, import preview, …) so they don't hand-roll `new Tabulator`.
  return { wireEntity, makeListGrid, makeReadGrid, makeGrid: _makeAgGrid, _autoHeaderFilters };
}
