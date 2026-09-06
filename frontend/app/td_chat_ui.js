/** Pure helpers for the TD chat panel (no DOM). */

export function formatProposedCalls(proposed) {
  return (proposed || []).map((c) => {
    const m = String(c.method || "").toUpperCase();
    const p = c.path || "";
    const flag = c.mutating ? " (needs confirm)" : "";
    return `${m} ${p}${flag}`;
  }).join("\n");
}

export function chatNeedsConfirm(proposed) {
  return (proposed || []).some((c) => !!c.mutating);
}

/** Split a /td-chat/turn body: confirm bar uses mutating/needs_confirm; execute payload is tool+args only. */
export function applyTurnResult(r) {
  const proposed = (r && r.proposed) || [];
  const showConfirm = !!(r && r.needs_confirm) || chatNeedsConfirm(proposed);
  const executePayload = proposed.map((c) => ({
    tool: c.tool, args: c.args || {},
  })).filter((c) => c.tool);
  return { executePayload, showConfirm };
}

/**
 * @param {{ api: Function, getActive: Function, toast: Function, html: Function, hstr: Function }} ctx
 */
export function createTdChatPanel(ctx) {
  const { api, getActive, toast, html } = ctx;
  void html;

  function _log(role, text) {
    const box = document.getElementById("td-chat-log");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "td-chat-msg td-chat-msg--" + role;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }

  async function loadVerdict() {
    const el = document.getElementById("td-chat-verdict");
    if (!el) return;
    try {
      const v = await api("/td-chat/verdict");
      el.hidden = false;
      el.textContent = `1.5B sidecar: ${v.verdict} — ${v.detail}`;
      el.className = "td-chat-verdict " + (v.verdict === "sufficient" ? "ok" : "muted");
    } catch (_) {
      el.hidden = true;
    }
  }

  let _lastProposed = [];

  async function send() {
    const input = document.getElementById("td-chat-input");
    const msg = (input && input.value || "").trim();
    if (!msg) return;
    const tid = getActive() && getActive().id;
    _log("user", msg);
    if (input) input.value = "";
    const sendBtn = document.getElementById("td-chat-send");
    if (sendBtn) sendBtn.disabled = true;
    try {
      const r = await api("/td-chat/turn", {
        method: "POST",
        body: JSON.stringify({ message: msg, tournament_id: tid || null }),
      });
      const lines = [];
      if (r.reply) lines.push(r.reply);
      if (r.unknown_tools && r.unknown_tools.length) {
        lines.push("Rejected unknown tools: " + r.unknown_tools.join(", "));
      }
      const spec = formatProposedCalls(r.proposed);
      if (spec) lines.push("Proposed writes:\n" + spec);
      if ((r.executed || []).length) {
        lines.push("Ran " + r.executed.length + " read(s).");
      }
      if (!lines.length) lines.push("(no plan — sidecar " + (r.llm || "?") + ")");
      _log("assistant", lines.join("\n"));
      const applied = applyTurnResult(r);
      _lastProposed = applied.executePayload;
      const bar = document.getElementById("td-chat-confirm-bar");
      if (bar) bar.hidden = !applied.showConfirm;
    } catch (e) {
      toast(e.message, false);
      _log("assistant", "Error: " + e.message);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  async function confirmWrites() {
    if (!_lastProposed.length) return;
    const tid = getActive() && getActive().id;
    try {
      const r = await api("/td-chat/execute", {
        method: "POST",
        body: JSON.stringify({ calls: _lastProposed, confirm: true, tournament_id: tid || null }),
      });
      _log("assistant", r.applied ? "Applied." : "Not applied.");
      const bar = document.getElementById("td-chat-confirm-bar");
      if (bar) bar.hidden = true;
      _lastProposed = [];
      toast("Chat actions applied", true);
    } catch (e) {
      toast(e.message, false);
    }
  }

  function bind() {
    document.getElementById("td-chat-send")?.addEventListener("click", send);
    document.getElementById("td-chat-confirm")?.addEventListener("click", confirmWrites);
    document.getElementById("td-chat-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    loadVerdict();
  }

  return { bind, loadVerdict, send, confirmWrites };
}
