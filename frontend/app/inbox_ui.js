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
export { emailCreateGuard } from "./td_helpers.js";

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

/** Block File / status=filed on withdrawal/doubles when no player is matched. */
export function fileWithoutPlayerGate(classification, playerId) {
  const cls = String(classification || "");
  const hasPlayer = playerId != null && String(playerId).trim() !== "";
  if (FILE_NEEDS_PLAYER.includes(cls) && !hasPlayer) {
    return {
      ok: false,
      reason: "Pick a player first — filing a withdrawal or doubles email without one will not change those lists.",
    };
  }
  return { ok: true, reason: null };
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
