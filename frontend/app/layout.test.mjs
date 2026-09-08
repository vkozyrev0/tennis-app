// DOM-free tests for viewport-fill grid height (Inbox must not collapse to 0).
// Run: node frontend/app/layout.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIST_MIN_HEIGHT, LIST_HEADER_ROW_HEIGHT, LIST_BOTTOM_PAD, LIST_KEEP_MIN,
  listMountHeight, listBodyMinFromMount, listMinBodyHeight, listFitsViewport, listFitMin,
  measureListBelowPx,
} from "./layout.js";

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("list min height is enough for AG header + scrollbar + body rows", () => {
  assert.ok(LIST_MIN_HEIGHT >= 140, LIST_MIN_HEIGHT);
  assert.ok(LIST_MIN_HEIGHT >= 220, LIST_MIN_HEIGHT);
  assert.ok(LIST_MIN_HEIGHT >= 380, LIST_MIN_HEIGHT);
  assert.ok(listBodyMinFromMount(LIST_MIN_HEIGHT) >= listMinBodyHeight(),
    listBodyMinFromMount(LIST_MIN_HEIGHT));
  assert.ok(listBodyMinFromMount(LIST_MIN_HEIGHT) >= 64, "need ~2 data rows of body");
});

test("mount height is 0 when top is already past the usable viewport", () => {
  const h = listMountHeight({ viewportHeight: 800, top: 900 });
  assert.equal(h, 0);
  assert.equal(listFitsViewport({ top: 900, height: h, viewportHeight: 800 }), true);
});

test("representative inbox viewport fills remaining space without crossing the bottom", () => {
  const top = 420, vh = 900, pad = 16;
  const h = listMountHeight({ viewportHeight: vh, top, bottomPad: pad, mountsBelow: 0 });
  assert.equal(h, Math.floor(vh - top - pad));
  assert.ok(h >= LIST_MIN_HEIGHT, h);
  assert.equal(listFitsViewport({ top, height: h, viewportHeight: vh, bottomPad: pad }), true);
});

test("short remaining space is used as-is instead of a 380px floor that would scroll the page", () => {
  const top = 500, vh = 700, pad = LIST_BOTTOM_PAD;
  const h = listMountHeight({ viewportHeight: vh, top, bottomPad: pad });
  assert.equal(h, Math.floor(vh - top - pad));
  assert.ok(h < LIST_MIN_HEIGHT, h);
  assert.equal(listFitsViewport({ top, height: h, viewportHeight: vh, bottomPad: pad }), true);
});

test("below-grid HTML is reserved so following siblings stay in view", () => {
  const top = 200, vh = 800, pad = LIST_BOTTOM_PAD, belowPx = 180;
  const h = listMountHeight({ viewportHeight: vh, top, bottomPad: pad, belowPx });
  assert.equal(h, Math.floor(vh - top - pad - belowPx));
  assert.equal(listFitsViewport({ top, height: h, viewportHeight: vh, bottomPad: pad }), true);
  assert.ok(top + h + belowPx <= vh - pad + 0.5);
});

test("oversized below-grid content keeps a usable grid strip instead of swallowing the page", () => {
  const top = 200, vh = 700, pad = LIST_BOTTOM_PAD, belowPx = 600;
  const h = listMountHeight({ viewportHeight: vh, top, bottomPad: pad, belowPx });
  const remaining = Math.floor(vh - top - pad);
  const keepMin = Math.min(
    remaining,
    Math.max(listFitMin(), Math.min(LIST_KEEP_MIN, Math.floor(remaining * 0.45))),
  );
  assert.equal(h, keepMin);
  assert.ok(h < remaining, "must still leave a peek of after-grid HTML");
  assert.equal(listFitsViewport({ top, height: h, viewportHeight: vh, bottomPad: pad }), true);
});

test("measureListBelowPx is a no-op without a DOM node", () => {
  assert.equal(measureListBelowPx(null), 0);
  assert.equal(measureListBelowPx(undefined), 0);
});

test("stacked mounts leave room so the last one still fits in the viewport", () => {
  const vh = 700, pad = LIST_BOTTOM_PAD;
  const firstTop = 200;
  const first = listMountHeight({ viewportHeight: vh, top: firstTop, bottomPad: pad, mountsBelow: 1 });
  assert.equal(listFitsViewport({ top: firstTop, height: first, viewportHeight: vh, bottomPad: pad }), true);
  const secondTop = firstTop + first + 8;
  const second = listMountHeight({ viewportHeight: vh, top: secondTop, bottomPad: pad, mountsBelow: 0 });
  assert.ok(second >= 0);
  assert.equal(listFitsViewport({ top: secondTop, height: second, viewportHeight: vh, bottomPad: pad }), true);
  assert.ok(firstTop + first + second <= vh - pad + 8);
  assert.ok(listFitMin() > 0);
});

test("inbox grid is a sized grid-mount; action cells keep pointer-events", () => {
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /makeReadGrid[\s\S]*className = "grid-mount"/);
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /makeReadGrid\("inbox-table"/);
  assert.match(inbox, /cssClass: "grid-actions-cell"/);
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  assert.match(css, /ag-cell\.grid-actions-cell/);
  assert.match(css, /pointer-events:\s*auto/);
  assert.doesNotMatch(css, /grid-actions-cell[^}]*pointer-events:\s*none/);
  assert.match(css, /\.grid-mount\s*\{[^}]*min-height:\s*0/);
  assert.doesNotMatch(css, /\.grid-mount\s*\{[^}]*min-height:\s*380px/);
  assert.match(css, /ag-body-viewport\s*\{\s*min-height:\s*96px/);
  const layout = readFileSync(join(here, "layout.js"), "utf8");
  assert.match(layout, /el\.style\.minHeight = "0"/);
  assert.doesNotMatch(layout, /el\.style\.minHeight = MIN_H/);
  assert.doesNotMatch(grids, /["']50vh["']/);
  assert.doesNotMatch(grids, /["']55vh["']/);
  const playerList = readFileSync(join(here, "player_list.js"), "utf8");
  assert.doesNotMatch(playerList, /["']55vh["']/);
  const roster = readFileSync(join(here, "roster.js"), "utf8");
  assert.doesNotMatch(roster, /["']50vh["']/);
  assert.match(layout, /measureListBelowPx/);
  assert.match(layout, /belowPx/);
});

test("grid headers stay 8pt in a 20px Quartz header row", () => {
  const theme = readFileSync(join(here, "../vendor/ag-theme-courtops.css"), "utf8");
  assert.match(theme, /--ag-header-height:\s*20px/);
  assert.match(theme, /--ag-font-size:\s*8pt/);
  assert.match(theme, /font-size:\s*8pt/);
  assert.match(theme, /--ag-icon-size:\s*12px/);
  assert.doesNotMatch(theme, /--ag-header-height:\s*16px/);
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /ag-theme-courtops\.css\?v=/);
  assert.equal(LIST_HEADER_ROW_HEIGHT, 20);
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /headerHeight:\s*LIST_HEADER_ROW_HEIGHT/);
  assert.match(grids, /function _agLegacyCssTheme/);
  assert.match(grids, /return "legacy"/);
  assert.doesNotMatch(grids, /theme:\s*"legacy",/);
  assert.doesNotMatch(grids, /floatingFiltersHeight:\s*LIST_HEADER_ROW_HEIGHT/);
});

test("header labels cannot wrap to a second line or auto-grow", () => {
  const theme = readFileSync(join(here, "../vendor/ag-theme-courtops.css"), "utf8");
  assert.match(theme, /white-space:\s*nowrap\s*!important/);
  assert.match(theme, /font-size:\s*8pt\s*!important/);
  assert.match(theme, /ag-header-row-column-filter/);
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /wrapHeaderText:\s*false/);
  assert.match(grids, /autoHeaderHeight:\s*false/);
  assert.match(grids, /floatingFilter:\s*false/);
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /title:\s*"Player 1"/);
  assert.match(inbox, /title:\s*"Player 2"/);
  assert.doesNotMatch(inbox, /title:\s*"Player 1",\s*columns:/);
  const roster = readFileSync(join(here, "roster.js"), "utf8");
  assert.match(roster, /title:\s*"Player"/);
});

test("header and login use the My Ad, LLC brand assets", () => {
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /\/brand\/my-ad-mark\.png/);
  assert.match(html, /\/brand\/my-ad-llc\.png/);
  assert.match(html, /\/brand\/favicon\.png/);
  assert.match(html, /My Ad, LLC/);
});

test("help dialog fills the viewport instead of a fixed 28rem body", () => {
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  assert.match(css, /\.modal-box--help[\s\S]*100dvh/);
  assert.match(css, /\.help-layout[\s\S]*flex:\s*1/);
  assert.doesNotMatch(css, /\.help-body[\s\S]{0,200}max-height:\s*min\(58vh/);
  assert.match(css, /@media \(max-width:\s*720px\)/);
  assert.match(css, /@media \(max-height:\s*560px\)/);
});

test("L1 section chip uses paper + ball bar when current, not a same-green fill", () => {
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  const active = css.match(/\.gbtn\.active,[\s\S]*?\.gbtn\[aria-current="true"\] \{[^}]+\}/);
  assert.ok(active, "L1 current-state rule missing");
  assert.match(active[0], /background:\s*var\(--bg\)/);
  assert.match(active[0], /--ball/);
  assert.doesNotMatch(active[0], /--court-deep/);
  const app = readFileSync(join(here, "../app.js"), "utf8");
  assert.match(app, /markL1Current\(_groupsEl\.children, key\)/);
});

test("signed-in L1 is a court sideline, not a stacked top bar", () => {
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  const tokens = readFileSync(join(here, "../tokens.css"), "utf8");
  assert.match(tokens, /--nav-sideline:\s*9\.5rem/);
  assert.match(css, /grid-template-areas:[\s\S]{0,80}l1/);
  assert.match(css, /flex-direction:\s*column/);
  assert.match(css, /inset -3px 0 0 var\(--ball/);
  const mobile = css.match(/@media \(max-width:\s*720px\) \{[\s\S]*?flex-direction:\s*row/);
  assert.ok(mobile, "narrow viewports must return L1 to a top strip");
});

test("guidelines audit: focus, overscroll, tap, and safe-area", () => {
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  assert.match(css, /touch-action:\s*manipulation/);
  assert.match(css, /\.skip-link:focus-visible/);
  assert.match(css, /\.modal\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.doesNotMatch(css, /\.dash-dl-item:hover, \.dash-dl-item:focus-visible \{[^}]*outline:\s*none/);
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /name="theme-color"/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /fetchpriority="high"/);
  assert.match(html, /type="tel"/);
});

console.log(`\n${passed} layout checks passed`);
