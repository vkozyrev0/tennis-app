// Shared print/PDF window scaffold (D11 slice from app.js).
//
// The TD-facing exports (hotel report, pay statement(s), 360 export, staffing
// plan, rooming list, schedule) each open a blank window and write a
// self-contained, auto-printing HTML document. They differ only in <title>,
// body markup, and a few doc-specific CSS rules — so the doctype/head, the
// shared print stylesheet, the pop-up guard, the Print/Close controls, the
// auto-print trigger, and (optionally) an embedded CSV-download button live
// here instead of being copy-pasted into every builder.
//
// Injection: callers pass a `title` (escaped here) and a pre-built `body`
// string; every interpolated value inside `body`/`styleExtra` already goes
// through esc() at the call site (escapes &<>), so a name containing
// `</style>` becomes `&lt;/style&gt;` and cannot break out of the document.
// The popup is a fresh document with no shared origin state.

import { esc } from "./util.js";

const PRINT_BASE_CSS = `
      body { font-family: Arial, Helvetica, sans-serif; color: #1f2933; margin: 1.4cm; font-size: 12px; }
      h1 { font-size: 18px; margin: 0 0 0.1rem; }
      h2 { font-size: 13px; margin: 1.1rem 0 0.3rem; border-bottom: 1.5px solid #2e6f40; padding-bottom: .15rem; color: #2e6f40; }
      .sub, .meta { color: #556070; font-size: 11px; margin-bottom: 0.9rem; }
      .line { font-size: 11px; margin: 0.2rem 0 0.6rem; }
      .muted { color: #556070; }
      table { border-collapse: collapse; width: 100%; margin: 0.3rem 0 0.6rem; }
      th, td { border: 1px solid #d9e0e6; padding: 4px 7px; text-align: left; font-size: 11px; }
      th { background: #f4f6f8; font-weight: 700; }
      td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
      td.empty { color: #556070; font-style: italic; text-align: center; }
      tr.totals td { font-weight: 700; background: #e7f1ea; border-top: 2px solid #2e6f40; }
      @media print { @page { margin: 1.2cm; } .noprint { display: none; } h2 { page-break-after: avoid; } }
      .noprint { margin-top: 1rem; } .noprint button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }`;

/**
 * @param {{ toast: (text: string, ok?: boolean) => void }} ctx
 * @returns {(opts: object) => boolean}
 */
export function createPrintDoc(ctx) {
  const { toast } = ctx;

  // Opens the print window and writes the wrapped document. Returns false (after a
  // toast) if pop-ups are blocked, so callers can bail. `styleExtra` is appended
  // after the base CSS so a doc can add or override rules (landscape @page, an
  // .h4 heading, a .grand box, …). `csv` (optional) = {data, filename}: embeds a
  // ⬇ CSV button wired to download that blob. `printLabel` overrides the primary
  // button text.
  return function printDoc({
    title,
    body,
    styleExtra = "",
    printLabel = "Save as PDF / Print",
    csv = null,
    popupMsg = "Allow pop-ups to export the PDF",
  }) {
    const win = window.open("", "_blank");
    if (!win) { toast(popupMsg, false); return false; }
    const csvBtn = csv ? ` <button id="dl">⬇ CSV</button>` : "";
    const csvScript = csv ? `
      document.getElementById("dl").addEventListener("click", function () {
        var blob = new Blob([${JSON.stringify(csv.data)}], {type: "text/csv"});
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = ${JSON.stringify(csv.filename)};
        a.click();
      });` : "";
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
    <style>${PRINT_BASE_CSS}${styleExtra}</style></head><body>
    ${body}
    <div class="noprint"><button onclick="window.print()">${esc(printLabel)}</button>${csvBtn} <button onclick="window.close()">Close</button></div>
    <script>${csvScript}
      window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 250); });
    <\/script>
  </body></html>`);
    win.document.close();
    return true;
  };
}
