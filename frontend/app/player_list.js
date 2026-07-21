// Generic player-keyed Part B list factory (plan P2 #11d) — extracted from
// app.js. The scheduling-avoidance / division-flex / player-hotel lists are all
// the same shape: a player-ref form + a Tabulator table + delete + in-grid edit
// + file-from-email. wirePlayerList builds one from a cfg.
//
// Sibling of grids.js but kept separate because it's created LATE (at the point
// of use, after `active` / expandPlayerRef / loadInbox exist), whereas
// createGridFactories runs at module top. Dependency-injected like grids.js;
// `active` is read through getActive() since it's a reassigned module global.
export function createPlayerList(ctx) {
  const {
    api, setMsg, confirmDialog, markInvalid, formObj, _csvDownload,
    _autoHeaderFilters, GRIDS, expandPlayerRef, getActive, loadInbox, makeGrid,
  } = ctx;

  return function wirePlayerList(cfg) {
    const form = document.getElementById(cfg.formId);
    // Replace the static <table> with a Tabulator mount (don't wipe the parent card).
    const tableEl = document.getElementById(cfg.tableId);
    const panelId = tableEl.closest(".panel")?.id;  // for redraw-on-tab-show
    const mount = document.createElement("div"); mount.className = "grid-mount";
    tableEl.parentElement.insertBefore(mount, tableEl);
    tableEl.remove();
    const csv = document.createElement("button");
    csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
    // Import/export #3: same exportCols pattern as wireEntity — CSV includes
    // every field the matching importer can read back, not just visible cols.
    csv.addEventListener("click", async () => {
      // H4.1/H4.2: route through _csvDownload (audit + PII gate).
      if (cfg.exportCols && cfg.exportCols.length) {
        const headers = cfg.exportCols.map((c) => c.header);
        const rows = table.getData("active").map((r) =>
          cfg.exportCols.map((c) => (c.fmt ? c.fmt(r) : r[c.key])));
        await _csvDownload([headers, ...rows], cfg.exportName, { resource: cfg.exportName });
      } else {
        const colDefs = (cfg.columns || []).filter(
          (c) => c.field && c.field !== "_act" && !String(c.field).startsWith("_"));
        const headers = colDefs.map((c) => c.title || c.field);
        const rows = table.getData("active").map((r) => colDefs.map((c) => r[c.field]));
        await _csvDownload([headers, ...rows], cfg.exportName, { resource: cfg.exportName });
      }
    });
    mount.parentElement.insertBefore(csv, mount);

    const columns = cfg.columns.slice();
    columns.push({
      title: "", field: "_act", headerSort: false, widthGrow: 0, width: 48, cssClass: "grid-actions-cell",
      formatter: (cell) => {
        const r = cell.getData();
        const wrap = document.createElement("div"); wrap.className = "grid-actions";
        const del = document.createElement("button"); del.type = "button"; del.className = "btn-icon danger"; del.textContent = "✕";
        del.title = "Delete"; del.setAttribute("aria-label", "Delete");
        del.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          if (!(await confirmDialog("Delete?"))) return;
          try { await api(`${cfg.del}/${r.id}`, { method: "DELETE" }); load(); }
          catch (e) { setMsg(cfg.msgId, e.message, false); }
        });
        wrap.append(del); return wrap;
      },
    });
    let built = false, pending = null;
    mount.style.height = "55vh";
    const table = makeGrid(mount, {
      index: "id", placeholder: cfg.empty, editTriggerEvent: "click",  // single click opens the cell editor (where set)
      columnDefaults: { tooltip: true }, columns: _autoHeaderFilters(columns),
    });
    const _onBuilt = () => { built = true; if (pending) { table.setData(pending); pending = null; } };
    table.on("tableBuilt", _onBuilt);
    // _onBuilt only touches locals declared above (no module-const TDZ risk), so
    // the sync-init replay is safe to run inline.
    if (table.initialized) _onBuilt();  // covers AG's synchronous init
    // In-grid edit: PUT only the editable fields (cfg.editFields maps field→true);
    // identity columns (player/usta) stay read-only.
    if (cfg.editFields) table.on("cellEdited", async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const r = cell.getData();
      const body = {}; for (const f of Object.keys(cfg.editFields)) body[f] = r[f] || null;
      try { await api(`${cfg.del}/${r.id}`, { method: "PUT", body: JSON.stringify(body) }); setMsg(cfg.msgId, "saved", true); load(); if (cfg.after) cfg.after(); }
      catch (e) { setMsg(cfg.msgId, e.message, false); try { cell.restoreOldValue(); } catch (_) {} load(); }
    });
    if (panelId) (GRIDS[panelId] ||= []).push(table);

    async function load() {
      const active = getActive();
      if (!active) return;
      const rows = await api(`/tournaments/${active.id}${cfg.path}`);
      if (built) await table.setData(rows); else pending = rows;
      if (cfg.after) cfg.after();
    }
    function reset() { form.reset(); form.source_email_id.value = ""; }
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); const active = getActive(); if (!active) return;
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      const b = expandPlayerRef(formObj(form)); b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
      try { await api(`/tournaments/${active.id}${cfg.path}`, { method: "POST", body: JSON.stringify(b) }); setMsg(cfg.msgId, "added", true); reset(); load(); loadInbox(); }
      catch (err) { setMsg(cfg.msgId, err.message, false); markInvalid(form, err.message); }
      finally { btn.disabled = false; }
    });
    form.querySelector(".cancel").addEventListener("click", reset);
    return { load };
  };
}
