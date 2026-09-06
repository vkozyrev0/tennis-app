// Node tests for the session notice log (toast archive).
// Run: node frontend/app/notices.test.mjs
import assert from "node:assert/strict";
import { createNoticeLog } from "./notices.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function memStore() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}

test("records toasts in a table the page can list", () => {
  const log = createNoticeLog({ storage: memStore() });
  log.record({ text: "Incident logged", ok: true });
  log.record({ text: "Describe what happened", ok: false });
  const rows = log.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, "Describe what happened");
  assert.equal(rows[0].ok, false);
  assert.equal(rows[1].ok, true);
  assert.ok(rows[0].at);
});

test("blank toasts are not stored", () => {
  const log = createNoticeLog({ storage: memStore() });
  assert.equal(log.record({ text: "  " }), null);
  assert.equal(log.list().length, 0);
});

test("survives a storage round-trip", () => {
  const store = memStore();
  const a = createNoticeLog({ storage: store });
  a.record({ text: "Email added to the inbox", ok: true });
  const b = createNoticeLog({ storage: store });
  assert.equal(b.list()[0].text, "Email added to the inbox");
});

test("clear empties the table", () => {
  const log = createNoticeLog({ storage: memStore() });
  log.record({ text: "x", ok: true });
  log.clear();
  assert.equal(log.list().length, 0);
});

console.log(`\n${passed} passed`);
