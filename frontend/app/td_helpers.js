// Pure helpers for the TD walkthrough fixes. DOM-free so Node tests can
// pin blank-email, viewport-fit menus, locale dates, and hash routing
// without a browser.

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

/** Header health pill from GET /api/health { db, llm }. */
export function healthPillText({ db, llm } = {}) {
  if (db !== "ok") {
    return { text: "DB " + (db || "down"), kind: "bad" };
  }
  if (llm === "ok") return { text: "API + DB + LLM ok", kind: "ok" };
  if (llm === "down") return { text: "API + DB ok · LLM down", kind: "warn" };
  return { text: "API + DB ok", kind: "ok" };
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
