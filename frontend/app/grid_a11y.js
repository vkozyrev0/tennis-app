// Grid accessibility helpers (D11 slice from app.js).
// AG Grid Community header DOM (the app no longer mounts Tabulator).

export const AG_COL = ".ag-header-cell";
export const AG_TITLE = ".ag-header-cell-text";
export const AG_FILTER =
  ".ag-floating-filter-input, .ag-list-floating, .ag-header-cell input, .ag-header-cell select";
export const AG_COL_FIELD_ATTR = "col-id";

function headerRoot(table) {
  if (!table) return null;
  if (table.element && typeof table.element.querySelectorAll === "function") return table.element;
  if (typeof table.querySelectorAll === "function") return table;
  return null;
}

/** Tag header-filter inputs with per-column aria-label ("Filter Name"). */
export function labelHeaderFilters(table) {
  const root = headerRoot(table);
  if (!root) return;
  root.querySelectorAll(AG_COL).forEach((col) => {
    const title = col.querySelector(AG_TITLE)?.textContent?.trim();
    const filter = col.querySelector(AG_FILTER);
    if (title && filter && !filter.hasAttribute("aria-label")) {
      filter.setAttribute("aria-label", `Filter ${title}`);
    }
  });
}

export function sortAriaValue(dir) {
  return dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
}

/** Reflect current sort direction into aria-sort on column headers. */
export function reflectAriaSort(table) {
  const root = headerRoot(table);
  if (!root) return;
  const sorters = (typeof table.getSorters === "function") ? table.getSorters() : [];
  const active = new Map(sorters.map((s) => [s.field, s.dir]));
  root.querySelectorAll(`${AG_COL}[${AG_COL_FIELD_ATTR}]`).forEach((col) => {
    const field = col.getAttribute(AG_COL_FIELD_ATTR);
    if (!field || String(field).startsWith("_")) return;
    const dir = active.get(field);
    col.setAttribute("aria-sort", sortAriaValue(dir));
  });
}
