// Deterministic unit test for the roster-prefill logic (DOM-free).
// Run: node frontend/app/roster_prefill.test.mjs
import assert from "node:assert/strict";
import { genderFromDivision, rosterPrefillFromEmail, resolveFilePlayerId } from "./roster_prefill.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

// --- genderFromDivision -----------------------------------------------------
test("gender from junior division codes", () => {
  assert.equal(genderFromDivision("B14"), "male");
  assert.equal(genderFromDivision("g12"), "female");
  assert.equal(genderFromDivision("Open"), "");
  assert.equal(genderFromDivision(""), "");
  assert.equal(genderFromDivision(null), "");
});

// --- OFF-ROSTER case (player exists, not on this roster) ---------------------
test("off-roster match → pick mode, pre-selected player", () => {
  const plan = rosterPrefillFromEmail({
    detected_match_kind: "usta_offroster",
    detected_player_id: 39,
    detected_player_name: "OffR Player",
    detected_usta: "2006005004",
    detected_division: "G12",
  });
  assert.equal(plan.canAdd, true);
  assert.equal(plan.offRoster, true);
  assert.equal(plan.mode, "pick");
  assert.equal(plan.player_id, "39");        // stringified for the <select>
  assert.equal(plan.age_division, "G12");
});

// --- UNMATCHED but carries a USTA # -----------------------------------------
test("unmatched + USTA text → new mode, pre-filled from email", () => {
  const plan = rosterPrefillFromEmail({
    detected_match_kind: null,
    detected_player_id: null,
    detected_usta_text: "2003334445",
    detected_player_name: "",        // unmatched → usually no name
    detected_division: "B16",
  });
  assert.equal(plan.canAdd, true);
  assert.equal(plan.offRoster, false);
  assert.equal(plan.mode, "new");
  assert.equal(plan.usta_number, "2003334445");
  assert.equal(plan.gender, "male");          // inferred from B16
  assert.equal(plan.age_division, "B16");
});

test("new mode splits a known name into first/last", () => {
  const plan = rosterPrefillFromEmail({
    detected_player_id: null, detected_usta_text: "2001112223",
    detected_player_name: "Maria Elena Gomez", detected_division: "G14",
  });
  assert.equal(plan.first_name, "Maria");
  assert.equal(plan.last_name, "Elena Gomez");
});

test("new mode falls back to detected_usta when no usta_text", () => {
  const plan = rosterPrefillFromEmail({
    detected_player_id: null, detected_usta_text: null,
    detected_usta: "2009998887",
  });
  // no usta_text → canAdd is false (gate is on usta_text); guard the contract
  assert.equal(plan.canAdd, false);
});

// --- NOT offerable ----------------------------------------------------------
test("already-on-roster match → cannot add", () => {
  const plan = rosterPrefillFromEmail({
    detected_match_kind: "usta", detected_player_id: 7, detected_usta_text: "2001234567",
  });
  assert.equal(plan.canAdd, false);   // player already detected on the roster
});

test("no USTA #, no player → cannot add", () => {
  assert.equal(rosterPrefillFromEmail({}).canAdd, false);
  assert.equal(rosterPrefillFromEmail({ detected_player_name: "Someone" }).canAdd, false);
});

// --- resolveFilePlayerId (player for the "File" forms) ----------------------
const PLAYERS = [
  { id: 11, usta_number: "2001110001" },
  { id: 12, usta_number: "2002220002" },  // shares a surname with 13 in real life
  { id: 13, usta_number: "2003330003" },
];
test("file: detected player id wins", () => {
  assert.equal(resolveFilePlayerId({ detected_player_id: 12, detected_usta_text: "2003330003" }, PLAYERS), 12);
});
test("file: falls back to the USTA # when no player linked", () => {
  // surname-ambiguous email, no linked player, but a USTA # → resolves precisely
  assert.equal(resolveFilePlayerId({ detected_player_id: null, detected_usta_text: "2003330003" }, PLAYERS), 13);
});
test("file: uses detected_usta when usta_text absent", () => {
  assert.equal(resolveFilePlayerId({ detected_usta: "2001110001" }, PLAYERS), 11);
});
test("file: USTA # not in the player list → null", () => {
  assert.equal(resolveFilePlayerId({ detected_usta_text: "9999999999" }, PLAYERS), null);
});
test("file: nothing to go on → null", () => {
  assert.equal(resolveFilePlayerId({}, PLAYERS), null);
  assert.equal(resolveFilePlayerId({ detected_usta_text: "2001110001" }, null), null);
});

console.log(`\n${passed} roster-prefill checks passed`);
