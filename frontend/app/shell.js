// Core SPA shell: fetch wrapper, toasts, form messages, confirm dialog (D11).
// Dependency-free except humanizeDetail for FastAPI error bodies.
import { humanizeDetail } from "./util.js";
import { toastLifetime } from "./td_helpers.js";
import { createNoticeLog } from "./notices.js";

/**
 * @returns {{
 *   api: (path: string, options?: RequestInit) => Promise<any>,
 *   toast: (text: string, ok?: boolean, action?: { label: string, onClick: () => void } | null) => void,
 *   setMsg: (id: string, text: string, ok: boolean) => void,
 *   markInvalid: (form: HTMLFormElement, errorText: string) => void,
 *   confirmDialog: (message: string, okLabel?: string, okKind?: string) => Promise<boolean>,
 * }}
 */
/** True only when /api/auth/me is 401. A stray 401 must not log the TD out. */
export async function sessionIsGone(fetcher = fetch) {
  try {
    const r = await fetcher("/api/auth/me", { credentials: "same-origin" });
    return r.status === 401;
  } catch (_) {
    return false;
  }
}

export function createShell() {
  const notices = createNoticeLog();
  let _inflight = 0;
  function _progress(delta) {
    _inflight = Math.max(0, _inflight + delta);
    const p = document.getElementById("progress");
    if (p) {
      const busy = _inflight > 0;
      p.classList.toggle("active", busy);
      p.setAttribute("aria-hidden", busy ? "false" : "true");
    }
  }

  async function api(path, options) {
    _progress(1);
    try {
      const hasBody = options && options.body;
      const headers = hasBody && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" } : {};
      const res = await fetch("/api" + path, {
        credentials: "same-origin",
        ...options,
        headers: { ...headers, ...(options && options.headers) },
      });
      let body = null;
      if (res.status !== 204) {
        try { body = await res.json(); }
        catch (_) { /* non-JSON error page */ }
      }
      if (!res.ok) {
        const detail = body && body.detail !== undefined ? body.detail : res.statusText;
        if (res.status === 401 && !path.startsWith("/auth/")
            && !document.body.classList.contains("is-signed-out")) {
          if (await sessionIsGone()) {
            document.dispatchEvent(new CustomEvent("auth-expired"));
          }
        }
        throw new Error(humanizeDetail(detail, `${res.status} ${res.statusText}`.trim()));
      }
      return body;
    } finally {
      _progress(-1);
    }
  }

  function toast(text, ok = true, extra = null) {
    const box = document.getElementById("toasts");
    if (!text) return;
    const action = extra && extra.label && typeof extra.onClick === "function" ? extra : null;
    const sticky = !!(extra && extra.sticky);
    notices.record({ text, ok, sticky: sticky || !!action });
    if (!box) return;
    const t = document.createElement("div");
    t.className = "toast " + (ok ? "ok" : "bad");
    t.setAttribute("role", ok ? "status" : "alert");
    const span = document.createElement("span"); span.textContent = text; t.appendChild(span);
    if (action) {
      const a = document.createElement("button");
      a.type = "button"; a.className = "toast-action"; a.textContent = action.label;
      a.addEventListener("click", () => { t.remove(); action.onClick(); });
      t.appendChild(a);
    }
    const ttl = typeof extra?.timeout === "number"
      ? extra.timeout
      : toastLifetime({ ok, sticky, hasAction: !!action });
    const persist = ttl == null;
    if (!ok || persist) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "toast-close"; x.textContent = "×";
      x.setAttribute("aria-label", "Dismiss notification");
      x.addEventListener("click", () => t.remove());
      t.appendChild(x);
    }
    box.appendChild(t);
    if (!persist) {
      setTimeout(() => {
        if (!t.isConnected) return;
        t.style.transition = "opacity .3s"; t.style.opacity = "0";
        setTimeout(() => t.remove(), 300);
      }, ttl);
    }
  }

  function setMsg(id, text, ok) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = text;
      el.className = "msg " + (ok ? "ok" : "bad");
      el.setAttribute("role", ok ? "status" : "alert");
      if (text && ok !== false) {
        setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
      }
    }
    toast(text, ok);
  }

  function markInvalid(form, errorText) {
    if (!form || !errorText) return;
    for (const el of form.querySelectorAll("[aria-invalid='true']")) {
      el.removeAttribute("aria-invalid"); el.classList.remove("field-error");
    }
    const t = String(errorText).toLowerCase();
    const fields = [...form.elements].filter((e) => e.name);
    let hit = null, hitPos = Infinity;
    for (const e of fields) {
      const n = e.name.toLowerCase();
      for (const w of [n, n.replace(/_/g, " "), n.replace(/_/g, "-")]) {
        const m = new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").exec(t);
        if (m && m.index < hitPos) { hit = e; hitPos = m.index; }
      }
    }
    if (hit) {
      hit.setAttribute("aria-invalid", "true"); hit.classList.add("field-error");
      try { hit.focus(); } catch (_) {}
    }
  }

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t && t.getAttribute && t.getAttribute("aria-invalid") === "true") {
      t.removeAttribute("aria-invalid"); t.classList.remove("field-error");
    }
  }, true);

  function confirmDialog(message, okLabel = "Delete", okKind = "danger") {
    return new Promise((resolve) => {
      const m = document.getElementById("confirm-modal");
      const ok = document.getElementById("confirm-ok");
      const cancel = document.getElementById("confirm-cancel");
      document.getElementById("confirm-text").textContent = message;
      ok.textContent = okLabel;
      ok.className = "confirm-ok " + (okKind === "danger" ? "danger" : "primary");
      const invoker = document.activeElement;
      const inertTargets = ["header", "nav.menu-l1", "nav.menu", "main#main-app", "main#official-app"]
        .map((sel) => document.querySelector(sel)).filter(Boolean);
      inertTargets.forEach((el) => el.setAttribute("inert", ""));
      m.hidden = false;
      cancel.focus();
      const done = (v) => {
        m.hidden = true;
        inertTargets.forEach((el) => el.removeAttribute("inert"));
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
        if (invoker && typeof invoker.focus === "function") invoker.focus();
        resolve(v);
      };
      const onOk = () => done(true);
      const onCancel = () => done(false);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(false); return; }
        if (e.key === "Enter" && document.activeElement !== cancel) {
          e.preventDefault(); done(true); return;
        }
        if (e.key === "Tab") {
          const focusables = [cancel, ok];
          const idx = focusables.indexOf(document.activeElement);
          e.preventDefault();
          const next = e.shiftKey
            ? focusables[(idx <= 0 ? focusables.length - 1 : idx - 1)]
            : focusables[(idx + 1) % focusables.length];
          next.focus();
        }
      };
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
    });
  }

  function controlDirty(el) {
    if (!el || el.disabled || !el.name) return false;
    if (el.tagName === "BUTTON" || el.type === "submit" || el.type === "button" || el.type === "hidden") return false;
    if (el.type === "checkbox" || el.type === "radio") return el.checked !== el.defaultChecked;
    if (el.tagName === "SELECT") return [...el.options].some((o) => o.selected !== o.defaultSelected);
    return (el.value || "") !== (el.defaultValue || "");
  }

  function pageHasUnsavedEdits() {
    for (const form of document.querySelectorAll("form")) {
      if (form.closest("[hidden]") || form.id === "login-form") continue;
      if ([...form.elements].some(controlDirty)) return true;
    }
    return false;
  }

  window.addEventListener("beforeunload", (e) => {
    if (!pageHasUnsavedEdits()) return;
    e.preventDefault();
    e.returnValue = "";
  });

  return { api, toast, setMsg, markInvalid, confirmDialog, progress: _progress, notices };
}
