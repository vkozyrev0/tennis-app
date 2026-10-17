// Deterministic check that CSV data cannot break out of the print window's
// <script> element. Run: node frontend/app/print.test.mjs
import assert from "node:assert/strict";
import { createPrintDoc } from "./print.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function capture(opts) {
  const written = [];
  const fakeWin = { document: { write: (html) => written.push(html), close() {} } };
  const orig = globalThis.window;
  globalThis.window = { open: () => fakeWin };
  try {
    createPrintDoc({ toast: () => {} })(opts);
  } finally {
    globalThis.window = orig;
  }
  return written.join("");
}

test("CSV text containing </script> stays inside the JS string", () => {
  const evil = "</script><script>alert(1)</script>";
  const html = capture({
    title: "rooming list",
    body: "<p>ok</p>",
    csv: { data: evil, filename: "x</script>.csv" },
  });
  assert.ok(!html.includes("</script><script>alert(1)"), "raw script breakout is present");
  assert.ok(html.includes("\\u003c/script"), "expected escaped < in the embedded literal");
});

test("ordinary CSV still downloads as the original text", () => {
  const html = capture({
    title: "schedule",
    body: "<p>ok</p>",
    csv: { data: "a,b\r\n1,2", filename: "schedule.csv" },
  });
  assert.ok(html.includes('"a,b\\r\\n1,2"'));
});

console.log(`\n${passed} print-window checks passed`);
