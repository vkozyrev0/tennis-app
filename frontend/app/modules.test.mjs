// Structural check of the frontend ESM graph (DOM-free).
// Run: node frontend/app/modules.test.mjs
//
// The SPA is ~60 hand-wired ES modules with no build step and no bundler, so a
// typo in an import specifier or a renamed export only shows up as a runtime
// SyntaxError in the browser. This walks every shipped module and asserts:
//   1. every relative import/export-from specifier resolves to a real file;
//   2. every named import is actually exported by the module it comes from;
//   3. every `create*` factory wired in app.js is handed the context keys it
//      destructures (an unpassed key is an undefined binding at runtime).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, "..");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "vendor" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Blank out comments only — string bodies must survive (module specifiers). */
function stripComments(src) {
  let out = "", i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Imports in this codebase start their own line, so anchoring on `^` keeps the
// scan out of strings and comments without needing a full parser. The clause is
// not allowed to contain `;` or `(` so a bare `import "./x.js"` or an
// `export const …` cannot swallow the next statement's `from "…"`.
function importStatements(src) {
  const out = [];
  const from = /^[ \t]*(?:import|export)\b([^;()]*?)\bfrom\s*(["'])([^"']+)\2/gm;
  let m;
  while ((m = from.exec(src))) {
    const named = m[1].match(/\{([\s\S]*?)\}/);
    const names = named
      ? named[1].split(",").map((s) => s.trim()).filter(Boolean)
          .map((s) => s.split(/\s+as\s+/)[0].trim())
      : [];
    out.push({ spec: m[3], names });
  }
  const bare = /^[ \t]*import\s*(["'])([^"']+)\1/gm;
  while ((m = bare.exec(src))) out.push({ spec: m[2], names: [] });
  return out;
}

/** Names a module makes importable: `export function f`, `export { a as b }`, … */
function exportedNames(src) {
  const names = new Set();
  const re = /export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) names.add(m[1]);
  const listRe = /export\s*\{([^}]*)\}/g;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(",")) {
      const bits = part.trim().split(/\s+as\s+/);
      const exported = (bits[1] || bits[0] || "").trim();
      if (exported) names.add(exported);
    }
  }
  return names;
}

const MODULES = walk(FRONTEND);
const sources = new Map(MODULES.map((p) => [p, stripComments(readFileSync(p, "utf8"))]));

test("the frontend module graph is discovered", () => {
  assert.ok(MODULES.length > 50, `expected the SPA's module set, found ${MODULES.length} files`);
  assert.ok(sources.has(join(FRONTEND, "app.js")), "frontend/app.js must be part of the graph");
  const imports = importStatements(sources.get(join(FRONTEND, "app.js")));
  assert.ok(imports.length > 30, `app.js should import its modules, found ${imports.length} imports`);
});

test("every relative import resolves to a file on disk", () => {
  const bad = [];
  for (const [file, src] of sources) {
    for (const { spec } of importStatements(src)) {
      if (!spec.startsWith(".")) continue;                 // bare specifier: node builtin
      if (!isFile(resolve(dirname(file), spec))) bad.push(`${relative(FRONTEND, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("every named import is exported by the module it comes from", () => {
  const bad = [];
  for (const [file, src] of sources) {
    for (const { spec, names } of importStatements(src)) {
      if (!spec.startsWith(".") || !names.length) continue;
      const target = resolve(dirname(file), spec);
      const targetSrc = sources.get(target) || "";
      const exports = exportedNames(targetSrc);
      const star = /export\s*\*/.test(targetSrc);
      for (const name of names) {
        if (star || exports.has(name)) continue;
        bad.push(`${relative(FRONTEND, file)} imports {${name}} from ${spec}, which does not export it`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

/** Body of the object literal starting at the first `{` at/after `from`. */
function objectLiteral(src, from) {
  const start = src.indexOf("{", from);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start + 1, i);
  }
  return null;
}

test("every create* factory wired in app.js gets the context keys it destructures", () => {
  const appSrc = sources.get(join(FRONTEND, "app.js"));
  const factories = new Map();   // factory export name -> module path
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/export\s+function\s+(create[A-Za-z0-9_$]*)\s*\(/g)) {
      factories.set(m[1], file);
    }
  }

  const bad = [];
  let checked = 0;
  for (const [factory, modulePath] of factories) {
    const call = new RegExp(`\\b${factory}\\s*\\(\\s*\\{`).exec(appSrc);
    if (!call) continue;                        // factory not wired by app.js
    checked++;
    const literal = objectLiteral(appSrc, call.index);
    assert.ok(literal !== null, `${factory}: could not read the call's context object`);

    const keys = new Set();
    for (const part of literal.split(",")) {
      const t = part.trim();
      if (!t) continue;
      const kv = /^([A-Za-z_$][\w$]*)\s*:/.exec(t);
      if (kv) { keys.add(kv[1]); continue; }
      if (/^[A-Za-z_$][\w$]*$/.test(t)) keys.add(t);      // shorthand property
    }

    const src = sources.get(modulePath);
    const ctx = /=\s*ctx\s*;/.exec(src);
    if (!ctx) continue;
    const destructured = src.slice(src.lastIndexOf("{", ctx.index) + 1, ctx.index)
      .split(",")
      .map((s) => s.trim().split(":")[0].trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));

    for (const name of destructured) {
      if (keys.has(name)) continue;
      if (new RegExp(`\\bvoid\\s+${name}\\s*;`).test(src)) continue;   // explicitly unused
      bad.push(`${factory} (${relative(FRONTEND, modulePath)}) reads ctx.${name}, not passed by app.js`);
    }
  }
  assert.ok(checked >= 10, `expected to check the wired factories, checked ${checked}`);
  assert.deepEqual(bad, []);
});

console.log(`\n${passed} module-graph checks passed`);
