// DOM-free tests for AG Grid a11y helpers (shipped grid_a11y.js).
// Run: node frontend/app/grid_a11y.test.mjs
//
// The AG Grid fixture is TWO sibling cells that share col-id: a title cell
// in the column-header row and a floating-filter cell in the next row.
// A same-cell (Tabulator-shaped) fixture is not the real path and must not
// be the only case that passes.
import assert from "node:assert/strict";
import {
  AG_COL, AG_TITLE, AG_FILTER, AG_COL_FIELD_ATTR,
  labelHeaderFilters, reflectAriaSort, sortAriaValue,
} from "./grid_a11y.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function matchesSimple(node, sel) {
  sel = sel.trim();
  if (sel.includes(" ")) return false;
  let attr = null;
  const bracket = sel.indexOf("[");
  if (bracket >= 0) {
    attr = sel.slice(bracket + 1, sel.indexOf("]"));
    sel = sel.slice(0, bracket);
  }
  let tag = null;
  let classes = [];
  if (sel.startsWith(".")) {
    classes = sel.split(".").filter(Boolean);
  } else if (sel) {
    const bits = sel.split(".");
    tag = bits[0].toLowerCase();
    classes = bits.slice(1);
  }
  if (tag && (node.tagName || "").toLowerCase() !== tag) return false;
  const cls = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
  if (classes.some((c) => !cls.has(c))) return false;
  if (attr && node.getAttribute(attr) == null) return false;
  return true;
}

function descendants(node, acc = []) {
  for (const c of node.children || []) {
    acc.push(c);
    descendants(c, acc);
  }
  return acc;
}

function el(tag, className, attrs = {}, children = []) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: className || "",
    children,
    _attrs: { ...attrs },
    textContent: attrs.textContent != null ? String(attrs.textContent) : "",
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const groups = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
      return descendants(this).filter((n) => groups.some((g) => matchesSimple(n, g)));
    },
  };
  if (attrs.textContent != null) delete node._attrs.textContent;
  return node;
}

/** AG Grid floatingFilter:true header: title row + sibling filter row, same col-id. */
function agTwoRowHeader({ title, field }) {
  const titleText = el("span", "ag-header-cell-text", { textContent: title });
  const titleCell = el("div", "ag-header-cell", { [AG_COL_FIELD_ATTR]: field }, [titleText]);
  const input = el("input", "ag-floating-filter-input ag-input-field-input");
  const filterCell = el("div", "ag-header-cell ag-floating-filter", { [AG_COL_FIELD_ATTR]: field }, [input]);
  const titleRow = el("div", "ag-header-row ag-header-row-column", {}, [titleCell]);
  const filterRow = el("div", "ag-header-row ag-header-row-column-filter", {}, [filterCell]);
  const header = el("div", "ag-header", {}, [titleRow, filterRow]);
  const root = el("div", "ag-theme-quartz", {}, [header]);
  return { root, titleCell, filterCell, input };
}

test("selectors target AG Grid, not Tabulator", () => {
  assert.ok(AG_COL.includes("ag-header-cell"));
  assert.ok(!AG_COL.includes("tabulator"));
  assert.ok(AG_TITLE.includes("ag-header-cell-text"));
  assert.ok(AG_FILTER.includes("ag-floating-filter") || AG_FILTER.includes("ag-list-floating"));
  assert.equal(AG_COL_FIELD_ATTR, "col-id");
});

test("two-row AG Grid fixture: title cell has no filter, filter cell has no title", () => {
  const { titleCell, filterCell, input } = agTwoRowHeader({ title: "Player", field: "last_name" });
  assert.equal(titleCell.querySelector(AG_TITLE)?.textContent?.trim(), "Player");
  assert.equal(titleCell.querySelector(AG_FILTER), null);
  assert.equal(filterCell.querySelector(AG_TITLE), null);
  assert.equal(filterCell.querySelector(AG_FILTER), input);
  assert.equal(titleCell.getAttribute(AG_COL_FIELD_ATTR), "last_name");
  assert.equal(filterCell.getAttribute(AG_COL_FIELD_ATTR), "last_name");
});

test("labelHeaderFilters pairs title and floating-filter cells by col-id", () => {
  const { root, input, titleCell } = agTwoRowHeader({ title: "Player", field: "last_name" });
  labelHeaderFilters({ element: root });
  assert.equal(input.getAttribute("aria-label"), "Filter Player");
  assert.equal(titleCell.querySelector(AG_FILTER), null);
});

test("same-cell title+filter is not required (would miss real AG Grid DOM)", () => {
  const { root, input } = agTwoRowHeader({ title: "Division", field: "age_division" });
  const titleCell = root.querySelectorAll(AG_COL).find((c) => c.querySelector(AG_TITLE));
  const filterCell = root.querySelectorAll(AG_COL).find((c) => c.querySelector(AG_FILTER));
  assert.notEqual(titleCell, filterCell);
  labelHeaderFilters({ element: root });
  assert.equal(input.getAttribute("aria-label"), "Filter Division");
});

test("Tabulator-only fixture is NOT labeled", () => {
  const input = el("input", "tabulator-header-filter");
  const tabCol = el("div", "tabulator-col", { "tabulator-field": "name" }, [
    el("div", "tabulator-col-title", { textContent: "Name" }),
    el("div", "tabulator-header-filter", {}, [input]),
  ]);
  const tabRoot = el("div", "tabulator", {}, [tabCol]);
  labelHeaderFilters({ element: tabRoot });
  assert.equal(input.hasAttribute("aria-label"), false);
});

test("sortAriaValue maps asc/desc/none", () => {
  assert.equal(sortAriaValue("asc"), "ascending");
  assert.equal(sortAriaValue("desc"), "descending");
  assert.equal(sortAriaValue(undefined), "none");
});

test("reflectAriaSort sets aria-sort on the title cell, not the floating-filter cell", () => {
  const { root, titleCell, filterCell } = agTwoRowHeader({ title: "Player", field: "last_name" });
  reflectAriaSort({
    element: root,
    getSorters: () => [{ field: "last_name", dir: "asc" }],
  });
  assert.equal(titleCell.getAttribute("aria-sort"), "ascending");
  assert.equal(filterCell.getAttribute("aria-sort"), null);
});

console.log(`\n${passed} grid_a11y checks passed`);
