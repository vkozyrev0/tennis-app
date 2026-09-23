// Guard for the CI lint gate (static; no network, no browser).
//
//   node scripts/ci_gate.test.mjs
//
// The gate lives in .github/workflows/docker.yml. If someone deletes the lint
// job, drops the build's dependency on it, marks a step `continue-on-error`, or
// changes a command so it no longer matches what the docs tell contributors to
// run, nothing in the repo notices until a lint-dirty change lands on main.
// This reads the workflow and asserts that wiring, then re-runs the same checks
// against deliberately broken copies of the file so the assertions are proven
// to bite rather than merely to pass.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = resolve(ROOT, ".github/workflows/docker.yml");

// The commands the docs give contributors; the gate must run exactly these.
const PYTHON_CMD = "python -m ruff check .";
const JS_CMD = "npx eslint .";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

/** Drop whole-line and trailing YAML comments (a `#` inside this file's values
 *  never occurs; the workflow's own prose does mention `continue-on-error`). */
function stripComments(text) {
  return text.split("\n").map((line) => {
    const i = line.indexOf("#");
    return i === -1 ? line : line.slice(0, i);
  }).join("\n");
}

/** Indentation of a line, or -1 for blank/comment-only lines. */
function indentOf(line) {
  if (!line.trim()) return -1;
  return line.length - line.trimStart().length;
}

/** Body of a block whose key line is `keyLine`, up to the next line at or
 *  below that indentation. */
function block(lines, keyIndex) {
  const base = indentOf(lines[keyIndex]);
  const out = [];
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const ind = indentOf(lines[i]);
    if (ind !== -1 && ind <= base) break;
    out.push(lines[i]);
  }
  return out;
}

/** All `run:` command strings in a block, in order. */
function runCommands(lines) {
  return lines
    .map((l) => /^\s*run:\s*(.+?)\s*$/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].replace(/^["']|["']$/g, ""));
}

/** Job name -> its body lines, for every 2-space-indented key under `jobs:`. */
function jobs(lines) {
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.notEqual(start, -1, "workflow has no jobs: block");
  const out = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) out.set(m[1], block(lines, i));
    else if (indentOf(lines[i]) === 0) break;      // left the jobs: block
  }
  return out;
}

/** Every problem the gate's wiring has, as human-readable strings. */
function gateProblems(text) {
  const problems = [];
  const lines = stripComments(text).split("\n");

  // --- triggers: the gate must run on the pull-request and push paths ---
  const onIndex = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIndex === -1) problems.push("workflow has no on: block");
  else {
    const onBody = block(lines, onIndex).map((l) => l.trim());
    if (!onBody.some((l) => /^push:\s*$/.test(l))) problems.push("on: block does not include push");
    if (!onBody.some((l) => /^pull_request:\s*$/.test(l))) problems.push("on: block does not include pull_request");
  }

  // --- no step or job may be allowed to fail quietly ---
  const coe = lines
    .map((l, i) => (/^\s*continue-on-error:\s*(.+)$/.exec(l) ? `${i + 1}: ${l.trim()}` : null))
    .filter(Boolean);
  if (coe.length) problems.push(`continue-on-error present: ${coe.join(", ")}`);

  const byName = jobs(lines);

  // --- the lint job exists and runs exactly the documented commands ---
  const lint = byName.get("lint");
  if (!lint) problems.push("no lint job");
  else {
    const cmds = runCommands(lint);
    if (!cmds.includes(PYTHON_CMD)) problems.push(`lint job does not run '${PYTHON_CMD}'`);
    if (!cmds.includes(JS_CMD)) problems.push(`lint job does not run '${JS_CMD}'`);
    if (/^\s*if:/m.test(lint.join("\n"))) problems.push("lint job is conditional (has an if:)");
    if (!/^\s*-\s*name:\s*Checkout/m.test(lint.join("\n"))) problems.push("lint job does not check out the repo");
  }

  // --- the image build must depend on it ---
  const build = byName.get("build");
  if (!build) problems.push("no build job");
  else {
    const needsLine = build.find((l) => /^\s*needs:/.test(l));
    if (!needsLine) problems.push("build job has no needs:");
    else {
      const needs = needsLine.replace(/^\s*needs:\s*/, "").replace(/[[\]]/g, "").split(",").map((s) => s.trim());
      if (!needs.includes("lint")) problems.push(`build job needs [${needs.join(", ")}] but not lint`);
    }
  }

  return problems;
}

/** The two documented commands must be the ones the docs hand contributors. */
function docProblems(readme) {
  const problems = [];
  for (const cmd of [PYTHON_CMD, JS_CMD]) {
    if (!readme.includes(cmd)) problems.push(`README.md does not document '${cmd}'`);
  }
  return problems;
}

// A Windows checkout can hand these files back with CRLF; normalize so the
// line-oriented parsing below is not tripped by a trailing \r.
const workflowText = readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n");
const readmeText = readFileSync(resolve(ROOT, "README.md"), "utf8").replace(/\r\n/g, "\n");

test("the committed workflow wires the lint gate", () => {
  assert.deepEqual(gateProblems(workflowText), []);
});

test("the gate and the documented commands agree", () => {
  assert.deepEqual(docProblems(readmeText), []);
});

// The checks above are only worth having if they fail when the wiring is
// removed, so run them against broken copies of the real file.
function withoutJob(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.notEqual(start, -1, `fixture: no ${name} job to remove`);
  let end = start + 1;
  while (end < lines.length && (indentOf(lines[end]) === -1 || indentOf(lines[end]) > 2)) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

test("the checks reject a deleted lint job", () => {
  assert.notDeepEqual(gateProblems(withoutJob(workflowText, "lint")), []);
});

test("the checks reject a build that no longer depends on lint", () => {
  const broken = workflowText.replace("needs: [lint, test]", "needs: test");
  assert.notEqual(broken, workflowText, "fixture: no needs: [lint, test] to rewrite");
  assert.notDeepEqual(gateProblems(broken), []);
});

test("the checks reject a continue-on-error step", () => {
  const broken = workflowText.replace(
    `        run: ${JS_CMD}`,
    `        continue-on-error: true\n        run: ${JS_CMD}`,
  );
  assert.notEqual(broken, workflowText, "fixture: no eslint step to soften");
  assert.notDeepEqual(gateProblems(broken), []);
});

test("the checks reject a changed lint command", () => {
  const broken = workflowText.replace(`run: ${JS_CMD}`, "run: npx eslint frontend");
  assert.notEqual(broken, workflowText, "fixture: no eslint command to change");
  assert.notDeepEqual(gateProblems(broken), []);
});

test("the checks reject a workflow that no longer runs on pull requests", () => {
  const broken = workflowText.replace("  pull_request:\n", "");
  assert.notEqual(broken, workflowText, "fixture: no pull_request trigger to drop");
  assert.notDeepEqual(gateProblems(broken), []);
});

test("the checks reject a lint job gated behind an if:", () => {
  const broken = workflowText.replace("  lint:\n", "  lint:\n    if: false\n");
  assert.notEqual(broken, workflowText, "fixture: no lint job to gate");
  assert.notDeepEqual(gateProblems(broken), []);
});

console.log(`\n${passed} CI-gate checks passed`);
