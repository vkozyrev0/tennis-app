// Deterministic unit test for CSV serialization (DOM-free).
// Run: node frontend/app/util.test.mjs
import assert from "node:assert/strict";
import { csvText } from "./util.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("quotes commas and embedded quotes", () => {
  assert.equal(csvText([["a,b", 'say "hi"']]), '"a,b","say ""hi"""');
});

test("neutralizes a leading spreadsheet formula character", () => {
  assert.equal(
    csvText([["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\tx", "\rx", "safe"]]),
    `"'=1+1","'+SUM(A1)","'-2+3","'@cmd","'\tx","'\rx","safe"`,
  );
  // A plain negative number stays numeric for the spreadsheet.
  assert.equal(csvText([["-2"]]), '"-2"');
});

test("null and undefined render as empty cells", () => {
  assert.equal(csvText([[null, undefined, 0]]), '"","","0"');
});

console.log(`\n${passed} csv checks passed`);
