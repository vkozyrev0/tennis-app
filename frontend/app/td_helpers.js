// Pure helpers for the TD walkthrough fixes. DOM-free so Node tests can
// pin blank-email, viewport-fit menus, locale dates, and hash routing
// without a browser.

/** Persistent validation target on the Add-email form (not a vanishing toast). */
export const EMAIL_MSG_ID = "email-msg";

/** Reject Add-email when from, subject, and body are all blank. */
export function emailCreateGuard(payload) {
  const from = String(payload?.from_address ?? payload?.from ?? "").trim();
  const subject = String(payload?.subject ?? "").trim();
  const body = String(payload?.body ?? "").trim();
  if (from || subject || body) return { ok: true, reason: null, fields: [] };
  return {
    ok: false,
    reason: "Enter a from address, subject, or body — blank emails are not saved",
    fields: ["from_address", "subject", "body"],
  };
}

/**
 * Place a menu so it stays fully inside the viewport.
 * Prefer below the trigger; flip above when the bottom would clip; clamp.
 * Returns { top, left, bottom, right } in CSS pixels.
 */
export function fitMenuBox({
  triggerTop = 0, triggerBottom = 0, triggerLeft = 0, triggerRight = 0,
  menuWidth = 0, menuHeight = 0,
  viewportWidth = 0, viewportHeight = 0,
  gap = 4,
} = {}) {
  const vw = Math.max(0, Number(viewportWidth) || 0);
  const vh = Math.max(0, Number(viewportHeight) || 0);
  const mw = Math.max(0, Number(menuWidth) || 0);
  const mh = Math.max(0, Number(menuHeight) || 0);
  const g = Number(gap) || 0;
  const tTop = Number(triggerTop) || 0;
  const tBottom = Number(triggerBottom) || 0;
  const tLeft = Number(triggerLeft) || 0;
  const tRight = Number(triggerRight) || 0;

  let top = tBottom + g;
  const overflowBelow = top + mh > vh;
  const fitsAbove = tTop - g - mh >= 0;
  if (overflowBelow && fitsAbove) top = tTop - g - mh;
  if (top + mh > vh) top = Math.max(0, vh - mh);
  if (top < 0) top = 0;

  let left = tRight - mw;
  if (left < 0) left = tLeft;
  if (left + mw > vw) left = Math.max(0, vw - mw);
  if (left < 0) left = 0;

  return { top, left, bottom: top + mh, right: left + mw };
}

function _validYmd(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parse ISO YYYY-MM-DD or locale M/D/YYYY (also M/D/YY → 20YY) to YYYY-MM-DD. */
export function parseLocaleDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    return _validYmd(y, m, d) ? s : null;
  }
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (mdy) {
    let y = Number(mdy[3]);
    if (y < 100) y += 2000;
    const m = Number(mdy[1]), d = Number(mdy[2]);
    if (!_validYmd(y, m, d)) return null;
    return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  return null;
}

/**
 * AG Grid date valueParser: locale MM/DD/YYYY or ISO → ISO only.
 * Malformed input keeps the previous ISO (never passes garbage to AG).
 */
export function dateCellParser(newValue, oldValue) {
  const parsed = parseLocaleDate(newValue);
  if (parsed != null) return parsed;
  if (newValue == null || String(newValue).trim() === "") return null;
  return parseLocaleDate(oldValue);
}

/** Display ISO YYYY-MM-DD as MM/DD/YYYY (empty string when missing). */
export function formatLocaleDate(iso) {
  const parsed = parseLocaleDate(iso);
  if (!parsed) return iso ? String(iso) : "";
  const [y, m, d] = parsed.split("-");
  return `${m}/${d}/${y}`;
}

export function hashForPanel(panelId) {
  const id = String(panelId || "").replace(/^#/, "").trim();
  return id ? `#${id}` : "#";
}

export function panelFromHash(hash) {
  const h = String(hash || "").replace(/^#/, "").trim();
  return h || null;
}

/** Mark the L1 section button for `key` as the current location. */
export function markL1Current(buttons, key) {
  const list = buttons && typeof buttons[Symbol.iterator] === "function" ? [...buttons] : [];
  const want = String(key || "");
  for (const b of list) {
    const on = String(b.dataset?.group || "") === want;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
}

export const COMING_SOON_LABEL = "Match / draw / scoring — coming soon";

/** Chair / referee roles must have a site; roving may omit one. */
export const VENUE_ROLES = Object.freeze([
  "chair_umpire",
  "tournament_referee",
  "deputy_referee",
  "referee_in_training",
]);

export function isVenueRole(workingAs) {
  return VENUE_ROLES.includes(String(workingAs || ""));
}

/**
 * How long a toast stays on screen (ms). `null` means stick until dismissed.
 * Most toasts time out; action-required and explicit sticky ones stay.
 */
export function toastLifetime({ ok = true, sticky = false, hasAction = false } = {}) {
  if (sticky || hasAction) return null;
  return ok ? 2500 : 6000;
}

/** User-facing name for the local leftover/chat model. Not "LLM". */
export const INTEL_LABEL = "Intelligence";

/**
 * Three independent header indicators from GET /api/health.
 * `reachable` is false when the health request itself failed.
 * `llm` is the wire field (ok|off|down); the UI label is Intelligence.
 */
export function healthIndicators({ reachable = true, db, llm } = {}) {
  if (!reachable) {
    return [
      { id: "api", label: "API", kind: "bad",
        title: "API unreachable" },
      { id: "db", label: "DB", kind: "warn",
        title: "Database status unknown — API did not answer" },
      { id: "intel", label: INTEL_LABEL, kind: "warn",
        title: INTEL_LABEL + " status unknown — API did not answer" },
    ];
  }
  const dbOk = db === "ok";
  let intelKind = "off";
  let intelTitle = INTEL_LABEL + " is off — leftover inbox mail uses keyword triage only";
  if (llm === "ok") {
    intelKind = "ok";
    intelTitle = INTEL_LABEL + " is on";
  } else if (llm === "down") {
    intelKind = "warn";
    intelTitle = INTEL_LABEL + " is on but not answering";
  }
  return [
    { id: "api", label: "API", kind: "ok", title: "API reachable" },
    { id: "db", label: "DB", kind: dbOk ? "ok" : "bad",
      title: dbOk ? "Database reachable" : "Database " + (db || "down") },
    { id: "intel", label: INTEL_LABEL, kind: intelKind, title: intelTitle },
  ];
}

/** One-line dashboard copy for Intelligence (never says LLM / sidecar). */
export function intelStatusLine(llm) {
  if (llm === "ok") {
    return INTEL_LABEL + " is on — leftover inbox mail can be classified on this machine.";
  }
  if (llm === "down") {
    return INTEL_LABEL + " is on but not answering — leftover mail uses keyword triage only.";
  }
  return INTEL_LABEL + " is off — leftover mail uses keyword triage only.";
}

/** Paint the three header chips. */
export function applyHealthPills(cluster, indicators) {
  if (!cluster || !indicators) return;
  for (const ind of indicators) {
    const el = cluster.querySelector(`[data-svc="${ind.id}"]`);
    if (!el) continue;
    el.className = "pill health-pill " + ind.kind;
    el.textContent = ind.label;
    el.title = ind.title;
    el.setAttribute("aria-label", ind.label + ": " + ind.title);
  }
}

/** Roster/import age-division: junior B14/G16 or adult NTRP/Combo labels. */
export function looksLikeAgeDivision(value, catalog) {
  const s = String(value || "").trim();
  if (!s) return false;
  if (/^[bg]\s?-?\s?(10|12|14|16|18)$/i.test(s)) return true;
  if (/^(boys|girls)\s+(10|12|14|16|18)(?:\s*(?:&|and)\s*under)?$/i.test(s)) return true;
  if (/^(?:ntrp\s+)?(?:combo\s+)?(?:\d(?:\.\d)?|open)(?:\s+(?:men|women|mens|womens))?$/i.test(s)) return true;
  if (Array.isArray(catalog)) {
    const low = s.toLowerCase();
    if (catalog.some((d) => {
      const code = String(d && (d.code || "")).toLowerCase();
      const label = String(d && (d.label || d.name || "")).toLowerCase();
      return code === low || label === low;
    })) return true;
  }
  return false;
}
