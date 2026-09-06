// DOM-free tests for AG Grid a11y helpers (shipped grid_a11y.js).
// Run: node frontend/app/grid_a11y.test.mjs
import assert from "node:assert/strict";
import {
  AG_COL, AG_TITLE, AG_FILTER, AG_COL_FIELD_ATTR,
  labelHeaderFilters, reflectAriaSort, sortAriaValue,
} from "./grid_a11y.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function filterControl() {
  const attrs = {};
  return {
    hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
    setAttribute: (k, v) => { attrs[k] = String(v); },
    getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    _attrs: attrs,
  };
}

function agColumn({ title, field, filter }) {
  const attrs = { [AG_COL_FIELD_ATTR]: field };
  const titleEl = { textContent: title };
  return {
    querySelector(sel) {
      if (sel === AG_TITLE) return titleEl;
      if (sel === AG_FILTER) return filter;
      return null;
    },
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => { attrs[k] = String(v); },
    _attrs: attrs,
  };
}

function rootWith(selector, cols) {
  return {
    querySelectorAll(sel) {
      if (sel === selector || sel === `${AG_COL}[${AG_COL_FIELD_ATTR}]`) return cols;
      if (sel.includes("tabulator")) return [];
      return [];
    },
  };
}

test("selectors target AG Grid, not Tabulator", () => {
  assert.ok(AG_COL.includes("ag-header-cell"));
  assert.ok(!AG_COL.includes("tabulator"));
  assert.ok(AG_TITLE.includes("ag-header-cell-text"));
  assert.ok(AG_FILTER.includes("ag-floating-filter") || AG_FILTER.includes("ag-list-floating"));
  assert.equal(AG_COL_FIELD_ATTR, "col-id");
});

test("AG Grid header filter gets aria-label from column title", () => {
  const filter = filterControl();
  const col = agColumn({ title: "Player", field: "last_name", filter });
  labelHeaderFilters({ element: rootWith(AG_COL, [col]) });
  assert.equal(filter.getAttribute("aria-label"), "Filter Player");
});

test("Tabulator-only fixture is NOT labeled", () => {
  const filter = filterControl();
  const tabCol = {
    querySelector(sel) {
      if (sel.includes("tabulator-col-title")) return { textContent: "Name" };
      if (sel.includes("tabulator-header-filter")) return filter;
      return null;
    },
  };
  const tabRoot = {
    querySelectorAll(sel) {
      if (String(sel).includes("tabulator")) return [tabCol];
      return [];
    },
  };
  labelHeaderFilters({ element: tabRoot });
  assert.equal(filter.hasAttribute("aria-label"), false);
});

test("sortAriaValue maps asc/desc/none", () => {
  assert.equal(sortAriaValue("asc"), "ascending");
  assert.equal(sortAriaValue("desc"), "descending");
  assert.equal(sortAriaValue(undefined), "none");
});

test("reflectAriaSort sets aria-sort on AG header cells", () => {
  const col = agColumn({ title: "Player", field: "last_name", filter: filterControl() });
  const table = {
    element: rootWith(`${AG_COL}[${AG_COL_FIELD_ATTR}]`, [col]),
    getSorters: () => [{ field: "last_name", dir: "asc" }],
  };
  reflectAriaSort(table);
  assert.equal(col._attrs["aria-sort"], "ascending");
});

console.log(`\n${passed} grid_a11y checks passed`);
