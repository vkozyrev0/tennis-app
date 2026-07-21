// Remaining table CSV scrapes + per-page export button wiring — D11.

export function installExportWiring(ctx) {
  const {
    csvDownload, rosterGrid, rosterSignInExport, rosterSignInTemplate,
    reportCsvExport, reportTemplateExport,
    getCoverageMin, setCoverageMin, renderCoverage,
  } = ctx;

  // =================== Generic CSV export for list tables ===================
  // csvDownload from createCsvExport (./app/export_csv.js — H4.1/H4.2 gate).
  // Visible column headers (skipping the trailing actions/blank column).
  function _visibleHeaders(table) {
    const ths = [...table.querySelectorAll("thead th")];
    const keep = ths.map((th) => th.textContent.trim() !== "");
    return { keep, headers: ths.filter((_, i) => keep[i]).map((th) => th.textContent.trim()) };
  }
  function exportTable(table, name) {
    const { keep, headers } = _visibleHeaders(table);
    const rows = [...table.querySelectorAll("tbody tr")]
      .filter((tr) => !tr.querySelector(".empty"))
      .map((tr) => [...tr.children].filter((_, i) => keep[i]).map((td) => td.textContent.replace(/\s+/g, " ").trim()));
    csvDownload([headers, ...rows], name);
  }
  // --- Per-page CSV export for the remaining hand-built tables ---
  // Every list/summary is now a Tabulator grid with its own native ⬇ CSV; only the
  // Inbox (interactive per-row controls) stays a plain table and scrapes for CSV.
  const EXPORTABLE = {
    "inbox-table": "inbox",
  };
  for (const [id, name] of Object.entries(EXPORTABLE)) {
    const table = document.getElementById(id);
    if (!table) continue;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "export-btn no-print"; btn.textContent = "⬇ CSV";
    btn.addEventListener("click", () => exportTable(table, name));
    const anchor = table.closest(".tbl-scroll") || table;  // keep the button outside the scroller
    anchor.parentNode.insertBefore(btn, anchor);
  }
  // Bespoke per-page exports (data isn't a plain table scrape).
  document.getElementById("roster-csv").addEventListener("click", () => rosterGrid.download("csv", "roster.csv"));
  document.getElementById("roster-signin-csv").addEventListener("click", rosterSignInExport);
  // Import/export #5: wire the previously-orphan template helper.
  document.getElementById("roster-signin-template").addEventListener("click", rosterSignInTemplate);
  // tshirt-order-csv wired inside createTshirtsPanel (D11)
  document.getElementById("report-csv").addEventListener("click", reportCsvExport);
  // Design-crit pass 6: wire the previously-orphan reportTemplateExport.
  document.getElementById("report-template").addEventListener("click", reportTemplateExport);
  // Thin-coverage threshold: re-highlight the coverage tables from memory (no
  // refetch) when the TD changes the minimum, and persist their choice.
  (() => {
    const inp = document.getElementById("report-min-cov");
    if (!inp) return;
    inp.value = getCoverageMin();
    inp.addEventListener("input", () => {
      setCoverageMin(inp.value);
    });
  })();
}
