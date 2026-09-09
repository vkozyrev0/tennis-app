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
  inboxConfidenceText,
  inboxSourceLabel,
  INBOX_OPTION_PREFIX,
  inboxOptionValue,
  parseInboxOptionValue,
  mergePlayerDropdownOptions,
  inboxAddPlayerVisible,
  inboxKnownUsta,
  INBOX_ADD_TO_PLAYERS,
  formatEmailBody,
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
  assert.equal(fromPairs[0].hint, "Alexandra Dimitrov · 2018522196");
  const unnamed = reviewDetectedPlayers({
    classification: "doubles",
    detected_name_pairs: [
      { name: "Ernesto Del Valle" },
      { name: "Ulrich Novakovitch", usta: "2018838558" },
    ],
  });
  assert.equal(unnamed[0].id, "");
  assert.equal(unnamed[0].hint, "Ernesto Del Valle");
  assert.equal(unnamed[1].hint, "Ulrich Novakovitch · 2018838558");
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
  assert.match(src, /hstr`\$\{raw\(badge\)\}`/);
  assert.match(src, /classified in \$\{ms\} ms/);
  assert.match(src, /inbox-detail-confidence/);
  assert.doesNotMatch(src, /classified-ms/);
});

test("inbox File, review Save-as-filed, and bulk populate use the hard gate", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(src, /fileWithoutPlayerGate\(m\.classification, m\.detected_player_id\)/);
  assert.match(src, /confirmDialog\(gate\.reason/);
  assert.match(src, /needsPlayer/);
  assert.match(src, /setMsg\(EMAIL_MSG_ID, guard\.reason/);
});

test("Mark filed and bulk-status use the same player gate", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(src, /doSetStatus[\s\S]*fileWithoutPlayerGate\(m\.classification, m\.detected_player_id\)/);
  assert.match(src, /_inboxBulkStatus[\s\S]*fileWithoutPlayerGate\(m\.classification, m\.detected_player_id\)/);
  assert.match(src, /\/emails\/bulk\/status/);
  assert.match(src, /res\.skipped/);
});

test("file without player is blocked for withdrawal and doubles", () => {
  assert.equal(fileWithoutPlayerGate("withdrawal", null).ok, false);
  assert.equal(fileWithoutPlayerGate("doubles", "").ok, false);
  assert.equal(fileWithoutPlayerGate("withdrawal", 9).ok, true);
  assert.equal(fileWithoutPlayerGate("late_entry", null).ok, true);
  assert.equal(fileWithoutPlayerGate("hotel", null).ok, true);
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
  assert.equal(unmatched.pct, 60);
  assert.equal(inboxConfidenceText(unmatched), "Medium 60%");
  const lastname = inboxConfidence({
    classification: "withdrawal",
    detected_player_id: 4,
    detected_match_kind: "lastname",
  });
  assert.equal(lastname.label, "Medium");
  assert.equal(lastname.pct, 60);
  const usta = inboxConfidence({
    classification: "withdrawal",
    detected_player_id: 4,
    detected_match_kind: "usta",
  });
  assert.equal(usta.label, "High");
  assert.equal(usta.pct, 95);
  assert.equal(inboxConfidenceText(usta), "High 95%");
  const otherUnmatched = inboxConfidence({
    classification: "other",
    detected_player_id: null,
    detected_usta_text: "1234567890",
  });
  assert.equal(otherUnmatched.label, "Low");
  assert.equal(otherUnmatched.pct, 35);
  assert.equal(inboxConfidenceText(null), "");
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
  assert.match(src, /title:\s*"From"[\s\S]{0,80}minWidth:\s*96/);
  assert.match(src, /title:\s*"Subject"[\s\S]{0,80}minWidth:\s*110/);
  const grids = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "grids.js"), "utf8");
  assert.match(grids, /else if \(!col\.width\) cd\.minWidth = 96/);
});

test("inbox columns fit a ~998px work surface; Source/USTA collapse under 1400px", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "inbox.js"), "utf8");
  assert.match(src, /title:\s*"Confidence"[\s\S]{0,80}width:\s*108/);
  assert.match(src, /inboxConfidenceText\(k\)/);
  assert.match(src, /title:\s*"Source"[\s\S]{0,120}responsive:\s*2/);
  assert.match(src, /title:\s*"USTA #1"[\s\S]{0,80}responsive:\s*1/);
  assert.match(src, /title:\s*"USTA #2"[\s\S]{0,80}responsive:\s*1/);
  assert.match(src, /collapseAt:\s*"\(max-width:\s*1400px\)"/);
  assert.doesNotMatch(src, /width:\s*168/);
  const grids = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "grids.js"), "utf8");
  assert.match(grids, /opts\.collapseAt \? \{ collapseAt: opts\.collapseAt \}/);
  const mins = [36, 78, 96, 56, 110, 120, 120, 88, 96, 64, 36];
  assert.ok(mins.reduce((a, b) => a + b, 0) <= 998, "always-visible minWidths must fit 998px");
});

test("Help describes inbox people, Add to Players, Get all, and Outlook", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const help = readFileSync(join(here, "help.js"), "utf8");
  assert.match(help, /inbox people/);
  assert.match(help, /Add to Players/);
  assert.match(help, /Get all/);
  assert.match(help, /Outlook \/ Microsoft feed/);
  assert.match(help, /Still there\?/);
  assert.match(help, /Confidence/);
  assert.match(help, /95%/);
  assert.match(help, /sections do not stack/);
  assert.match(help, /Clear<\/strong> hides the bar/);
  assert.match(help, /Earlier messages/);
});

test("inbox source labels map gmail, outlook, and pdf", () => {
  assert.equal(inboxSourceLabel("gmail"), "gmail");
  assert.equal(inboxSourceLabel("outlook"), "outlook");
  assert.equal(inboxSourceLabel("pdf"), "pdf");
  assert.equal(inboxSourceLabel("pdf_import"), "pdf");
  assert.equal(inboxSourceLabel("emails_pdf"), "pdf");
  assert.equal(inboxSourceLabel("manual"), "manual");
  assert.equal(inboxSourceLabel(""), "manual");
  assert.equal(inboxSourceLabel("microsoft"), "outlook");
});

test("inbox markup has Clear (not bulk-clear) plus date range Get mails", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "../index.html"), "utf8");
  const js = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(html, /id="inbox-clear"/);
  assert.match(html, /id="inbox-bulk-clear"/);
  assert.match(html, /id="inbox-get-mails"/);
  assert.match(html, /already-read/);
  assert.match(html, /id="inbox-mail-since"/);
  assert.match(html, /id="inbox-mail-until"/);
  assert.match(html, /id="panel-t-inbox"[\s\S]*id="inbox-clear"/);
  assert.match(html, /data-group="inbox"[\s\S]*data-target="panel-gmail"/);
  assert.match(html, /data-group="inbox"[\s\S]*data-target="panel-outlook"/);
  assert.match(html, /id="inbox-cluster-mailbox"/);
  assert.match(html, /id="inbox-entry-row"/);
  assert.match(html, /id="inbox-cluster-queue"/);
  assert.match(html, /class="btn-link danger inbox-clear"/);
  assert.equal((html.match(/id="inbox-search"/g) || []).length, 1);
  {
    const setup = html.slice(html.indexOf('data-group="setup"'), html.indexOf('data-group="tournament"'));
    assert.doesNotMatch(setup, /panel-notices/);
  }
  assert.match(html, /data-group="notifications"[\s\S]*data-target="panel-notices"/);
  assert.match(html, /id="i-notifications"/);
  const notices = readFileSync(join(here, "notices.js"), "utf8");
  assert.match(notices, /activateGroup\("notifications"\)/);
  assert.doesNotMatch(notices, /activateGroup\("setup"\)/);
  assert.match(js, /\/emails\/clear/);
  assert.match(js, /does not delete anything in Gmail or Outlook\/Hotmail/);
  assert.match(html, /Gmail and Outlook\/Hotmail mailboxes are not changed/);
  assert.match(html, /id="inbox-bulk-tournament"[\s\S]{0,200}data-lpignore="true"/);
  assert.match(js, /\/inbox-feeds\/fetch/);
  assert.match(js, /q\.set\("tournament_id"/);
  assert.match(html, /id="inbox-get-all"/);
  assert.match(js, /get_all/);
  assert.match(js, /Hide CourtOps copies/);
  assert.match(js, /title:\s*"Source"/);
  assert.match(js, /inboxSourceLabel/);
  assert.notEqual(
    html.match(/id="inbox-clear"/)?.[0],
    html.match(/id="inbox-bulk-clear"/)?.[0],
  );
});

test("blank email reason is written to #email-msg", () => {
  assert.equal(EMAIL_MSG_ID, "email-msg");
  const g = emailCreateGuard({ subject: "", body: "", from_address: "" });
  assert.equal(g.reason, "Enter a from address, subject, or body — blank emails are not saved");
});

test("merge includes inbox person when usta/name not on catalog", () => {
  const catalog = [
    { id: 1, first_name: "Ada", last_name: "Lovelace", usta_number: "111", gender: "F" },
  ];
  const people = [
    { id: 5, name: "Casey Davis", first_name: "Casey", last_name: "Davis",
      usta_number: "2018389707", gender: "F", promoted_player_id: null, source_email_id: 9 },
  ];
  const opts = mergePlayerDropdownOptions(catalog, people);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].source, "catalog");
  assert.equal(opts[0].playerId, 1);
  assert.equal(opts[1].source, "inbox");
  assert.equal(opts[1].value, "inbox:5");
  assert.equal(opts[1].inboxPersonId, 5);
  assert.match(opts[1].label, /Davis, Casey/);
  assert.match(opts[1].label, /2018389707/);
  assert.match(opts[1].label, / · inbox$/);
});

test("merge EXCLUDES inbox person when usta already on catalog", () => {
  const catalog = [
    { id: 1, first_name: "Casey", last_name: "Davis", usta_number: 2018389707, gender: "F" },
  ];
  const people = [
    { id: 5, name: "Casey Davis", first_name: "Casey", last_name: "Davis",
      usta_number: "2018389707", gender: "F", promoted_player_id: null, source_email_id: 9 },
  ];
  const opts = mergePlayerDropdownOptions(catalog, people);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].source, "catalog");
  assert.equal(opts[0].playerId, 1);
  assert.equal(opts.some((o) => o.source === "inbox"), false);
});

test("merge EXCLUDES inbox person when promoted_player_id is on catalog", () => {
  const catalog = [
    { id: 11, first_name: "Ada", last_name: "Lovelace", usta_number: "111", gender: "F" },
  ];
  const people = [
    { id: 5, name: "Ada Lovelace", first_name: "Ada", last_name: "Lovelace",
      usta_number: "999", gender: "F", promoted_player_id: 11, source_email_id: 9 },
  ];
  const opts = mergePlayerDropdownOptions(catalog, people);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].source, "catalog");
  assert.equal(opts[0].playerId, 11);
  assert.equal(opts.some((o) => o.source === "inbox"), false);
});

test("option value is inbox:5 and parseInboxOptionValue round-trips", () => {
  const person = { id: 5, name: "Casey Davis" };
  assert.equal(INBOX_OPTION_PREFIX, "inbox:");
  assert.equal(inboxOptionValue(person), "inbox:5");
  assert.equal(parseInboxOptionValue("inbox:5"), 5);
  assert.equal(parseInboxOptionValue(inboxOptionValue(person)), person.id);
  assert.equal(parseInboxOptionValue("11"), null);
  assert.equal(parseInboxOptionValue(""), null);
  assert.equal(parseInboxOptionValue("inbox:"), null);
});

test("inboxAddPlayerVisible true for unmatched inbox person, false when catalog id present", () => {
  const person = {
    id: 5, name: "Casey Davis", usta_number: "2018389707", promoted_player_id: null,
  };
  assert.equal(inboxAddPlayerVisible({
    catalogPlayerId: "",
    inboxPerson: person,
    catalogByUsta: {},
  }), true);
  assert.equal(inboxAddPlayerVisible({
    catalogPlayerId: 11,
    inboxPerson: person,
    catalogByUsta: {},
  }), false);
});

test("inboxKnownUsta uses slot usta when the inbox person has none", () => {
  assert.equal(
    inboxKnownUsta({ id: 4, name: "Ulrich Novakovitch", usta_number: null },
      { name: "Ulrich Novakovitch", usta: "2018838558" }),
    "2018838558",
  );
  assert.equal(
    inboxKnownUsta({ id: 4, usta_number: "2018838558" }, { usta: null }),
    "2018838558",
  );
  assert.equal(inboxKnownUsta({ id: 3, name: "Ernesto Del Valle" }, { name: "Ernesto Del Valle" }), "");
});

test("INBOX_ADD_TO_PLAYERS label / className are the shipped strings", () => {
  assert.equal(INBOX_ADD_TO_PLAYERS.label, "Add to Players");
  assert.equal(INBOX_ADD_TO_PLAYERS.className, "inbox-add-to-players");
});

test("formatEmailBody escapes HTML and linkifies https", () => {
  const html = formatEmailBody('See <script>x</script> at https://usta.com/x.');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /class="email-link"/);
  assert.match(html, /href="https:\/\/usta\.com\/x"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("formatEmailBody keeps the latest ask and collapses the quoted thread", () => {
  const html = formatEmailBody(
    "Please withdraw Jane Smith.\n\nOn Mon, Jane wrote:\nCan we play Saturday?",
  );
  assert.match(html, /class="email-latest"/);
  assert.match(html, /Please withdraw Jane Smith/);
  assert.match(html, /<details class="email-quoted">/);
  assert.match(html, /<summary>Earlier messages<\/summary>/);
  assert.match(html, /email-quote-marker/);
  assert.equal(html.includes("<details"), true);
});

test("formatEmailBody does not collapse a forward that is the whole message", () => {
  const html = formatEmailBody("From: dad@example.com\nSent: Monday\nPlease withdraw Jane.");
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /email-hdr-key/);
});

test("formatEmailBody wraps > quotes and Original Message as a thread", () => {
  const html = formatEmailBody(
    "Jane cannot play.\n\n-----Original Message-----\nFrom: parent@example.com\n> old line",
  );
  assert.match(html, /Earlier messages/);
  assert.match(html, /email-quote/);
});

test("Review and grid markup builders use Add to Players", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(js, /INBOX_ADD_TO_PLAYERS/);
  assert.match(js, /_appendPromoteControls/);
  assert.match(js, /mergePlayerDropdownOptions/);
  assert.match(js, /\/inbox-people\/\$\{/);
  assert.match(js, /stopGridEdit/);
  assert.match(js, /inbox-promote-gender/);
  assert.match(js, /mousedown/);
});

console.log(`\n${passed} inbox_ui checks passed`);
