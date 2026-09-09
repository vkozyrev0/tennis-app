// Run: node frontend/app/breadcrumbs.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRUMB_MAX, nextNavHistory, crumbsBarHidden,
} from "./breadcrumbs.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("same place is not appended twice", () => {
  const a = nextNavHistory([], "inbox", "panel-t-inbox");
  const b = nextNavHistory(a, "inbox", "panel-t-inbox");
  assert.deepEqual(b, [{ group: "inbox", panel: "panel-t-inbox" }]);
});

test("L2 tabs in the same section accumulate", () => {
  let h = nextNavHistory([], "setup", "panel-tournaments");
  h = nextNavHistory(h, "setup", "panel-players");
  h = nextNavHistory(h, "setup", "panel-officials");
  assert.equal(h.length, 3);
  assert.equal(h[2].panel, "panel-officials");
});

test("switching L1 section replaces the trail instead of stacking", () => {
  let h = nextNavHistory([], "home", "panel-home");
  h = nextNavHistory(h, "inbox", "panel-t-inbox");
  h = nextNavHistory(h, "notifications", "panel-notices");
  h = nextNavHistory(h, "inbox", "panel-t-inbox");
  assert.deepEqual(h, [{ group: "inbox", panel: "panel-t-inbox" }]);
});

test("trail is capped", () => {
  let h = [];
  for (let i = 0; i < CRUMB_MAX + 3; i++) {
    h = nextNavHistory(h, "setup", "panel-" + i);
  }
  assert.equal(h.length, CRUMB_MAX);
  assert.equal(h[0].panel, "panel-3");
});

test("bar is hidden until there is a place to step back", () => {
  assert.equal(crumbsBarHidden(0), true);
  assert.equal(crumbsBarHidden(1), true);
  assert.equal(crumbsBarHidden(2), false);
});

test("Clear empties the trail (does not keep current page)", () => {
  const src = readFileSync(join(here, "breadcrumbs.js"), "utf8");
  assert.match(src, /_crumbClear[\s\S]*_navHistory = \[\]/);
  assert.doesNotMatch(src, /_navHistory = cur \? \[cur\] : \[\]/);
});

console.log(`\n${passed} breadcrumb checks passed`);
