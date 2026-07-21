// Pure utility module (audit A47): dependency-free helpers used everywhere.
// Pulled out of the monolithic app.js as a first ESM split — others can follow
// (auth.js, grids.js, setup.js, workspace.js) once a frontend test harness is
// in place to catch regressions.

// HTML-escape user content. Escapes &, <, >, ", ' so values are safe in both
// text content and attribute contexts (audit F2 / 2026-07-20 deep dive).
// `<` alone defeats `</style>` / `</script>` breakouts; quotes stop attribute injection.
export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Audit P38 + N33: every ISO date formatter parses + renders in UTC so a TD
// near a TZ boundary never sees an off-by-one weekday.
export function isoToUTCDate(iso) { return new Date(iso + "T00:00:00Z"); }
export function fmtIsoUTC(iso, opts) {
  return isoToUTCDate(iso).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
}
export function fmtDOW(iso) {
  if (!iso) return "";
  return iso + " (" + fmtIsoUTC(iso, { weekday: "short" }) + ")";
}
export function dowLong(iso) { return fmtIsoUTC(iso, { weekday: "long" }); }
export function fmtMDY(iso) {
  return iso ? fmtIsoUTC(iso, { month: "numeric", day: "numeric", year: "2-digit" }) : "";
}

// Turn a FastAPI 422 validation `detail` list into something a TD can read.
// IMPORTANT: callers MUST render the result via `.textContent` (or equivalent)
// — values can contain user-controlled strings (subject lines, player names)
// and this function does no HTML escaping. Audit F19.
export function humanizeDetail(detail, statusText) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const shown = detail.slice(0, 3).map((d) => {
      const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
      const msg = d.msg || d.type || "invalid";
      return field ? `${field}: ${msg}` : msg;
    }).join("; ");
    const extra = detail.length - 3;
    return extra > 0 ? `${shown} (+ ${extra} more)` : shown;
  }
  if (detail && typeof detail === "object" && detail.msg) return detail.msg;
  return statusText || "request failed";
}

// CSV download from a 2D matrix; quotes everything to survive embedded commas
// and quotes. Used by every Setup CRUD + the t-shirt + assignment exports.
export function csvDownload(matrix, filename) {
  const csv = matrix
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename + ".csv"; a.click();
  URL.revokeObjectURL(url);
}

// H4.2: columns stripped in "redacted" minors-PII exports (mirror export_gate.py).
const _REDACT_HEADERS = new Set([
  "emails", "email", "phones", "phone", "birthdate", "dob",
  "year_of_birth", "year-of-birth", "body", "from_address", "from",
  "parent_email", "parent_phone", "dietary_preference", "dietary",
]);

/** Drop sensitive columns from a [header, ...rows] matrix. */
export function redactCsvMatrix(matrix) {
  if (!Array.isArray(matrix) || !matrix.length || !Array.isArray(matrix[0])) return matrix;
  const headers = matrix[0];
  const drop = new Set();
  headers.forEach((h, i) => {
    const key = String(h ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    if (_REDACT_HEADERS.has(key) || _REDACT_HEADERS.has(String(h ?? "").trim().toLowerCase())) {
      drop.add(i);
    }
  });
  if (!drop.size) return matrix;
  return matrix.map((row) =>
    Array.isArray(row) ? row.filter((_, i) => !drop.has(i)) : row);
}

/** Heuristic: resource/filename looks like bulk junior/parent PII (H4.2). */
export function isMinorsPiiResource(resource) {
  const r = String(resource || "").trim().toLowerCase().replace(/\s+/g, "_").replace(/\.csv$/, "");
  const base = r.split("/").pop() || r;
  const exact = new Set([
    "players", "player", "roster", "emails", "email", "late_entries", "late-entries",
    "withdrawals", "scheduling-avoidances", "scheduling_avoidances",
    "division-flexibility", "division_flexibility", "pairing-avoidances",
    "pairing_avoidances", "doubles", "doubles_requests", "doubles-requests",
    "player-hotels", "player_hotels", "player_hotel", "tshirts", "t-shirts",
    "adult-lists", "adult_lists",
  ]);
  if (exact.has(base) || exact.has(r)) return true;
  return /^(sign-in|signin|players|roster|emails)/.test(base) ||
    /(sign-in|signin|players|roster|emails)/.test(base);
}


// Inclusive list of ISO dates from start..end (UTC midnight). Audit N20: UTC
// step so DST does not skip/duplicate a day.
export function datesInRange(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
