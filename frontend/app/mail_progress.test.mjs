// The mail overlay's progress model: real counts, monotonic, never NaN.
// Run: node frontend/app/mail_progress.test.mjs
import assert from "node:assert/strict";
import {
  completedView, countsFor, describeFetch, mailFetchPhases, phaseView, progressFor,
} from "./mail_progress.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

const frac = (p) => (p.total > 0 ? p.current / p.total : 0);
const phases = [
  { key: "download", label: "Loading mail", total: 12 },
  { key: "classify", label: "Classifying", total: 5 },
];

test("a counted phase reports its inner done over the job's count", () => {
  // The job is 12 + 5; the download phase fills only its first 12.
  assert.deepEqual(progressFor(phases, "download", 4),
    { phase: "Loading mail", current: 4, total: 17, label: "Loading mail", determined: true });
  assert.deepEqual(progressFor(phases, "classify", 2),
    { phase: "Classifying", current: 14, total: 17, label: "Classifying", determined: true });
});

test("inner done is clamped to [0, total]", () => {
  assert.equal(progressFor(phases, "download", 99).current, 12);
  assert.equal(progressFor(phases, "download", -3).current, 0);
  assert.equal(progressFor(phases, "download", "7").current, 7);
});

test("advancing to a later phase never lowers the fraction", () => {
  const seen = [];
  for (const done of [0, 3, 6, 9, 12]) seen.push(progressFor(phases, "download", done));
  for (const done of [1, 2, 3, 4, 5]) seen.push(progressFor(phases, "classify", done));
  for (let i = 1; i < seen.length; i++) {
    assert.ok(frac(seen[i]) >= frac(seen[i - 1]),
      `fraction fell from ${frac(seen[i - 1])} to ${frac(seen[i])}`);
  }
  assert.equal(seen.at(-1).current, seen.at(-1).total);
});

test("an uncounted phase is indeterminate and names its position", () => {
  const uncounted = [
    { key: "a", label: "Connecting", total: 0 },
    { key: "b", label: "Working", total: 0 },
  ];
  const p = phaseView(uncounted, "a");
  assert.equal(p.total, 0, "total 0 means indeterminate");
  assert.equal(p.determined, false);
  assert.match(p.label, /phase 1 of 2/);
  // Once later phases have counts, the uncounted phase shows what is left.
  const later = phaseView([{ key: "a", label: "A" }, { key: "b", label: "B", total: 4 }], "a");
  assert.deepEqual([later.current, later.total], [0, 4]);
});

test("a finished phase completes at its share of the job", () => {
  // Download is done, classify is not: 12 of 17. Then the job is done: 17.
  assert.deepEqual(completedView(phases, "download"),
    { phase: "Loading mail", current: 12, total: 17, label: "Loading mail", determined: true });
  assert.deepEqual(completedView(phases, "classify"),
    { phase: "Classifying", current: 17, total: 17, label: "Classifying", determined: true });
  const one = [{ key: "a", label: "Only", total: 0 }];
  assert.deepEqual(phaseView(one, "a"), { phase: "Only", current: 0, total: 0, label: "Only", determined: false });
  assert.deepEqual(phaseView(one, "a", 1), { phase: "Only", current: 1, total: 1, label: "Only", determined: true });
});

test("no input produces NaN or a negative", () => {
  const odd = [
    [{ key: "x", label: "X", total: NaN }, "x", NaN],
    [{ key: "x", label: "X", total: -5 }, "x", Infinity],
    [null, null, "abc"],
    [[], "missing", 3],
    [undefined, undefined, undefined],
  ];
  for (const [list, key, done] of odd) {
    for (const p of [progressFor(list, key, done), phaseView(list, key, done), completedView(list, key)]) {
      for (const n of [p.current, p.total]) assert.ok(Number.isFinite(n) && n >= 0, `got ${n}`);
    }
  }
});

// --- Get mails: the server's fetched counts drive the bar and status line ---

test("before the response the fetch phase's total is unknown", () => {
  const list = mailFetchPhases(null);
  assert.equal(list.length, 1);
  assert.equal(list[0].key, "download");
  assert.match(list[0].label, /Gmail and Outlook/);
  assert.equal(list[0].total, 0);
  assert.equal(phaseView(list, "download").determined, false);
});

test("a fetch of 12 Gmail and 7 Outlook mail fills the bar to 19", () => {
  const fetched = {
    gmail: { downloaded: 12, imported: 10, duplicates: 2 },
    outlook: { downloaded: 7, imported: 5, duplicates: 2 },
  };
  const list = mailFetchPhases(fetched);
  assert.equal(progressFor(list, "download", 8).total, 19);
  const done = completedView(list, "download");
  assert.deepEqual([done.current, done.total], [19, 19]);
});

test("a finished fetch with no downloads completes, not a pulsing bar", () => {
  const fetched = { gmail: { downloaded: 0, imported: 0, duplicates: 0 }, outlook: null };
  assert.deepEqual(completedView(mailFetchPhases(fetched, { finished: true }), "download"), {
    phase: "Loading mail from Gmail and Outlook", current: 1, total: 1,
    label: "Loading mail from Gmail and Outlook", determined: true,
  });
});

test("a skipped feed is not shown as a number", () => {
  const counts = countsFor({ gmail: { downloaded: 3, imported: 3, duplicates: 0 }, outlook: null });
  assert.deepEqual(Object.keys(counts), ["gmail"]);
});

test("the status line names every feed that ran, per feed", () => {
  const two = describeFetch({
    gmail: { downloaded: 12, imported: 10, duplicates: 2 },
    outlook: { downloaded: 7, imported: 6, duplicates: 1 },
  });
  assert.match(two, /12 downloaded/);
  assert.match(two, /Gmail: .*10 imported, 2 duplicates/);
  assert.match(two, /Outlook: .*6 imported, 1 duplicate/);
  const one = describeFetch({ gmail: { downloaded: 1, imported: 1, duplicates: 0 }, outlook: null });
  assert.equal(one, "download: 1 downloaded, 1 imported, 0 duplicates");
  assert.doesNotMatch(one, /Outlook/);
  assert.match(describeFetch({ gmail: null, outlook: null }), /no new mail/);
});

console.log(`\n${passed} mail-progress checks passed`);
