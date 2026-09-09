// Run: node frontend/app/progress_job.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  jobLabel, isAbortError, createJobTracker, runTrackedJob,
} from "./progress_job.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => { passed++; console.log("  ok -", name); });
}

await test("jobLabel uses phase and n of total when known", () => {
  assert.equal(jobLabel({ phase: "Fetching" }), "Fetching");
  assert.equal(jobLabel({ phase: "Classifying", current: 3, total: 10 }), "Classifying — 3 of 10");
  assert.equal(jobLabel({ phase: "Detecting players", current: 0, total: 4 }), "Detecting players — 0 of 4");
  assert.equal(jobLabel({}), "Working");
});

await test("opening a job shows a phase label", () => {
  const t = createJobTracker();
  const s = t.open("Fetching Gmail and Outlook");
  assert.equal(s.open, true);
  assert.equal(s.cancelled, false);
  assert.match(s.label, /Fetching Gmail and Outlook/);
});

await test("progress text includes a count when total is known", () => {
  const t = createJobTracker();
  t.open("Classifying", { total: 12, current: 0 });
  const s = t.update({ current: 4 });
  assert.equal(s.label, "Classifying — 4 of 12");
  assert.equal(s.open, true);
});

await test("Cancel marks the job cancelled and aborts the signal", () => {
  const t = createJobTracker();
  t.open("Detecting players", { total: 8 });
  const sig = t.signal();
  assert.equal(sig.aborted, false);
  const s = t.cancel();
  assert.equal(s.cancelled, true);
  assert.equal(s.open, false);
  assert.equal(sig.aborted, true);
  assert.equal(s.label, "Cancelled");
});

await test("runTrackedJob abort is not a successful full run", async () => {
  const t = createJobTracker();
  const p = runTrackedJob(t, { phase: "Classifying", total: 10 }, async ({ signal, update }) => {
    update({ current: 0 });
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  });
  t.cancel();
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.cancelled, true);
  assert.equal(t.snapshot().open, false);
});

await test("isAbortError recognizes AbortError and cancelled copy", () => {
  const a = new Error("aborted");
  a.name = "AbortError";
  assert.equal(isAbortError(a), true);
  assert.equal(isAbortError(new Error("cancelled")), true);
  assert.equal(isAbortError(new Error("Graph timeout")), false);
  assert.equal(isAbortError(null), false);
});

await test("inbox batch actions and Help wire the progress modal + Cancel", () => {
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /runMailJob/);
  assert.match(inbox, /inbox-feeds\/fetch/);
  assert.match(inbox, /emails\/bulk\/classify/);
  assert.match(inbox, /emails\/bulk\/detect-players/);
  assert.match(inbox, /emails\/bulk\/triage/);
  assert.match(inbox, /emails\/bulk\/confirm-suggestions/);
  assert.match(inbox, /cancelled/);
  const app = readFileSync(join(here, "../app.js"), "utf8");
  assert.match(app, /createProgressModal/);
  assert.match(app, /runMailJob/);
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /id="job-progress-modal"/);
  assert.match(html, /id="job-progress-cancel"/);
  assert.match(html, />Cancel</);
  const help = readFileSync(join(here, "help.js"), "utf8");
  assert.match(help, /Cancel/);
  assert.match(help, /progress/i);
  const shell = readFileSync(join(here, "shell.js"), "utf8");
  assert.match(shell, /\.\.\.options/);
  const imp = readFileSync(join(here, "import_ui.js"), "utf8");
  assert.match(imp, /runMailJob/);
  assert.match(imp, /emails_pdf/);
});

console.log(`\n${passed} progress-job checks passed`);
