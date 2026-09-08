// Node tests for form Autofill identity + autocomplete tokens.
// Run: node frontend/app/form_a11y.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { suggestedAutocomplete, ensureFieldIdentity } from "./form_a11y.js";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function fake(attrs) {
  const el = {
    nodeType: 1,
    tagName: (attrs.tag || "INPUT").toUpperCase(),
    type: attrs.type || "text",
    name: attrs.name || "",
    id: attrs.id || "",
    className: attrs.className || "",
    classList: {
      contains: (c) => (attrs.className || "").split(/\s+/).includes(c),
    },
    closest: (sel) => (attrs.form && sel.split(/,\s*/).some((s) => s.replace(/^#/, "") === attrs.form) ? { id: attrs.form } : null),
    getAttribute: (k) => {
      if (k === "autocomplete") return attrs.autocomplete || null;
      if (k === "name") return attrs.name || "";
      return null;
    },
    hasAttribute: (k) => k === "autocomplete" ? !!attrs.autocomplete : false,
    setAttribute() {},
  };
  return el;
}

test("catalog identity fields opt out of Autofill", () => {
  assert.equal(suggestedAutocomplete(fake({ name: "first_name" })), "off");
  assert.equal(suggestedAutocomplete(fake({ name: "email", type: "email" })), "off");
  assert.equal(suggestedAutocomplete(fake({ name: "name" })), "off");
  assert.equal(suggestedAutocomplete(fake({ name: "city" })), "off");
});

test("login and own-profile fields use Autofill tokens", () => {
  assert.equal(suggestedAutocomplete(fake({ name: "first_name", form: "me-form" })), "given-name");
  assert.equal(suggestedAutocomplete(fake({ name: "last_name", form: "me-form" })), "family-name");
  assert.equal(suggestedAutocomplete(fake({ name: "email", type: "email", form: "me-form" })), "email");
  assert.equal(suggestedAutocomplete(fake({ name: "street", form: "me-form" })), "address-line1");
  assert.equal(suggestedAutocomplete(fake({ name: "username", form: "login-form" })), "username");
  assert.equal(suggestedAutocomplete(fake({ name: "password", type: "password", form: "login-form" })), "current-password");
});

test("search, combo, and grid filters are autocomplete=off", () => {
  assert.equal(suggestedAutocomplete(fake({ type: "search" })), "off");
  assert.equal(suggestedAutocomplete(fake({ className: "combo-input" })), "off");
  assert.equal(suggestedAutocomplete(fake({ className: "ag-input-field-input" })), "off");
  assert.equal(suggestedAutocomplete(fake({ type: "checkbox" })), "off");
});

test("ensureFieldIdentity assigns an id when both id and name are empty", () => {
  const el = { nodeType: 1, id: "", getAttribute: () => "", setAttribute() {} };
  ensureFieldIdentity(el);
  assert.match(el.id, /^fc-/);
  const named = { nodeType: 1, id: "", getAttribute: (k) => (k === "name" ? "email" : ""), setAttribute() {} };
  ensureFieldIdentity(named);
  assert.equal(named.id, "");
});

test("index.html Autofill tokens: catalog off, own-profile on", () => {
  const html = readFileSync(join(here, "../index.html"), "utf8");
  assert.match(html, /id="me-form"[\s\S]*name="first_name" autocomplete="given-name"/);
  assert.match(html, /id="me-form"[\s\S]*name="email" type="email" autocomplete="email"/);
  assert.match(html, /name="username" autocomplete="username"/);
  assert.match(html, /name="first_name" autocomplete="off"/);
  assert.match(html, /name="email" type="email" autocomplete="off"/);
  assert.match(html, /class="filter" type="search" name="list-filter" autocomplete="off"/);
  assert.match(html, /id="inbox-search"[\s\S]*autocomplete="off"/);
});

test("inbox row checkboxes carry a name so Chrome Autofill is satisfied", () => {
  const inbox = readFileSync(join(here, "inbox.js"), "utf8");
  assert.match(inbox, /cb\.name = "inbox-select-all"/);
  assert.match(inbox, /cb\.name = "inbox-row"/);
  const app = readFileSync(join(here, "../app.js"), "utf8");
  assert.match(app, /stampFormControls\(\)/);
  assert.match(app, /watchFormControls\(\)/);
});

console.log(`\n${passed} form-a11y checks passed`);
