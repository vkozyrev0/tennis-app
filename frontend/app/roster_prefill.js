// Pure (DOM-free) logic for seeding forms from an inbox email — both the roster
// add-form and the late-entry/withdrawal "File" forms. Kept separate from app.js
// so it can be unit-tested in Node without a browser; the UI handlers just apply
// what these return.

// Which player id to pre-select when FILING an email into a list form: the
// linked player when detection set one, otherwise the player whose USTA # the
// email carries — precise even when two players share a surname. `players` is an
// array of {id, usta_number} (the app's full player list). Returns null when
// nothing resolves, so the TD picks manually.
export function resolveFilePlayerId(m, players) {
  m = m || {};
  if (m.detected_player_id) return m.detected_player_id;
  const usta = m.detected_usta_text || m.detected_usta;
  if (usta && Array.isArray(players)) {
    const hit = players.find((p) => p && String(p.usta_number) === String(usta));
    if (hit) return hit.id;
  }
  return null;
}

// Seed a roster add from a single parsed NAME (and optional USTA #) — used for
// the inbox "＋ add" affordance on a parsed-but-unrostered player, including the
// common doubles shape that names both players with NO number ("Mia Langone and
// Chelsea Ie"). Each Player-1/2 cell passes its own name, so both halves of a
// pair can be added. Always "new" mode; the USTA # may be blank (the TD fills
// it before saving). Returns { canAdd:false } when there's no usable name.
export function rosterPrefillFromName(name, usta, division) {
  const s = String(name || "").trim();
  let first = "", last = "";
  const comma = s.indexOf(",");
  if (comma >= 0) {
    // "Last, First" inversion → don't swap first/last (a parser feeds "First
    // Last" today, but be correct if a comma form ever arrives).
    const lt = s.slice(0, comma).trim().split(/\s+/).filter(Boolean);
    const ft = s.slice(comma + 1).trim().split(/\s+/).filter(Boolean);
    if (lt.length && ft.length) { first = ft[0]; last = lt.join(" "); }
  }
  if (!first && !last) {
    const nm = s.split(/\s+/).filter(Boolean);
    first = nm[0] || ""; last = nm.slice(1).join(" ");
  }
  if (!first && !last) return { canAdd: false, offRoster: false };
  return {
    canAdd: true, offRoster: false, mode: "new",
    usta_number: usta || "", first_name: first, last_name: last,
    gender: genderFromDivision(division), age_division: division || "",
  };
}

// Junior division codes are gendered (B14 → male, G12 → female). Returns "" for
// anything else (adult divisions, blank) so the TD picks gender manually.
export function genderFromDivision(div) {
  const c = String(div || "").trim().toUpperCase();
  if (c.startsWith("B")) return "male";
  if (c.startsWith("G")) return "female";
  return "";
}

// Given an inbox email row, decide whether it can seed a roster add and, if so,
// what to pre-fill. Two cases:
//   - OFF-ROSTER (detected_match_kind === 'usta_offroster' with a player id):
//     the player exists but isn't on this roster → "pick" mode, pre-selected.
//   - UNMATCHED but carrying a USTA # (detected_usta_text, no player id):
//     "new" mode, pre-filled from the email (USTA #, name, division, gender).
// Returns { canAdd: false } when neither applies (e.g. already on the roster, or
// no USTA # to go on).
export function rosterPrefillFromEmail(m) {
  m = m || {};
  const offRoster = m.detected_match_kind === "usta_offroster" && !!m.detected_player_id;
  const canAdd = offRoster || (!m.detected_player_id && !!m.detected_usta_text);
  if (!canAdd) return { canAdd: false, offRoster: false };
  if (offRoster) {
    return {
      canAdd: true, offRoster: true, mode: "pick",
      player_id: String(m.detected_player_id),
      age_division: m.detected_division || "",
    };
  }
  const nm = String(m.detected_player_name || "")
    .replace(/,/g, " ").trim().split(/\s+/).filter(Boolean);
  return {
    canAdd: true, offRoster: false, mode: "new",
    usta_number: m.detected_usta_text || m.detected_usta || "",
    first_name: nm[0] || "",
    last_name: nm.slice(1).join(" ") || "",
    gender: genderFromDivision(m.detected_division),
    age_division: m.detected_division || "",
  };
}
