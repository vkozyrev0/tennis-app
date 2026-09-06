// DOM-free tests for official self-service empty-state markup.
// Run: node frontend/app/official_empty.test.mjs
import assert from "node:assert/strict";
import { officialEmptyState } from "./official_app.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("empty state uses grid-empty + actionable .btn, not muted-only copy", () => {
  const out = String(officialEmptyState({
    message: "No assignments yet.",
    actionLabel: "Set your availability",
    actionHref: "#me-dates",
  }));
  assert.ok(out.includes("grid-empty"), out);
  assert.ok(out.includes("class=\"btn\"") || out.includes("class='btn'"), out);
  assert.ok(out.includes("Set your availability"), out);
  assert.ok(out.includes("#me-dates"), out);
  assert.ok(out.includes("No assignments yet."), out);
  assert.ok(!out.includes('class="muted">No assignments yet'), out);
});

test("empty state without action still has grid-empty wrapper", () => {
  const out = String(officialEmptyState({ message: "Select a tournament." }));
  assert.ok(out.includes("grid-empty"));
  assert.ok(out.includes("Select a tournament."));
  assert.ok(!out.includes('class="btn"'), out);
});

test("action label is HTML-escaped", () => {
  const out = String(officialEmptyState({
    message: "x",
    actionLabel: "<img>",
    actionHref: "#me-dates",
  }));
  assert.ok(!out.includes("<img>"), out);
  assert.ok(out.includes("&lt;img&gt;"), out);
});

console.log(`\n${passed} official-empty checks passed`);
