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
  reviewDetectedPlayers,
  inboxRowClickOpensReview,
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

test("reviewDetectedPlayers is one slot, or many for doubles/name pairs", () => {
  const one = reviewDetectedPlayers({
    classification: "withdrawal", detected_player_id: 11,
  });
  assert.equal(one.length, 1);
  assert.equal(one[0].id, "11");
  const two = reviewDetectedPlayers({
    classification: "doubles",
    detected_player_id: 1,
    detected_partner_id: 2,
  });
  assert.equal(two.length, 2);
  assert.equal(two[1].id, "2");
  const fromPairs = reviewDetectedPlayers({
    classification: "doubles",
    detected_name_pairs: [
      { name: "Alexandra Dimitrov", usta: "2018522196" },
      { name: "Casey Davis", usta: "2018389707" },
    ],
  });
  assert.equal(fromPairs.length, 2);
  assert.equal(fromPairs[0].name, "Alexandra Dimitrov");
  assert.equal(fromPairs[1].usta, "2018389707");
  const members = reviewDetectedPlayers({
    classification: "pairing_avoidance",
    detected_member_ids: [8, 9, 10],
    detected_member_names: ["A", "B", "C"],
  });
  assert.equal(members.length, 3);
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
  assert.equal(b.players.length, 2);
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
  assert.match(src, /_renderInboxDetailPlayers/);
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /Players detected/);
  assert.match(html, /id="inbox-detail-players"/);
  assert.doesNotMatch(html, /Player \(detected\)/);
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

test("inbox Review control and non-editor row click open the review modal", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "inbox.js"), "utf8");
  assert.match(src, /stopPropagation\(\);\s*_openInboxDetail\(m\)/);
  assert.match(src, /inboxGrid\.grid\.on\("rowClick"/);
  assert.match(src, /inboxRowClickOpensReview/);
  assert.match(src, /_openInboxDetail\(data\)/);
  const fake = (sel) => ({ closest: (q) => (sel.split(",").some((s) => q.includes(s.trim())) ? {} : null) });
  assert.equal(inboxRowClickOpensReview(null), true);
  assert.equal(inboxRowClickOpensReview({ closest: () => null }), true);
  assert.equal(inboxRowClickOpensReview(fake("input")), false);
  assert.equal(inboxRowClickOpensReview(fake("button")), false);
  assert.equal(inboxRowClickOpensReview(fake(".editable-cell")), false);
  assert.equal(inboxRowClickOpensReview(fake(".grid-actions")), false);
});

test("inbox Review column sits after From; Email and Tournament columns are gone", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "inbox.js"), "utf8");
  const from = src.search(/title:\s*"From"/);
  const review = src.search(/title:\s*"Review"/);
  const subject = src.search(/title:\s*"Subject"/);
  assert.ok(from >= 0 && review > from && subject > review);
  assert.doesNotMatch(src, /title:\s*"Email"/);
  assert.doesNotMatch(src, /title:\s*"Tournament"/);
  assert.doesNotMatch(src, /_openOriginalEmail/);
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");
  assert.doesNotMatch(html, /id="inbox-original"/);
});

test("inbox From and Subject columns have a width floor so headers do not collapse", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "inbox.js"), "utf8");
  assert.match(src, /title:\s*"From"[\s\S]{0,80}minWidth:\s*1[4-9]\d/);
  assert.match(src, /title:\s*"Subject"[\s\S]{0,80}minWidth:\s*1[6-9]\d/);
  const grids = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "grids.js"), "utf8");
  assert.match(grids, /else if \(!col\.width\) cd\.minWidth = 96/);
});

test("blank email reason is written to #email-msg", () => {
  assert.equal(EMAIL_MSG_ID, "email-msg");
  const g = emailCreateGuard({ subject: "", body: "", from_address: "" });
  assert.equal(g.reason, "Enter a from address, subject, or body — blank emails are not saved");
});

console.log(`\n${passed} inbox_ui checks passed`);
