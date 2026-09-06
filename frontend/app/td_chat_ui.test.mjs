// Run: node frontend/app/td_chat_ui.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatProposedCalls, chatNeedsConfirm, applyTurnResult } from "./td_chat_ui.js";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../index.html"), "utf8");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok -", name); }

test("formatProposedCalls lists method and path", () => {
  const s = formatProposedCalls([
    { method: "GET", path: "/api/tournaments/3/dashboard", mutating: false },
    { method: "POST", path: "/api/tournaments/3/players", mutating: true },
  ]);
  assert.match(s, /GET \/api\/tournaments\/3\/dashboard/);
  assert.match(s, /POST \/api\/tournaments\/3\/players/);
  assert.match(s, /needs confirm/);
});

test("chatNeedsConfirm is true only when a mutating call is present", () => {
  assert.equal(chatNeedsConfirm([]), false);
  assert.equal(chatNeedsConfirm([{ mutating: false }]), false);
  assert.equal(chatNeedsConfirm([{ mutating: true }]), true);
});

test("applyTurnResult keeps Confirm visible after stripping mutating for execute", () => {
  const r = {
    needs_confirm: true,
    proposed: [{
      tool: "add_player", mutating: true, method: "POST",
      path: "/api/tournaments/3/players",
      args: { tournament_id: 3, usta_number: "123", first_name: "Jane", last_name: "Roe", gender: "female" },
    }],
  };
  const applied = applyTurnResult(r);
  assert.equal(applied.showConfirm, true);
  assert.equal(chatNeedsConfirm(applied.executePayload), false);
  assert.deepEqual(applied.executePayload, [{
    tool: "add_player",
    args: { tournament_id: 3, usta_number: "123", first_name: "Jane", last_name: "Roe", gender: "female" },
  }]);
  assert.equal(applyTurnResult({ proposed: [], needs_confirm: false }).showConfirm, false);
});

test("chat panel is its own section, not tpanel nested in home", () => {
  const chat = html.match(/<section[^>]*id="panel-td-chat"[^>]*>/);
  assert.ok(chat, "missing panel-td-chat");
  assert.doesNotMatch(chat[0], /\btpanel\b/);
  const homeEnd = html.indexOf('id="panel-td-chat"');
  const homeStart = html.indexOf('id="panel-home"');
  const homeClose = html.indexOf("</section>", homeStart);
  assert.ok(homeClose > 0 && homeClose < homeEnd, "chat must be after home section closes");
});

console.log(`\n${passed} td_chat_ui checks passed`);
