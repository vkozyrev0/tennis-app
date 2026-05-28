// Pure utility module (audit A47): dependency-free helpers used everywhere.
// Pulled out of the monolithic app.js as a first ESM split — others can follow
// (auth.js, grids.js, setup.js, workspace.js) once a frontend test harness is
// in place to catch regressions.

// HTML-escape user content. Escapes &, <, > — together that's enough to keep
// a hostile name from breaking out of any attribute or text content we emit
// via template literals; `<` alone defeats `</style>` / `</script>` breakouts.
export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
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
