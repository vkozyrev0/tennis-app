// Node tests for TD walkthrough helpers (blank email, menu clamp, locale dates, hash).
// Run: node frontend/app/td_helpers.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  emailCreateGuard,
  EMAIL_MSG_ID,
  fitMenuBox,
  parseLocaleDate,
  dateCellParser,
  formatLocaleDate,
  hashForPanel,
  panelFromHash,
  markL1Current,
  COMING_SOON_LABEL,
  isVenueRole,
  toastLifetime,
  looksLikeAgeDivision,
  healthIndicators,
  applyHealthPills,
  intelStatusLine,
  INTEL_LABEL,
} from "./td_helpers.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

const here = dirname(fileURLToPath(import.meta.url));

test("blank email rejected when from, subject, and body are empty", () => {
  const g = emailCreateGuard({ from_address: "", subject: "  ", body: null });
  assert.equal(g.ok, false);
  assert.ok(g.reason && /from|subject|body/i.test(g.reason));
  assert.ok(g.fields.includes("from_address"));
});

test("blank-email reason is the message written to #email-msg", () => {
  assert.equal(EMAIL_MSG_ID, "email-msg");
  const g = emailCreateGuard({ from_address: "", subject: "", body: "" });
  assert.equal(g.ok, false);
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /setMsg\(EMAIL_MSG_ID, guard\.reason/);
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /id="email-msg"/);
  assert.equal(g.reason, "Enter a from address, subject, or body — blank emails are not saved");
});

test("email with only a subject is allowed", () => {
  assert.equal(emailCreateGuard({ subject: "Late entry" }).ok, true);
  assert.equal(emailCreateGuard({ from_address: "a@b.c" }).ok, true);
  assert.equal(emailCreateGuard({ body: "Can we still enter?" }).ok, true);
});

test("menu near the bottom of the viewport stays fully on-screen", () => {
  const box = fitMenuBox({
    triggerTop: 740, triggerBottom: 768, triggerLeft: 900, triggerRight: 980,
    menuWidth: 220, menuHeight: 160,
    viewportWidth: 1024, viewportHeight: 800, gap: 4,
  });
  assert.ok(box.bottom <= 800, `menu bottom ${box.bottom} exceeds viewport`);
  assert.ok(box.top >= 0, `menu top ${box.top} is offscreen`);
  assert.ok(box.left >= 0 && box.right <= 1024);
  // Delete is the last item — it lives at the menu bottom, so it stays in-bounds.
  const deleteBottom = box.bottom;
  assert.ok(deleteBottom <= 800, "Delete item would clip below the viewport");
});

test("menu below a high trigger does not flip", () => {
  const box = fitMenuBox({
    triggerTop: 40, triggerBottom: 68, triggerLeft: 10, triggerRight: 90,
    menuWidth: 200, menuHeight: 120,
    viewportWidth: 800, viewportHeight: 600, gap: 4,
  });
  assert.equal(box.top, 72);
});

test("parse MM/DD/YYYY to ISO YYYY-MM-DD", () => {
  assert.equal(parseLocaleDate("09/15/2026"), "2026-09-15");
  assert.equal(parseLocaleDate("9/5/2026"), "2026-09-05");
  assert.equal(parseLocaleDate("2026-09-15"), "2026-09-15");
});

test("parse rejects malformed dates", () => {
  assert.equal(parseLocaleDate("13/40/2026"), null);
  assert.equal(parseLocaleDate("not-a-date"), null);
  assert.equal(parseLocaleDate(""), null);
});

test("dateCellParser locale and ISO become ISO; malformed keeps prior ISO", () => {
  assert.equal(dateCellParser("09/15/2026", "2026-01-01"), "2026-09-15");
  assert.equal(dateCellParser("2026-09-15", null), "2026-09-15");
  assert.equal(dateCellParser("not-a-date", "2026-09-15"), "2026-09-15");
  assert.equal(dateCellParser("13/40/2026", "2026-09-15"), "2026-09-15");
  assert.equal(dateCellParser("garbage", null), null);
  assert.equal(dateCellParser("", "2026-09-15"), null);
  const grids = readFileSync(join(here, "grids.js"), "utf8");
  assert.match(grids, /dateCellParser\(p\.newValue, p\.oldValue\)/);
  assert.match(grids, /cellEditor = "agTextCellEditor"/);
  assert.doesNotMatch(grids, /agDateStringCellEditor/);
});

test("format ISO as MM/DD/YYYY", () => {
  assert.equal(formatLocaleDate("2026-09-15"), "09/15/2026");
  assert.equal(formatLocaleDate("2026-01-05"), "01/05/2026");
  assert.equal(formatLocaleDate(""), "");
});

test("round-trip locale date display", () => {
  assert.equal(parseLocaleDate(formatLocaleDate("2026-11-02")), "2026-11-02");
});

test("markL1Current sets active class and aria-current on the matching L1 button", () => {
  function fakeBtn(group) {
    const classes = new Set();
    const attrs = {};
    return {
      dataset: { group },
      classList: {
        toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      setAttribute(k, v) { attrs[k] = v; },
      removeAttribute(k) { delete attrs[k]; },
      attrs,
    };
  }
  const home = fakeBtn("home");
  const inbox = fakeBtn("inbox");
  markL1Current([home, inbox], "inbox");
  assert.equal(home.classList.contains("active"), false);
  assert.equal(home.attrs["aria-current"], undefined);
  assert.equal(inbox.classList.contains("active"), true);
  assert.equal(inbox.attrs["aria-current"], "true");
  markL1Current([home, inbox], "home");
  assert.equal(home.classList.contains("active"), true);
  assert.equal(home.attrs["aria-current"], "true");
  assert.equal(inbox.classList.contains("active"), false);
  assert.equal(inbox.attrs["aria-current"], undefined);
});

test("hash serializes and restores a panel id", () => {
  assert.equal(hashForPanel("panel-t-inbox"), "#panel-t-inbox");
  assert.equal(panelFromHash("#panel-t-inbox"), "panel-t-inbox");
  assert.equal(panelFromHash(hashForPanel("panel-home")), "panel-home");
});

test("coming-soon label names match/draw/scoring", () => {
  assert.match(COMING_SOON_LABEL, /coming soon/i);
  assert.match(COMING_SOON_LABEL, /match/i);
});

test("most toasts time out; sticky and action toasts persist", () => {
  assert.equal(toastLifetime({ ok: true }), 2500);
  assert.equal(toastLifetime({ ok: false }), 6000);
  assert.equal(toastLifetime({ ok: false, sticky: true }), null);
  assert.equal(toastLifetime({ ok: true, hasAction: true }), null);
});

test("health is three independent indicators named API, DB, Intelligence", () => {
  const allOk = healthIndicators({ db: "ok", llm: "ok" });
  assert.deepEqual(allOk.map((x) => x.id), ["api", "db", "intel"]);
  assert.equal(allOk[0].kind, "ok");
  assert.equal(allOk[1].kind, "ok");
  assert.equal(allOk[2].kind, "ok");
  assert.equal(allOk[2].label, INTEL_LABEL);
  assert.equal(INTEL_LABEL, "Intelligence");

  const intelOff = healthIndicators({ db: "ok", llm: "off" });
  assert.equal(intelOff[0].kind, "ok");
  assert.equal(intelOff[1].kind, "ok");
  assert.equal(intelOff[2].kind, "off");

  const intelDown = healthIndicators({ db: "ok", llm: "down" });
  assert.equal(intelDown[2].kind, "warn");
  assert.match(intelDown[2].title, /Intelligence/);
  assert.doesNotMatch(intelDown[2].title, /LLM/i);

  const dbDown = healthIndicators({ db: "down", llm: "ok" });
  assert.equal(dbDown[0].kind, "ok");
  assert.equal(dbDown[1].kind, "bad");
  assert.equal(dbDown[2].kind, "ok");

  const apiDown = healthIndicators({ reachable: false });
  assert.equal(apiDown[0].kind, "bad");
  assert.equal(apiDown[1].kind, "warn");
  assert.equal(apiDown[2].kind, "warn");
});

test("intel status line never says LLM", () => {
  assert.match(intelStatusLine("ok"), /Intelligence is on/);
  assert.match(intelStatusLine("down"), /not answering/);
  assert.match(intelStatusLine("off"), /is off/);
  for (const s of ["ok", "down", "off"]) {
    assert.doesNotMatch(intelStatusLine(s), /LLM|sidecar|llama/i);
  }
});

test("applyHealthPills paints each chip from indicators", () => {
  const cluster = {
    nodes: {
      api: { className: "", textContent: "", title: "", attrs: {} },
      db: { className: "", textContent: "", title: "", attrs: {} },
      intel: { className: "", textContent: "", title: "", attrs: {} },
    },
    querySelector(sel) {
      const m = /data-svc="(\w+)"/.exec(sel);
      const n = m && this.nodes[m[1]];
      if (!n) return null;
      return {
        get className() { return n.className; },
        set className(v) { n.className = v; },
        get textContent() { return n.textContent; },
        set textContent(v) { n.textContent = v; },
        get title() { return n.title; },
        set title(v) { n.title = v; },
        setAttribute(k, v) { n.attrs[k] = v; },
      };
    },
  };
  applyHealthPills(cluster, healthIndicators({ db: "ok", llm: "down" }));
  assert.equal(cluster.nodes.api.className, "pill health-pill ok");
  assert.equal(cluster.nodes.db.className, "pill health-pill ok");
  assert.equal(cluster.nodes.intel.className, "pill health-pill warn");
  assert.equal(cluster.nodes.intel.textContent, "Intelligence");
  assert.match(cluster.nodes.intel.attrs["aria-label"], /Intelligence/);
});

test("login card is visible without waiting for JS health", () => {
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /id="login-view"/);
  assert.doesNotMatch(html, /id="login-view" hidden/);
});

test("healthy health-chip pips are green, not tennis-ball yellow", () => {
  const css = readFileSync(join(here, "../styles.css"), "utf8");
  const cluster = css.match(/\.health-cluster[\s\S]*?\.health-cluster \.pill\.off[^}]+}/);
  assert.ok(cluster, "health-cluster rules missing");
  assert.match(cluster[0], /\.pill\.ok::before \{ background: #5bbf6a; \}/);
  assert.doesNotMatch(cluster[0], /--ball/);
  assert.doesNotMatch(cluster[0], /#d6ec4a/);
});

test("header markup has three health chips and Chat lives under Home", () => {
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /id="health-cluster"/);
  assert.match(html, /data-svc="api"/);
  assert.match(html, /data-svc="db"/);
  assert.match(html, /data-svc="intel"/);
  assert.doesNotMatch(html, /id="health"/);
  assert.doesNotMatch(html, /API \+ DB/);
  assert.doesNotMatch(html, /data-group="chat"/);
  const homeAt = html.indexOf('class="menu-group group-active" data-group="home"');
  assert.ok(homeAt >= 0);
  const homeBlock = html.slice(homeAt, html.indexOf("</div>", homeAt + 1) + 6);
  assert.match(homeBlock, /panel-home/);
  assert.match(homeBlock, /panel-td-chat/);
  assert.match(html, />Division flex</);
  assert.match(html, />Pairing avoidances</);
});

test("age division accepts NTRP 3.5 Men and junior codes, rejects blank", () => {
  assert.equal(looksLikeAgeDivision("NTRP 3.5 Men"), true);
  assert.equal(looksLikeAgeDivision("B14"), true);
  assert.equal(looksLikeAgeDivision("G16"), true);
  assert.equal(looksLikeAgeDivision("Combo 7.5"), true);
  assert.equal(looksLikeAgeDivision("Boys 14"), true);
  assert.equal(looksLikeAgeDivision("Boys 14 & Under"), true);
  assert.equal(looksLikeAgeDivision("Girls 16 and Under"), true);
  assert.equal(looksLikeAgeDivision(""), false);
  assert.equal(looksLikeAgeDivision("   "), false);
  assert.equal(looksLikeAgeDivision("bananas"), false);
  assert.equal(looksLikeAgeDivision("NTRP 3.5 Men", [{ code: "B14", label: "Boys 14 & Under" }]), true);
  assert.equal(looksLikeAgeDivision("Custom Div", [{ code: "X", label: "Custom Div" }]), true);
});

test("venue roles need a site; roving does not", () => {
  assert.equal(isVenueRole("chair_umpire"), true);
  assert.equal(isVenueRole("tournament_referee"), true);
  assert.equal(isVenueRole("roving_official"), false);
});

console.log(`\n${passed} passed`);
