// DOM-free tests for the shared list paging query builder.
// Run: node frontend/app/list_page.test.mjs
import assert from "node:assert/strict";
import { LIST_PAGE_SIZE, listPageQuery, listPagePath } from "./list_page.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("SPA list path sends limit (not the unpaged full set)", () => {
  const path = listPagePath("/tournaments/3/late-entries");
  assert.ok(path.includes("limit="), path);
  assert.ok(path.includes(String(LIST_PAGE_SIZE)), path);
});

test("q is forwarded when the search box has a term", () => {
  const path = listPagePath("/tournaments/3/players", { q: "Smith", limit: 500 });
  assert.ok(path.includes("q=Smith"), path);
  assert.ok(path.includes("limit=500"), path);
});

test("empty q is omitted", () => {
  const qs = listPageQuery({ q: "  ", limit: 500 });
  assert.ok(!qs.includes("q="), qs);
});

test("offset is included when non-zero", () => {
  const qs = listPageQuery({ limit: 2, offset: 2 });
  assert.ok(qs.includes("offset=2"), qs);
});

console.log(`\n${passed} list-page checks passed`);
