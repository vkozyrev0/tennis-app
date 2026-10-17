// H4.1/H4.2 gate behavior: audit every export, block minors-PII bytes unless
// the account can export and confirms, and redact when asked.
// Run: node frontend/app/export_csv.test.mjs
import assert from "node:assert/strict";
import { createCsvExport } from "./export_csv.js";

let passed = 0;
function test(name, fn) { return Promise.resolve(fn()).then(() => { passed++; console.log("  ok -", name); }); }

function harness({ canExport = true, confirm = true, auditFails = false, user = {} } = {}) {
  const calls = { audit: [], download: [], toast: [] };
  const exportCsv = createCsvExport({
    api: async (path, opts) => {
      calls.audit.push({ path, body: JSON.parse(opts.body) });
      if (auditFails) throw new Error("audit down");
    },
    toast: (t) => calls.toast.push(t),
    confirmDialog: async () => confirm,
    getAuthUser: () => (user === null ? null : { can_export_pii: canExport, ...user }),
    getActive: () => ({ id: 7 }),
    download: (matrix, name) => calls.download.push({ matrix, name }),
  });
  return { exportCsv, calls };
}

const roster = [["Player", "Email"], ["A", "a@example.com"]];

await test("non-PII export logs the audit row and downloads", async () => {
  const { exportCsv, calls } = harness();
  assert.equal(await exportCsv.csvDownload([["code"], ["A"]], "sites", { resource: "sites" }), true);
  assert.equal(calls.download.length, 1);
  assert.equal(calls.audit[0].path, "/export-audit");
  assert.equal(calls.audit[0].body.resource, "sites");
  assert.equal(calls.audit[0].body.tournament_id, 7);
});

await test("PII export is blocked without can_export_pii", async () => {
  const { exportCsv, calls } = harness({ canExport: false });
  assert.equal(await exportCsv.csvDownload(roster, "roster", { resource: "roster" }), false);
  assert.equal(calls.download.length, 0);
  assert.equal(calls.audit.length, 0);
});

await test("PII export is blocked when the user is unknown", async () => {
  const { exportCsv, calls } = harness({ user: null });
  assert.equal(await exportCsv.csvDownload(roster, "roster", { resource: "roster" }), false);
  assert.equal(calls.download.length, 0);
});

await test("PII export is blocked when the confirmation is declined", async () => {
  const { exportCsv, calls } = harness({ confirm: false });
  assert.equal(await exportCsv.csvDownload(roster, "roster", { resource: "roster" }), false);
  assert.equal(calls.download.length, 0);
  assert.equal(calls.audit.length, 0);
});

await test("confirmed PII export logs confirmed=true and downloads", async () => {
  const { exportCsv, calls } = harness({ confirm: true });
  assert.equal(await exportCsv.csvDownload(roster, "roster", { resource: "roster" }), true);
  assert.equal(calls.audit[0].body.detail.confirmed, true);
  assert.deepEqual(calls.download[0].matrix, roster);
});

await test("redacted PII export strips the sensitive columns", async () => {
  const { exportCsv, calls } = harness();
  assert.equal(
    await exportCsv.csvDownload(roster, "roster", { resource: "roster", redacted: true }),
    true,
  );
  assert.deepEqual(calls.download[0].matrix, [["Player"], ["A"]]);
  assert.equal(calls.audit[0].body.detail.redacted, true);
});

await test("an audit-log failure blocks the download", async () => {
  const { exportCsv, calls } = harness({ auditFails: true });
  assert.equal(await exportCsv.csvDownload([["code"], ["A"]], "sites", { resource: "sites" }), false);
  assert.equal(calls.download.length, 0);
  assert.equal(calls.toast.length, 1);
});

console.log(`\n${passed} export-gate checks passed`);
