// Run: node frontend/app/session_expired.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionIsGone } from "./shell.js";

const here = dirname(fileURLToPath(import.meta.url));
const shell = readFileSync(join(here, "shell.js"), "utf8");
const inbox = readFileSync(join(here, "inbox.js"), "utf8");

assert.match(shell, /sessionIsGone/);
assert.match(shell, /\/api\/auth\/me/);
assert.match(shell, /if \(await sessionIsGone\(\)\)/);
assert.match(inbox, /sessionIsGone/);

assert.equal(await sessionIsGone(async () => ({ status: 200 })), false);
assert.equal(await sessionIsGone(async () => ({ status: 401 })), true);
assert.equal(await sessionIsGone(async () => { throw new Error("offline"); }), false);

console.log("session-expired confirm-before-logout checks passed");
