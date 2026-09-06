/** TD chat panel helpers. */

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

/** Client abort for /td-chat/turn — longer than backend EMAIL_LLM_CHAT_TIMEOUT (180s). */
export const CHAT_CLIENT_TIMEOUT_MS = 200000;
export const CHAT_PENDING_LABEL = "Waiting on Intelligence…";

export function setChatPending(on) {
  const el = document.getElementById("td-chat-pending");
  const sendBtn = document.getElementById("td-chat-send");
  const input = document.getElementById("td-chat-input");
  const log = document.getElementById("td-chat-log");
  if (el) {
    el.hidden = !on;
    if (on && log) log.appendChild(el);
  }
  if (sendBtn) sendBtn.disabled = !!on;
  if (input) input.disabled = !!on;
  if (log) {
    log.setAttribute("aria-busy", on ? "true" : "false");
    if (on) log.scrollTop = log.scrollHeight;
  }
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
      el.textContent = `Intelligence: ${v.verdict} — ${v.detail}`;
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
    setChatPending(true);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CHAT_CLIENT_TIMEOUT_MS);
    try {
      const r = await api("/td-chat/turn", {
        method: "POST",
        body: JSON.stringify({ message: msg, tournament_id: tid || null }),
        signal: ac.signal,
      });
      const lines = [];
      if (r.reply) lines.push(r.reply);
      const spec = formatProposedCalls(r.proposed);
      if (spec) lines.push("Proposed writes:\n" + spec);
      if (!lines.length) {
        const intel = r.llm === "ok" ? "is on" : (r.llm === "down" ? "is unreachable" : "is off");
        lines.push("I could not answer that — Intelligence " + intel + ".");
      }
      _log("assistant", lines.join("\n"));
      const applied = applyTurnResult(r);
      _lastProposed = applied.executePayload;
      const bar = document.getElementById("td-chat-confirm-bar");
      if (bar) bar.hidden = !applied.showConfirm;
    } catch (e) {
      const aborted = e && (e.name === "AbortError" || /aborted|timed out/i.test(String(e.message || "")));
      const err = aborted ? "Intelligence timed out. Try again." : (e && e.message) || String(e);
      toast(err, false);
      _log("assistant", "Error: " + err);
    } finally {
      clearTimeout(timer);
      setChatPending(false);
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
