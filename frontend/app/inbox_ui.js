// Pure inbox UI helpers (progressive bulk bar + shortcuts map).
// DOM-free so unit tests can pin the empty/select/bulk visibility contract
// without AG Grid. Wired from inbox.js.

/**
 * Four inbox axes the TD kept mixing up. Queue vs player-match vs
 * classification vs status — each word means one thing.
 */
export const INBOX_AXES = Object.freeze([
  { key: "unfiled", axis: "queue", label: "Unfiled",
    meaning: "still in the work queue — not filed into a list yet" },
  { key: "unmatched", axis: "player-match", label: "Unmatched",
    meaning: "no roster player was detected on this email" },
  { key: "unclassified", axis: "classification", label: "Unclassified",
    meaning: "email type is not set (late entry, withdrawal, …)" },
  { key: "new", axis: "status", label: "New",
    meaning: "status chip for an email that has not been filed or marked follow-up" },
]);

export function inboxAxesLegend() {
  return INBOX_AXES.map((a) => `${a.label} (${a.axis}): ${a.meaning}`).join(" · ");
}

/** Inbox-panel keys (when not typing in a field). */
export const INBOX_SHORTCUTS = Object.freeze([
  { key: "t", needsSelection: true,  help: "Triage selected emails (classify → detect → file)" },
  { key: "d", needsSelection: false, help: "Detect players (selection, or all unmatched if none)" },
  { key: "f", needsSelection: true,  help: "Mark selected emails filed" },
  { key: "u", needsSelection: false, help: "Toggle “Unmatched only”" },
]);

/** Bulk toolbar is shown only when ≥1 row is checked. */
export function bulkBarHidden(selectedCount) {
  return !(selectedCount > 0);
}

/**
 * “Select checkboxes for bulk…” hint: rows on screen, nothing selected.
 * Empty grid uses the AG empty-state instead.
 */
export function selectHintHidden(selectedCount, displayedRowCount) {
  const n = Number(selectedCount) || 0;
  const rows = Number(displayedRowCount) || 0;
  return n > 0 || rows <= 0;
}

export function selectionCountLabel(selectedCount) {
  const n = Number(selectedCount) || 0;
  return n === 0 ? "" : `${n} selected`;
}

/** Drop selected ids that are no longer on the current page/filter set. */
export function pruneSelection(selectedIds, presentIds) {
  const present = new Set(presentIds);
  const out = [];
  for (const id of selectedIds) {
    if (present.has(id)) out.push(id);
  }
  return out;
}

/**
 * Whether an inbox key should run (caller still checks active panel / field focus).
 * Returns { ok, reason } where reason is a toast message when not ok.
 */
export { emailCreateGuard, EMAIL_MSG_ID } from "./td_helpers.js";

/** Classification / Status / Player / Reason for the review modal — always from this email. */
export function reviewFormState(m) {
  const classification = (m && m.classification) || "";
  const playerId = m && m.detected_player_id != null && m.detected_player_id !== ""
    ? String(m.detected_player_id) : "";
  return {
    classification,
    status: (m && m.status) || "new",
    playerId,
    reason: classification === "withdrawal" ? String((m && m.detected_reason) || "") : "",
  };
}

export const FILE_NEEDS_PLAYER = Object.freeze(["withdrawal", "doubles"]);

export const FILE_NEEDS_PLAYER_REASON =
  "Pick a player first — filing a withdrawal or doubles email without one will not change those lists.";

/** Block File / status=filed on withdrawal/doubles when no player is matched. */
export function fileWithoutPlayerGate(classification, playerId) {
  const cls = String(classification || "");
  const hasPlayer = playerId != null && String(playerId).trim() !== "";
  if (FILE_NEEDS_PLAYER.includes(cls) && !hasPlayer) {
    return { ok: false, reason: FILE_NEEDS_PLAYER_REASON };
  }
  return { ok: true, reason: null };
}

const _CONF_TIER = {
  usta: 3, withdraw_template: 3, usta_subject: 3, fullname_subject: 3, manual: 3,
  fullname_body: 2, fuzzy_name: 2, usta_offroster: 2,
  lastname_subject: 1, lastname: 1, firstname: 1,
};
const _CONF_LABEL = { 3: ["High", "ok"], 2: ["Medium", "warn"], 1: ["Low", "bad"] };

/**
 * Inbox confidence from match_kind + classification.
 * A correctly labeled withdrawal/doubles with a player match or name suggestion
 * is not forced to Low.
 */
export function inboxConfidence(m) {
  if (!m) return null;
  const cls = String(m.classification || "");
  const fileIntent = FILE_NEEDS_PLAYER.includes(cls);
  const hasMatch = m.detected_player_id != null && String(m.detected_player_id).trim() !== "";
  const pairs = m.detected_name_pairs;
  const hasSuggestion = hasMatch
    || (Array.isArray(pairs) && pairs.length > 0)
    || !!(m.detected_usta_text)
    || !!(m.detected_player_name);
  if (hasMatch) {
    let tier = _CONF_TIER[m.detected_match_kind] || 2;
    if (fileIntent && tier < 2) tier = 2;
    const [label, badge] = _CONF_LABEL[tier];
    return { label, cls: badge, title: "Matched to a roster player" };
  }
  if (fileIntent && hasSuggestion) {
    return {
      label: "Medium",
      cls: "warn",
      title: "Classified with a player suggestion — confirm the match; not auto-filed",
    };
  }
  if (hasSuggestion) {
    return {
      label: "Low",
      cls: "bad",
      title: "Parsed from the email but not matched to the roster — confirm or add the player",
    };
  }
  return null;
}

export function inboxShortcutGate(key, selectedCount) {
  const k = String(key || "").toLowerCase();
  const def = INBOX_SHORTCUTS.find((s) => s.key === k);
  if (!def) return { ok: false, reason: null };
  if (def.needsSelection && !(selectedCount > 0)) {
    if (k === "t") {
      return {
        ok: false,
        reason: "Select one or more emails first (checkboxes), then press T to triage",
      };
    }
    return { ok: false, reason: null }; // f with no selection: silent no-op
  }
  return { ok: true, reason: null, def };
}
