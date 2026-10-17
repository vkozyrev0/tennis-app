// Per-page CSV export buttons + coverage-min wiring — D11.

export function installExportWiring(ctx) {
  const {
    rosterCsvExport, rosterSignInExport, rosterSignInTemplate,
    reportCsvExport, reportTemplateExport,
    getCoverageMin, setCoverageMin,
  } = ctx;

  // Bespoke per-page exports. The grids each carry their own gated ⬇ CSV button;
  // the old plain-table scrape path was unreachable after the AG Grid migration.
  document.getElementById("roster-csv").addEventListener("click", () => rosterCsvExport());
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
