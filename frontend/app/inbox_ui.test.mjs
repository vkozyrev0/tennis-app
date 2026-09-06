// DOM-free unit tests for inbox progressive disclosure + shortcut gates.
// Run: node frontend/app/inbox_ui.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INBOX_SHORTCUTS,
  INBOX_AXES,
  inboxAxesLegend,
  bulkBarHidden,
  selectHintHidden,
  selectionCountLabel,
  pruneSelection,
  inboxShortcutGate,
  emailCreateGuard,
  EMAIL_MSG_ID,
  reviewFormState,
  fileWithoutPlayerGate,
  FILE_NEEDS_PLAYER_REASON,
  inboxConfidence,
} from "./inbox_ui.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("inbox axes keep unfiled unmatched Unclassified New distinct", () => {
  const byKey = Object.fromEntries(INBOX_AXES.map((a) => [a.key, a]));
  assert.equal(byKey.unfiled.axis, "queue");
  assert.equal(byKey.unmatched.axis, "player-match");
  assert.equal(byKey.unclassified.axis, "classification");
  assert.equal(byKey.new.axis, "status");
  const legend = inboxAxesLegend();
  assert.match(legend, /Unfiled/);
  assert.match(legend, /Unmatched/);
  assert.match(legend, /Unclassified/);
  assert.match(legend, /New/);
  assert.equal(emailCreateGuard({ subject: "", body: "", from_address: "" }).ok, false);
});

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

test("review modal state comes only from the current email", () => {
  const a = reviewFormState({
    classification: "withdrawal", status: "filed",
    detected_player_id: 11, detected_reason: "injury",
  });
  const b = reviewFormState({
    classification: "doubles", status: "new",
    detected_player_id: 22, detected_reason: "should not leak",
  });
  assert.equal(a.classification, "withdrawal");
  assert.equal(a.status, "filed");
  assert.equal(a.playerId, "11");
  assert.equal(a.reason, "injury");
  assert.equal(b.classification, "doubles");
  assert.equal(b.status, "new");
  assert.equal(b.playerId, "22");
  assert.equal(b.reason, "");
  const empty = reviewFormState({ classification: "withdrawal", status: "new" });
  assert.equal(empty.playerId, "");
  assert.equal(empty.reason, "");
});

test("review open resyncs combo overlays so classification/status are this email", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(src, /inbox-detail-classification[\s\S]*_comboSync/);
  assert.match(src, /inbox-detail-status/);
  assert.match(src, /_populateInboxAmendsSelect\(m, gen\)/);
});

test("confidence formatter does not nest hstr strings (escaped markup)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(src, /hstr`\$\{raw\(badge\)\}\$\{raw\(stamp\)\}`/);
});

test("inbox File, review Save-as-filed, and bulk populate use the hard gate", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(src, /fileWithoutPlayerGate\(m\.classification, m\.detected_player_id\)/);
  assert.match(src, /confirmDialog\(gate\.reason/);
  assert.match(src, /needsPlayer/);
  assert.match(src, /setMsg\(EMAIL_MSG_ID, guard\.reason/);
});

test("file without player is blocked for withdrawal and doubles", () => {
  assert.equal(fileWithoutPlayerGate("withdrawal", null).ok, false);
  assert.equal(fileWithoutPlayerGate("doubles", "").ok, false);
  assert.equal(fileWithoutPlayerGate("withdrawal", 9).ok, true);
  assert.equal(fileWithoutPlayerGate("late_entry", null).ok, true);
  assert.equal(fileWithoutPlayerGate("doubles", null).reason, FILE_NEEDS_PLAYER_REASON);
  assert.match(FILE_NEEDS_PLAYER_REASON, /will not change those lists/i);
});

test("classified withdrawal with a player suggestion is not Low", () => {
  const unmatched = inboxConfidence({
    classification: "withdrawal",
    detected_player_id: null,
    detected_name_pairs: [{ name: "Stella Johansson" }],
  });
  assert.equal(unmatched.label, "Medium");
  const lastname = inboxConfidence({
    classification: "withdrawal",
    detected_player_id: 4,
    detected_match_kind: "lastname",
  });
  assert.equal(lastname.label, "Medium");
  const usta = inboxConfidence({
    classification: "withdrawal",
    detected_player_id: 4,
    detected_match_kind: "usta",
  });
  assert.equal(usta.label, "High");
  const otherUnmatched = inboxConfidence({
    classification: "other",
    detected_player_id: null,
    detected_usta_text: "1234567890",
  });
  assert.equal(otherUnmatched.label, "Low");
});

test("blank email reason is written to #email-msg", () => {
  assert.equal(EMAIL_MSG_ID, "email-msg");
  const g = emailCreateGuard({ subject: "", body: "", from_address: "" });
  assert.equal(g.reason, "Enter a from address, subject, or body — blank emails are not saved");
});

console.log(`\n${passed} inbox_ui checks passed`);
