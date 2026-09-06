// DOM-free tests for viewport-fill grid height (Inbox must not collapse to 0).
// Run: node frontend/app/layout.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIST_MIN_HEIGHT, listMountHeight } from "./layout.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("list min height is enough for AG header + scrollbar + body rows", () => {
  assert.ok(LIST_MIN_HEIGHT >= 140, LIST_MIN_HEIGHT);
  assert.ok(LIST_MIN_HEIGHT >= 220, LIST_MIN_HEIGHT);
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
});

console.log(`\n${passed} layout checks passed`);
