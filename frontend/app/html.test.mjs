// Deterministic unit test for the html`` template helper (DOM-free).
// Run: node frontend/app/html.test.mjs
import assert from "node:assert/strict";
import { html, raw, hstr, Safe } from "./html.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("interpolations are HTML-escaped by default", () => {
  const evil = '<img src=x onerror=alert(1)>';
  const out = String(html`<div>${evil}</div>`);
  assert.equal(out, "<div>&lt;img src=x onerror=alert(1)&gt;</div>");
  assert.ok(!out.includes("<img"));
});

test("raw() inserts trusted markup verbatim", () => {
  const badge = '<span class="badge">ok</span>';
  assert.equal(String(html`<p>${raw(badge)}</p>`), '<p><span class="badge">ok</span></p>');
});

test("ampersands and angle brackets in text", () => {
  assert.equal(String(html`${"Tom & Jerry < 5 > 3"}`), "Tom &amp; Jerry &lt; 5 &gt; 3");
});

test("quotes are escaped for attribute safety", () => {
  const evil = `O'Brien "x" onmouseover=alert(1)`;
  const out = String(html`<div title="${evil}">${evil}</div>`);
  assert.ok(out.includes("&#39;") || out.includes("&quot;"));
  assert.ok(!out.includes(`title="${evil}"`));
  assert.equal(
    String(html`${`a"b'c`}`),
    "a&quot;b&#39;c",
  );
});

test("null/undefined/false render as empty, true too", () => {
  assert.equal(String(html`a${null}b${undefined}c${false}d${true}e`), "abcde");
});

test("conditional with ternary and &&", () => {
  const show = false, name = "Ann";
  assert.equal(String(html`x${show ? html`<b>${name}</b>` : ""}y`), "xy");
  assert.equal(String(html`x${show && html`<b>${name}</b>`}y`), "xy");
});

test("nested html composes without double-escaping", () => {
  const inner = html`<b>${"a<b"}</b>`;
  const out = String(html`<div>${inner}</div>`);
  assert.equal(out, "<div><b>a&lt;b</b></div>");
});

test("arrays are concatenated, each element escaped", () => {
  const items = ["a<", "b>"];
  assert.equal(String(html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`),
    "<ul><li>a&lt;</li><li>b&gt;</li></ul>");
});

test("numbers interpolate as their string form", () => {
  assert.equal(String(html`$${(12.5).toFixed(2)}`), "$12.50");
});

test("html() returns a Safe whose toString is the markup", () => {
  const r = html`<i>x</i>`;
  assert.ok(r instanceof Safe);
  assert.equal(`${r}`, "<i>x</i>");
});

test("raw(null) is empty, not the string 'null'", () => {
  assert.equal(String(html`${raw(null)}`), "");
});

test("hstr returns a plain string (for Tabulator formatters), still escaped", () => {
  const out = hstr`<x>${"a<b"}</x>`;
  assert.equal(typeof out, "string");           // NOT a Safe — formatters need a string
  assert.equal(out, "<x>a&lt;b</x>");
  assert.ok(!(out instanceof Safe));
});

console.log(`\n${passed} html-helper checks passed`);
