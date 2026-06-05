// Pure (DOM-free) logic for seeding a roster add-form from an inbox email.
// Kept separate from app.js so it can be unit-tested in Node without a browser
// — the UI handler in app.js just *applies* the plan this returns.

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
