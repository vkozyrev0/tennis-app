// Tiny auto-escaping HTML template helper (plan P2 #12).
//
// The card builders (renderAssignment et al.) are long string-concat blocks
// that call esc() by hand on every interpolation — easy to forget one (XSS) or
// double-escape. `html` is a tagged template that escapes every ${value} by
// default; wrap trusted pre-built markup in raw() to opt out. The result is a
// Safe wrapper whose toString() is the HTML, so `el.innerHTML = html`…`` works
// and nested `${html`…`}` composes without re-escaping.
import { esc } from "./util.js";

// Marker for "already-safe HTML — do not escape". Not a plain string so a real
// user value can never accidentally pose as safe.
class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

// Wrap trusted HTML (badge markup, an attribute fragment you already escaped,
// the output of another builder) so html`` inserts it verbatim.
export function raw(s) { return new Safe(s == null ? "" : String(s)); }

// Render one interpolated value: null/undefined/booleans → "" (so
// `${cond && html`…`}` and `${x ? … : ""}` work), arrays → concatenated,
// Safe → verbatim, everything else → HTML-escaped text.
function piece(v) {
  if (v == null || v === false || v === true) return "";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(piece).join("");
  return esc(String(v));
}

export function html(strings, ...vals) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < vals.length) out += piece(vals[i]);
  }
  return new Safe(out);
}

// String-returning variant for contexts that require a plain string, not a
// Safe wrapper — notably Tabulator cell formatters (a returned object would
// render as "[object Object]"). Same escaping rules as html``.
export function hstr(strings, ...vals) {
  return html(strings, ...vals).s;
}

export { Safe };
