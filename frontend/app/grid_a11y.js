// Grid accessibility helpers (D11 slice from app.js).
// AG Grid Community header DOM (the app no longer mounts Tabulator).
//
// floatingFilter:true puts the title in the column-header row and the control
// in a sibling floating-filter row. Both cells share `col-id`; they are NOT
// the same .ag-header-cell (that was Tabulator's header-filter layout).

export const AG_COL = ".ag-header-cell";
export const AG_TITLE = ".ag-header-cell-text";
export const AG_FILTER =
  ".ag-floating-filter-input, .ag-list-floating, input, select";
export const AG_COL_FIELD_ATTR = "col-id";

function headerRoot(table) {
  if (!table) return null;
  if (table.element && typeof table.element.querySelectorAll === "function") return table.element;
  if (typeof table.querySelectorAll === "function") return table;
  return null;
}

function colId(col) {
  return col && typeof col.getAttribute === "function"
    ? col.getAttribute(AG_COL_FIELD_ATTR) : null;
}

/** Title text from the column-header row, keyed by col-id. */
function titlesByColId(root) {
  const titles = new Map();
  root.querySelectorAll(`${AG_COL}[${AG_COL_FIELD_ATTR}]`).forEach((col) => {
    const field = colId(col);
    const title = col.querySelector(AG_TITLE)?.textContent?.trim();
    if (field && title) titles.set(field, title);
  });
  return titles;
}

/** Tag header-filter inputs with per-column aria-label ("Filter Name").
 *  Pairs the title cell with the floating-filter cell by shared col-id. */
export function labelHeaderFilters(table) {
  const root = headerRoot(table);
  if (!root) return;
  const titles = titlesByColId(root);
  root.querySelectorAll(`${AG_COL}[${AG_COL_FIELD_ATTR}]`).forEach((col) => {
    const title = titles.get(colId(col));
    const filter = col.querySelector(AG_FILTER);
    if (title && filter && !filter.hasAttribute("aria-label")) {
      filter.setAttribute("aria-label", `Filter ${title}`);
    }
  });
}

export function sortAriaValue(dir) {
  return dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none";
}

/** Reflect current sort direction into aria-sort on column-header cells
 *  (the title row — not the floating-filter row). */
export function reflectAriaSort(table) {
  const root = headerRoot(table);
  if (!root) return;
  const sorters = (typeof table.getSorters === "function") ? table.getSorters() : [];
  const active = new Map(sorters.map((s) => [s.field, s.dir]));
  root.querySelectorAll(`${AG_COL}[${AG_COL_FIELD_ATTR}]`).forEach((col) => {
    const field = colId(col);
    if (!field || String(field).startsWith("_")) return;
    if (!col.querySelector(AG_TITLE)) return;
    const dir = active.get(field);
    col.setAttribute("aria-sort", sortAriaValue(dir));
  });
}
