// DOM-free unit tests for ui.js primitives.
// Run: node frontend/app/ui.test.mjs
import assert from "node:assert/strict";
import { money, chip } from "./ui.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("money nullish is em dash", () => {
  assert.equal(money(null), "—");
  assert.equal(money(undefined), "—");
});

test("money formats two decimals", () => {
  assert.equal(money(0), "$0.00");
  assert.equal(money(12.5), "$12.50");
  assert.equal(money(100), "$100.00");
});

test("chip empty is empty string", () => {
  assert.equal(chip(null), "");
  assert.equal(chip(""), "");
});

test("chip known status uses badge class", () => {
  const out = String(chip("selected"));
  assert.ok(out.includes("badge-ok"));
  assert.ok(out.includes("selected"));
});

test("chip unknown status is muted", () => {
  const out = String(chip("weird_token"));
  assert.ok(out.includes("badge-muted"));
});

test("chip escapes HTML in value", () => {
  const out = String(chip("<img>"));
  assert.ok(!out.includes("<img>"));
  assert.ok(out.includes("&lt;img&gt;") || out.includes("lt;img"));
});

console.log(`\n${passed} passed`);
