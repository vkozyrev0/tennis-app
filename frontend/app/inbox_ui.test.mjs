// DOM-free unit tests for inbox progressive disclosure + shortcut gates.
// Run: node frontend/app/inbox_ui.test.mjs
import assert from "node:assert/strict";
import {
  INBOX_SHORTCUTS,
  bulkBarHidden,
  selectHintHidden,
  selectionCountLabel,
  pruneSelection,
  inboxShortcutGate,
} from "./inbox_ui.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("shortcut map includes t d f u", () => {
  assert.deepEqual(
    INBOX_SHORTCUTS.map((s) => s.key).sort(),
    ["d", "f", "t", "u"],
  );
});

test("bulk bar hidden when nothing selected", () => {
  assert.equal(bulkBarHidden(0), true);
  assert.equal(bulkBarHidden(1), false);
  assert.equal(bulkBarHidden(3), false);
});

test("select hint only when rows exist and nothing selected", () => {
  assert.equal(selectHintHidden(0, 0), true);   // empty grid → AG empty-state
  assert.equal(selectHintHidden(0, 5), false);  // show hint
  assert.equal(selectHintHidden(2, 5), true);   // selection active → bulk bar
  assert.equal(selectHintHidden(1, 0), true);
});

test("selection count label", () => {
  assert.equal(selectionCountLabel(0), "");
  assert.equal(selectionCountLabel(1), "1 selected");
  assert.equal(selectionCountLabel(4), "4 selected");
});

test("pruneSelection drops missing ids", () => {
  assert.deepEqual(pruneSelection([1, 2, 3], [2, 3, 9]), [2, 3]);
  assert.deepEqual(pruneSelection([1], []), []);
  assert.deepEqual(pruneSelection([], [1, 2]), []);
});

test("t requires selection", () => {
  const miss = inboxShortcutGate("t", 0);
  assert.equal(miss.ok, false);
  assert.match(miss.reason, /checkbox/i);
  assert.equal(inboxShortcutGate("T", 2).ok, true);
});

test("d works without selection", () => {
  assert.equal(inboxShortcutGate("d", 0).ok, true);
  assert.equal(inboxShortcutGate("d", 3).ok, true);
});

test("f silent without selection", () => {
  const r = inboxShortcutGate("f", 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, null);
  assert.equal(inboxShortcutGate("f", 1).ok, true);
});

test("u works without selection", () => {
  assert.equal(inboxShortcutGate("u", 0).ok, true);
});

test("unknown key", () => {
  assert.equal(inboxShortcutGate("x", 0).ok, false);
});

console.log(`\n${passed} inbox_ui checks passed`);
