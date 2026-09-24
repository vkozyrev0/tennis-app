// Run: node frontend/app/classify_batch.test.mjs
//
// Reprocess range must send a range as a few list requests, not one request per
// stored copy (the per-id loop read as an endless overlay). These checks pin the
// chunk bound and the id coverage.
import assert from "node:assert/strict";
import { classifyChunks, progressAfter } from "./classify_batch.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function ids(n) { return Array.from({ length: n }, (_, i) => i + 1); }

test("250 ids with the default size become 5 requests, not 250", () => {
  const list = ids(250);
  const chunks = classifyChunks(list);
  assert.ok(chunks.length <= 5, `expected at most 5 chunks, got ${chunks.length}`);
  assert.equal(chunks.length, 5);
  assert.equal(chunks.length, Math.ceil(list.length / 50));
  for (const c of chunks) assert.ok(c.length <= 50, `chunk too big: ${c.length}`);
});

test("every id appears exactly once across the chunks, in order", () => {
  const list = ids(123);
  const flat = classifyChunks(list).flat();
  assert.deepEqual(flat, list);
  assert.equal(new Set(flat).size, list.length);
});

test("chunk count tracks the requested size", () => {
  assert.equal(classifyChunks(ids(10), { maxPerRequest: 4 }).length, 3);
  assert.deepEqual(classifyChunks(ids(3), { maxPerRequest: 5 }), [[1, 2, 3]]);
});

test("empty and single-id lists", () => {
  assert.deepEqual(classifyChunks([]), []);
  assert.deepEqual(classifyChunks(ids(1)), [[1]]);
});

test("non-array input is empty, not a throw", () => {
  for (const bad of [null, undefined, 0, "abc", {}, new Set([1])]) {
    assert.deepEqual(classifyChunks(bad), []);
  }
});

test("progressAfter reaches total on the last chunk", () => {
  const chunks = classifyChunks(ids(250));
  assert.deepEqual(progressAfter(chunks, 0), { current: 50, total: 250 });
  const last = progressAfter(chunks, chunks.length - 1);
  assert.equal(last.current, 250);
  assert.equal(last.total, 250);
  assert.deepEqual(progressAfter([], 0), { current: 0, total: 0 });
});

console.log(`\n${passed} classify-batch checks passed`);
