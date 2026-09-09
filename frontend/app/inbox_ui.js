// Pure inbox UI helpers (progressive bulk bar + shortcuts map).
// DOM-free so unit tests can pin the empty/select/bulk visibility contract
// without AG Grid. Wired from inbox.js.
import { esc } from "./util.js";

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

/** Map stored ingest_source to the inbox grid label (gmail / outlook / pdf). */
export function inboxSourceLabel(source) {
  const key = String(source || "").trim().toLowerCase();
  if (key === "gmail") return "gmail";
  if (key === "outlook") return "outlook";
  if (key === "pdf" || key === "pdf_import" || key === "emails_pdf") return "pdf";
  if (key.includes("gmail")) return "gmail";
  if (key === "microsoft" || key === "graph" || key.includes("outlook")) return "outlook";
  if (key.includes("pdf")) return "pdf";
  return key || "manual";
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

/** True when an inbox row click should open Review (not checkbox/editor/actions). */
export function inboxRowClickOpensReview(target) {
  if (!target || typeof target.closest !== "function") return true;
  return !target.closest(
    "input, button, a, select, textarea, .ag-cell-inline-editing, .grid-actions, .editable-cell",
  );
}

/**
 * Detected-player slots for the review modal. One row for a single-player
 * email; two (or more) for doubles / pairing / parsed name pairs.
 */
export function reviewDetectedPlayers(m) {
  if (!m) return [{ role: "player", id: "", name: "", usta: "", hint: "" }];
  const cls = String(m.classification || "");
  const pairs = Array.isArray(m.detected_name_pairs)
    ? m.detected_name_pairs.filter(Boolean) : [];
  const memberIds = Array.isArray(m.detected_member_ids)
    ? m.detected_member_ids.filter((id) => id != null && id !== "") : [];
  const memberNames = Array.isArray(m.detected_member_names) ? m.detected_member_names : [];
  const primary = m.detected_player_id != null && m.detected_player_id !== ""
    ? String(m.detected_player_id) : "";
  const partner = m.detected_partner_id != null && m.detected_partner_id !== ""
    ? String(m.detected_partner_id) : "";
  const hintAt = (i, fallbackName, fallbackUsta) => {
    const p = pairs[i] || {};
    const name = String(p.name || fallbackName || "").trim();
    const usta = String(p.usta || fallbackUsta || "").trim();
    return { name, usta, hint: [name, usta].filter(Boolean).join(" · ") };
  };
  if (memberIds.length >= 2) {
    return memberIds.map((id, i) => ({
      role: i === 0 ? "player" : (i === 1 ? "partner" : "member"),
      id: String(id),
      ...hintAt(i, memberNames[i], ""),
    }));
  }
  const n = Math.max(
    cls === "doubles" ? 2 : 1,
    pairs.length,
    (primary ? 1 : 0) + (partner ? 1 : 0),
  );
  const slots = [];
  for (let i = 0; i < n; i++) {
    const id = i === 0 ? primary : (i === 1 ? partner : "");
    const h = hintAt(
      i,
      i === 0 ? m.detected_player_name : m.detected_partner_name,
      i === 0 ? m.detected_usta : m.detected_partner_usta,
    );
    slots.push({ role: i === 0 ? "player" : "partner", id, ...h });
  }
  return slots;
}

/** Classification / Status / Players / Reason for the review modal — always from this email. */
export function reviewFormState(m) {
  const classification = (m && m.classification) || "";
  const players = reviewDetectedPlayers(m);
  const playerId = players[0] ? players[0].id : "";
  return {
    classification,
    status: (m && m.status) || "new",
    playerId,
    partnerId: (players[1] && players[1].id) || "",
    players,
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
const _CONF_PCT = {
  usta: 95, withdraw_template: 95, usta_subject: 90, fullname_subject: 90, manual: 99,
  fullname_body: 75, fuzzy_name: 70, usta_offroster: 80,
  lastname_subject: 45, lastname: 45, firstname: 40,
};
const _CONF_TIER_PCT = { 3: 90, 2: 70, 1: 40 };

/**
 * Inbox confidence from match_kind + classification.
 * A correctly labeled withdrawal/doubles with a player match or name suggestion
 * is not forced to Low. `pct` is the same scale (not a model softmax).
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
    const rawTier = _CONF_TIER[m.detected_match_kind] || 2;
    let tier = rawTier;
    if (fileIntent && tier < 2) tier = 2;
    const [label, badge] = _CONF_LABEL[tier];
    let pct = _CONF_PCT[m.detected_match_kind];
    if (pct == null) pct = _CONF_TIER_PCT[tier];
    if (fileIntent && rawTier < 2) pct = 60;
    return { label, cls: badge, pct, title: "Matched to a roster player" };
  }
  if (fileIntent && hasSuggestion) {
    return {
      label: "Medium",
      cls: "warn",
      pct: 60,
      title: "Classified with a player suggestion — confirm the match; not auto-filed",
    };
  }
  if (hasSuggestion) {
    return {
      label: "Low",
      cls: "bad",
      pct: 35,
      title: "Parsed from the email but not matched to the roster — confirm or add the player",
    };
  }
  return null;
}

/** Badge text: "Medium 70%". Empty when there is no confidence. */
export function inboxConfidenceText(k) {
  if (!k || !k.label) return "";
  return k.pct != null ? `${k.label} ${k.pct}%` : k.label;
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

/** Prefix for dropdown values that point at an inbox-people row, not Setup Players. */
export const INBOX_OPTION_PREFIX = "inbox:";

/** Named spec for the review/grid “Add to Players” control (catalog, not roster). */
export const INBOX_ADD_TO_PLAYERS = Object.freeze({
  className: "inbox-add-to-players",
  label: "Add to Players",
  title: "Add this person to Setup Players (catalog, not roster)",
});

export function inboxOptionValue(person) {
  return `${INBOX_OPTION_PREFIX}${person && person.id != null ? person.id : ""}`;
}

/** Numeric inbox-person id, or null when `value` is not an inbox option. */
export function parseInboxOptionValue(value) {
  const s = String(value ?? "");
  if (!s.startsWith(INBOX_OPTION_PREFIX)) return null;
  const rest = s.slice(INBOX_OPTION_PREFIX.length);
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

function _ustaDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function _lastFirstKey(last, first) {
  return `${String(last || "")}\0${String(first || "")}`;
}

/** Split inbox `name` / first+last into Last, First when we can; else a single Name. */
function _inboxNameParts(person) {
  const first = String((person && person.first_name) || "").trim();
  const last = String((person && person.last_name) || "").trim();
  if (first || last) return { first, last, display: [last, first].filter(Boolean).join(", ") };
  const raw = String((person && person.name) || "").trim();
  if (!raw) return { first: "", last: "", display: "" };
  const comma = raw.indexOf(",");
  if (comma >= 0) {
    const lastPart = raw.slice(0, comma).trim();
    const firstPart = raw.slice(comma + 1).trim();
    if (lastPart && firstPart) {
      return { first: firstPart, last: lastPart, display: `${lastPart}, ${firstPart}` };
    }
  }
  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const firstPart = parts[0];
    const lastPart = parts.slice(1).join(" ");
    return { first: firstPart, last: lastPart, display: `${lastPart}, ${firstPart}` };
  }
  return { first: "", last: "", display: raw };
}

function _personUsta(person) {
  return String((person && (person.usta_number || person.usta)) || "").trim();
}

function _personNameRaw(person) {
  if (!person) return "";
  const named = String(person.name || "").trim();
  if (named) return named;
  return [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
}

function _catalogOption(p) {
  const first = String((p && p.first_name) || "").trim();
  const last = String((p && p.last_name) || "").trim();
  const name = [last, first].filter(Boolean).join(", ");
  const usta = String((p && p.usta_number) || "").trim();
  return {
    value: String(p.id),
    label: usta ? `${name || "?"} (${usta})` : (name || "?"),
    source: "catalog",
    usta,
    name,
    playerId: p.id,
    inboxPersonId: null,
    promotedPlayerId: null,
  };
}

function _inboxOption(person) {
  const parts = _inboxNameParts(person);
  const usta = _personUsta(person);
  const name = parts.display || _personNameRaw(person);
  const core = name && usta ? `${name} (${usta})` : (name || usta);
  return {
    value: inboxOptionValue(person),
    label: `${core} · inbox`,
    source: "inbox",
    usta,
    name,
    playerId: null,
    inboxPersonId: person.id,
    promotedPlayerId: person.promoted_player_id == null ? null : person.promoted_player_id,
  };
}

function _ustaInCatalogMap(usta, catalogByUsta) {
  const digits = _ustaDigits(usta);
  if (!digits || catalogByUsta == null || typeof catalogByUsta !== "object") return false;
  if (catalogByUsta[usta] || catalogByUsta[digits]) return true;
  const keys = catalogByUsta instanceof Map ? catalogByUsta.keys() : Object.keys(catalogByUsta);
  for (const key of keys) {
    if (_ustaDigits(key) === digits) return true;
  }
  return false;
}

/**
 * Catalog Setup Players first (Last, First), then inbox-people who are not
 * already on that catalog (promoted id or non-empty USTA digits).
 */
export function mergePlayerDropdownOptions(catalogPlayers, inboxPeople) {
  const catalog = Array.isArray(catalogPlayers) ? catalogPlayers.filter(Boolean) : [];
  const people = Array.isArray(inboxPeople) ? inboxPeople.filter(Boolean) : [];
  const catalogOpts = catalog.slice().sort((a, b) =>
    _lastFirstKey(a.last_name, a.first_name).localeCompare(_lastFirstKey(b.last_name, b.first_name)),
  ).map(_catalogOption);

  const catalogIds = new Set(catalog.map((p) => String(p.id)));
  const catalogUsta = new Set();
  for (const p of catalog) {
    const d = _ustaDigits(p.usta_number);
    if (d) catalogUsta.add(d);
  }

  const inboxOpts = [];
  for (const person of people) {
    if (person.id == null || person.id === "") continue;
    const name = _personNameRaw(person);
    const usta = _personUsta(person);
    if (!name && !usta) continue;
    const promoted = person.promoted_player_id;
    if (promoted != null && promoted !== "" && catalogIds.has(String(promoted))) continue;
    const digits = _ustaDigits(usta);
    if (digits && catalogUsta.has(digits)) continue;
    inboxOpts.push(_inboxOption(person));
  }
  inboxOpts.sort((a, b) => a.label.localeCompare(b.label));
  return catalogOpts.concat(inboxOpts);
}

/** USTA digits from the inbox person or the email slot — slot wins gaps. */
export function inboxKnownUsta(person, slot) {
  const fromPerson = _ustaDigits(person && (person.usta_number || person.usta));
  const fromSlot = _ustaDigits(slot && slot.usta);
  return fromPerson || fromSlot || "";
}

const _EMAIL_META = /^\[(Date|To|From|Subject):\s*(.+)\]$/;
const _EMAIL_HDR = /^(\s*)(From|To|Cc|Bcc|Subject|Sent|Date|Reply-To):\s*(.*)$/i;
const _ON_WROTE = /^On .+ wrote:\s*$/;
const _ORIG_MSG = /^-----Original Message-----$/i;
const _FWD_MSG = /^Begin forwarded message:?$/i;
const _HTTP_URL = /https?:\/\/[^\s<]+/gi;

function _linkifyEscaped(escaped) {
  return escaped.replace(_HTTP_URL, (url) => {
    const trail = (url.match(/[),.;!?]+$/) || [""])[0];
    const href = trail ? url.slice(0, -trail.length) : url;
    if (!/^https?:\/\//i.test(href)) return url;
    return `<a class="email-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>${trail}`;
  });
}

function _formatEmailLine(line) {
  const meta = line.match(_EMAIL_META);
  if (meta) {
    return `<span class="email-meta">[<span class="email-hdr-key">${esc(meta[1])}:</span> ${_linkifyEscaped(esc(meta[2]))}]</span>`;
  }
  const hdr = line.match(_EMAIL_HDR);
  if (hdr) {
    return `${esc(hdr[1])}<span class="email-hdr-key">${esc(hdr[2])}:</span> <span class="email-hdr-val">${_linkifyEscaped(esc(hdr[3]))}</span>`;
  }
  const e = _linkifyEscaped(esc(line));
  if (_ON_WROTE.test(line) || _ORIG_MSG.test(line.trim()) || _FWD_MSG.test(line.trim())) {
    return `<span class="email-quote-marker">${e}</span>`;
  }
  return e;
}

function _formatEmailBlock(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i])) {
      const chunk = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) chunk.push(lines[i++]);
      out.push(`<blockquote class="email-quote">${chunk.map(_formatEmailLine).join("\n")}</blockquote>`);
      continue;
    }
    out.push(_formatEmailLine(lines[i++]));
  }
  return out.join("\n");
}

function _quoteStartIndex(lines) {
  let body = 0;
  while (
    body < lines.length &&
    (lines[body].trim() === "" || _EMAIL_META.test(lines[body].trim()))
  ) {
    body += 1;
  }
  for (let i = body; i < lines.length; i++) {
    const t = lines[i].trim();
    if (_ON_WROTE.test(t) || _ORIG_MSG.test(t) || _FWD_MSG.test(t)) return i;
    if (/^From:\s+\S/i.test(t) && i > body) {
      const next = (lines[i + 1] || "").trim();
      if (/^(Sent|To|Subject|Date):/i.test(next)) return i;
    }
    if (t.startsWith(">") && i > body) return i;
  }
  return -1;
}

/** XSS-safe HTML for the Review body: latest ask, then a collapsed thread. */
export function formatEmailBody(raw) {
  if (!raw) return "";
  const lines = String(raw).split(/\r?\n/);
  const q = _quoteStartIndex(lines);
  const latest = q > 0 ? lines.slice(0, q) : lines;
  const quoted = q > 0 ? lines.slice(q) : [];
  const latestHasText = latest.some((l) => l.trim() && !_EMAIL_META.test(l.trim()));
  if (q <= 0 || !latestHasText || !quoted.length) {
    return `<div class="email-latest">${_formatEmailBlock(lines)}</div>`;
  }
  return (
    `<div class="email-latest">${_formatEmailBlock(latest)}</div>` +
    `<details class="email-quoted">` +
    `<summary>Earlier messages</summary>` +
    `<div class="email-quoted-body">${_formatEmailBlock(quoted)}</div>` +
    `</details>`
  );
}

/**
 * Show “Add to Players” when the slot is an unmatched inbox person (or a
 * parsed name/USTA) rather than a real Setup Players catalog id.
 */
export function inboxAddPlayerVisible({ catalogPlayerId, inboxPerson, catalogByUsta } = {}) {
  const pid = catalogPlayerId == null ? "" : String(catalogPlayerId).trim();
  if (pid && parseInboxOptionValue(pid) == null) return false;
  if (!inboxPerson) return false;
  const name = _personNameRaw(inboxPerson);
  const usta = _personUsta(inboxPerson);
  if (!name && !usta) return false;
  const promoted = inboxPerson.promoted_player_id;
  if (promoted != null && String(promoted).trim() !== "") return false;
  if (usta && _ustaInCatalogMap(usta, catalogByUsta)) return false;
  return true;
}
