// DOM-free tests for viewport-fill grid height (Inbox must not collapse to 0).
// Run: node frontend/app/layout.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIST_MIN_HEIGHT, LIST_HEADER_ROW_HEIGHT, listMountHeight, listBodyMinFromMount, listMinBodyHeight,
} from "./layout.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("list min height is enough for AG header + scrollbar + body rows", () => {
  assert.ok(LIST_MIN_HEIGHT >= 140, LIST_MIN_HEIGHT);
  assert.ok(LIST_MIN_HEIGHT >= 220, LIST_MIN_HEIGHT);
  assert.ok(LIST_MIN_HEIGHT >= 380, LIST_MIN_HEIGHT);
  assert.ok(listBodyMinFromMount(LIST_MIN_HEIGHT) >= listMinBodyHeight(),
    listBodyMinFromMount(LIST_MIN_HEIGHT));
  assert.ok(listBodyMinFromMount(LIST_MIN_HEIGHT) >= 64, "need ~2 data rows of body");
});

test("mount height never collapses to 0 even when top is past the fold", () => {
  const h = listMountHeight({ viewportHeight: 800, top: 900 });
  assert.ok(h >= LIST_MIN_HEIGHT, h);
  assert.notEqual(h, 0);
});

test("representative inbox viewport fills remaining space", () => {
  const h = listMountHeight({ viewportHeight: 900, top: 420, bottomPad: 16, mountsBelow: 0 });
  assert.ok(h >= LIST_MIN_HEIGHT, h);
  assert.equal(h, Math.max(LIST_MIN_HEIGHT, Math.floor(900 - 420 - 16)));
});

test("stacked mounts still get at least the minimum", () => {
  const h = listMountHeight({ viewportHeight: 700, top: 200, mountsBelow: 1 });
  assert.ok(h >= LIST_MIN_HEIGHT, h);
});

test("inbox grid is a sized grid-mount; action cells keep pointer-events", () => {
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /makeReadGrid[\s\S]*className = "grid-mount"/);
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /makeReadGrid\("inbox-table"/);
  assert.match(inbox, /cssClass: "grid-actions-cell"/);
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  assert.match(css, /ag-cell\.grid-actions-cell/);
  assert.match(css, /pointer-events:\s*auto/);
  assert.doesNotMatch(css, /grid-actions-cell[^}]*pointer-events:\s*none/);
  assert.match(css, /\.grid-mount\s*\{[^}]*min-height:\s*380px/);
  assert.match(css, /ag-body-viewport\s*\{\s*min-height:\s*96px/);
});

test("grid headers stay 8pt in a 20px Quartz header row", () => {
  const theme = readFileSync(join(here, "../vendor/ag-theme-courtops.css"), "utf8");
  assert.match(theme, /--ag-header-height:\s*20px/);
  assert.match(theme, /--ag-font-size:\s*8pt/);
  assert.match(theme, /font-size:\s*8pt/);
  assert.match(theme, /--ag-icon-size:\s*12px/);
  assert.doesNotMatch(theme, /--ag-header-height:\s*16px/);
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /ag-theme-courtops\.css\?v=/);
  assert.equal(LIST_HEADER_ROW_HEIGHT, 20);
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /headerHeight:\s*LIST_HEADER_ROW_HEIGHT/);
  assert.match(grids, /theme:\s*"legacy"/);
  assert.doesNotMatch(grids, /floatingFiltersHeight:\s*LIST_HEADER_ROW_HEIGHT/);
});

test("header labels cannot wrap to a second line or auto-grow", () => {
  const theme = readFileSync(join(here, "../vendor/ag-theme-courtops.css"), "utf8");
  assert.match(theme, /white-space:\s*nowrap\s*!important/);
  assert.match(theme, /font-size:\s*8pt\s*!important/);
  assert.match(theme, /ag-header-row-column-filter/);
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /wrapHeaderText:\s*false/);
  assert.match(grids, /autoHeaderHeight:\s*false/);
  assert.match(grids, /floatingFilter:\s*false/);
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /title:\s*"Player 1"/);
  assert.match(inbox, /title:\s*"Player 2"/);
  assert.doesNotMatch(inbox, /title:\s*"Player 1",\s*columns:/);
  const roster = readFileSync(join(here, "roster.js"), "utf8");
  assert.match(roster, /title:\s*"Player"/);
});

console.log(`\n${passed} layout checks passed`);
