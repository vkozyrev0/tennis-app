// Node tests for TD walkthrough helpers (blank email, menu clamp, locale dates, hash).
// Run: node frontend/app/td_helpers.test.mjs
import assert from "node:assert/strict";
import {
  emailCreateGuard,
  fitMenuBox,
  parseLocaleDate,
  formatLocaleDate,
  hashForPanel,
  panelFromHash,
  COMING_SOON_LABEL,
  isVenueRole,
  toastLifetime,
  looksLikeAgeDivision,
  healthPillText,
} from "./td_helpers.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("blank email rejected when from, subject, and body are empty", () => {
  const g = emailCreateGuard({ from_address: "", subject: "  ", body: null });
  assert.equal(g.ok, false);
  assert.ok(g.reason && /from|subject|body/i.test(g.reason));
  assert.ok(g.fields.includes("from_address"));
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

test("format ISO as MM/DD/YYYY", () => {
  assert.equal(formatLocaleDate("2026-09-15"), "09/15/2026");
  assert.equal(formatLocaleDate("2026-01-05"), "01/05/2026");
  assert.equal(formatLocaleDate(""), "");
});

test("round-trip locale date display", () => {
  assert.equal(parseLocaleDate(formatLocaleDate("2026-11-02")), "2026-11-02");
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

test("health pill shows LLM when the sidecar is up", () => {
  assert.equal(healthPillText({ db: "ok", llm: "off" }).text, "API + DB ok");
  assert.equal(healthPillText({ db: "ok", llm: "ok" }).text, "API + DB + LLM ok");
  assert.equal(healthPillText({ db: "ok", llm: "down" }).kind, "warn");
  assert.match(healthPillText({ db: "ok", llm: "down" }).text, /LLM down/);
  assert.equal(healthPillText({ db: "down" }).kind, "bad");
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
