// DOM-free tests for role-aware skip-to-content.
// Run: node frontend/app/skip_link.test.mjs
import assert from "node:assert/strict";
import { skipHrefForRole, syncSkipLink } from "./skip_link.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("official-visible app skip target is the official portal", () => {
  assert.equal(skipHrefForRole("official"), "#official-app");
});

test("TD / admin skip target is the TD main", () => {
  assert.equal(skipHrefForRole("admin"), "#main-app");
  assert.equal(skipHrefForRole(null), "#main-app");
});

test("syncSkipLink writes the official href onto the skip element", () => {
  const attrs = { href: "#main-app" };
  const el = {
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
  };
  const href = syncSkipLink(el, "official");
  assert.equal(href, "#official-app");
  assert.equal(attrs.href, "#official-app");
});

test("syncSkipLink does not leave official targeting #main-app", () => {
  const attrs = { href: "#main-app" };
  const el = { setAttribute: (k, v) => { attrs[k] = v; } };
  syncSkipLink(el, "official");
  assert.notEqual(attrs.href, "#main-app");
});

console.log(`\n${passed} skip-link checks passed`);
