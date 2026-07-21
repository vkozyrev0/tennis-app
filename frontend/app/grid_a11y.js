// Grid accessibility helpers (D11 slice from app.js).
// Originally written for Tabulator; still used where AG facade exposes the
// same header-filter / sorter surface.

/** Tag header-filter inputs with per-column aria-label ("Filter Name"). */
export function labelHeaderFilters(table) {
  if (!table || !table.element) return;
  table.element.querySelectorAll(".tabulator-col").forEach((col) => {
    const title = col.querySelector(".tabulator-col-title")?.textContent?.trim();
    const filter = col.querySelector(
      ".tabulator-header-filter input, .tabulator-header-filter select",
    );
    if (title && filter && !filter.hasAttribute("aria-label")) {
      filter.setAttribute("aria-label", `Filter ${title}`);
    }
  });
}

/** Reflect current sort direction into aria-sort on column headers. */
export function reflectAriaSort(table) {
  if (!table || !table.element) return;
  const sorters = (typeof table.getSorters === "function") ? table.getSorters() : [];
  const active = new Map(sorters.map((s) => [s.field, s.dir]));
  table.element.querySelectorAll(".tabulator-col[tabulator-field]").forEach((col) => {
    const field = col.getAttribute("tabulator-field");
    if (!field) return;
    const dir = active.get(field);
    col.setAttribute(
      "aria-sort",
      dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none",
    );
  });
}
