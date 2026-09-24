// The Inbox reprocess pass: bounded requests, per-copy progress, no spin.
// Run: node frontend/app/classify_batch.test.mjs
import assert from "node:assert/strict";
import { classifyChunks, progressAfter, runReprocessPass } from "./classify_batch.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

const ids = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("250 ids with the default size become 5 requests, not 250", () => {
  const chunks = classifyChunks(ids(250));
  assert.equal(chunks.length, 5);
  assert.ok(chunks.length <= 5, `expected a bounded request count, got ${chunks.length}`);
  assert.equal(chunks.flat().length, 250);
});

test("every id appears exactly once across the chunks, in order", () => {
  const flat = classifyChunks(ids(123)).flat();
  assert.deepEqual(flat, ids(123));
});

test("chunk count tracks the requested size", () => {
  assert.equal(classifyChunks(ids(10), { maxPerRequest: 4 }).length, 3);
  assert.equal(classifyChunks(ids(10), { maxPerRequest: 0 }).length, 1);  // falls back to 50
});

test("empty and single-id lists", () => {
  assert.deepEqual(classifyChunks([]), []);
  assert.deepEqual(classifyChunks(ids(1)), [[1]]);
  assert.deepEqual(progressAfter([], 0), { current: 0, total: 0 });
  assert.deepEqual(progressAfter(classifyChunks(ids(3)), 0), { current: 3, total: 3 });
});

test("non-array input is empty, not a throw", () => {
  assert.deepEqual(classifyChunks(null), []);
  assert.deepEqual(classifyChunks(undefined), []);
  assert.deepEqual(classifyChunks("1,2,3"), []);
});

test("progressAfter reaches total on the last chunk", () => {
  const chunks = classifyChunks(ids(10), { maxPerRequest: 4 });
  assert.equal(progressAfter(chunks, 0).current, 4);
  assert.equal(progressAfter(chunks, 2).current, 10);
  assert.equal(progressAfter(chunks, 2).total, 10);
});

// --- the pass itself ------------------------------------------------------

/** A server that processes `perRequest` ids per call and reports the ids. */
function fakeServer({ perRequest = 20, leftoverPerCall = 1 } = {}) {
  const seen = [];
  return {
    seen,
    call: async (batch) => {
      seen.push(batch.slice());
      const processed_ids = batch.slice(0, perRequest);
      return { processed_ids, leftover_calls: processed_ids.length ? leftoverPerCall : 0 };
    },
  };
}

test("a budgeted server is asked for the remainder until nothing is left", async () => {
  const server = fakeServer({ perRequest: 20 });
  const progress = [];
  const out = await runReprocessPass(ids(200), server.call, {
    onProgress: (p) => progress.push(p.parsed),
  });
  assert.equal(out.parsed, 200);
  assert.equal(out.remaining, 0);
  // Bounded: ceil(200 / 20) calls at best, plus the chunk boundaries.
  const ceiling = Math.ceil(200 / 20) + classifyChunks(ids(200)).length - 1;
  assert.ok(out.requests <= ceiling,
    `expected <= ${ceiling} requests, got ${out.requests} (N would be 200)`);
  assert.ok(out.requests < 200, `must not be one request per copy: ${out.requests}`);
  assert.equal(out.stopped, false);
  // Every id was asked about (a batch may legitimately be re-sent for its
  // remainder, but an id is only ever PROCESSED once).
  assert.equal(new Set(server.seen.flat()).size, 200);
  assert.equal(out.parsed, 200);
  // The bar advances by copies parsed, monotonically, and only reaches the
  // total when the pass is done.
  assert.equal(progress.at(-1), 200);
  assert.ok(progress.slice(0, -1).every((p) => p < 200), "bar must not hit 100% early");
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b), "progress must not go backwards");
});

test("a whole range the server can do in one call is one request", async () => {
  const server = fakeServer({ perRequest: 500 });
  const out = await runReprocessPass(ids(25), server.call);
  assert.equal(out.requests, 1);
  assert.equal(out.parsed, 25);
  assert.equal(out.remaining, 0);
});

test("a server that reports no progress is asked ONCE, not forever", async () => {
  let calls = 0;
  const out = await runReprocessPass(ids(200), async () => {
    calls += 1;
    return { processed_ids: [], leftover_calls: 0 };   // budget spent / refusing
  });
  assert.equal(calls, 1, `expected the loop to stop after one no-progress call, got ${calls}`);
  assert.equal(out.stopped, true);
  assert.equal(out.parsed, 0);
  assert.equal(out.remaining, 200);
});

test("a server that keeps reporting an already-done id cannot loop forever", async () => {
  let calls = 0;
  const out = await runReprocessPass(ids(10), async () => {
    calls += 1;
    // Always claims id 1. The first call clears it, then the remainder stops
    // shrinking, so the guard must stop the pass instead of spinning.
    return { processed_ids: [1], leftover_calls: 1 };
  });
  assert.equal(calls, 2, `expected the guard to stop after 2 calls, got ${calls}`);
  assert.equal(out.stopped, true);
  assert.equal(out.parsed, 1);
  assert.equal(out.remaining, 9);
});

test("a slow model stops at the pass budget instead of grinding for hours", async () => {
  // Every request costs 30s of wall clock and parses 3 copies; without a pass
  // budget this would keep asking for hours.
  let clock = 0;
  const now = () => clock;
  let calls = 0;
  const out = await runReprocessPass(ids(1020), async (batch) => {
    calls += 1;
    clock += 30000;                                  // the request took 30s
    return { processed_ids: batch.slice(0, 3), leftover_calls: 3 };
  }, { now, budgetMs: 60000 });

  assert.equal(out.stopped, true);
  assert.equal(out.reason, "budget");
  assert.ok(calls <= 3, `expected the pass budget to stop the grind, got ${calls} calls`);
  assert.equal(out.parsed, calls * 3);
  assert.equal(out.remaining, 1020 - out.parsed);
  assert.ok(out.remaining > 0);
});

test("a fast pass inside the budget finishes the whole range", async () => {
  const server = fakeServer({ perRequest: 20 });
  const out = await runReprocessPass(ids(200), server.call, { budgetMs: 600000 });
  assert.equal(out.stopped, false);
  assert.equal(out.reason, null);
  assert.equal(out.parsed, 200);
  assert.equal(out.remaining, 0);
});

test("cancelling aborts with an AbortError", async () => {
  let cancelled = false;
  await assert.rejects(
    () => runReprocessPass(ids(200), async () => {
      cancelled = true;                        // cancel after the first call
      return { processed_ids: [1], leftover_calls: 1 };
    }, { isCancelled: () => cancelled }),
    (err) => err.name === "AbortError",
  );
});

console.log(`\n${passed} classify-batch checks passed`);
