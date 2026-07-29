// Global keyboard shortcuts + Help open (D11 slice from app.js).
// `/` filter focus, `n` new record, `1`–`9` tab jump, `?` Help center.

import { showHelp, showShortcuts } from "./help.js";

export { showHelp, showShortcuts };

export function installShortcuts() {
  const btn = document.getElementById("shortcuts-btn");
  if (btn) {
    btn.addEventListener("click", () => showHelp());
    // Prefer "Help" wording; keep id for CSS/tests that target shortcuts-btn.
    if (!btn.dataset.helpWired) {
      btn.dataset.helpWired = "1";
      btn.title = "Help — app guide & keyboard shortcuts (press ?)";
      btn.setAttribute("aria-label", "Help");
    }
  }
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const a = document.activeElement;
    const inField = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "button";
    if (inField) return;

    const hm = document.getElementById("help-modal");
    if (hm && !hm.hidden) {
      if (e.key === "Escape") {
        hm.hidden = true;
        e.preventDefault();
        if (hm._invoker && typeof hm._invoker.focus === "function") hm._invoker.focus();
      }
      return;
    }
    // Legacy shortcuts-only modal (if any leftover)
    const sm = document.getElementById("shortcuts-modal");
    if (sm && !sm.hidden) {
      if (e.key === "Escape") { sm.hidden = true; e.preventDefault(); }
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "/") {
      const p = document.querySelector(".panel.active");
      const f = p && p.querySelector("input.filter, input[type=search]");
      if (f) { e.preventDefault(); f.focus(); f.select(); }
    } else if (e.key === "n" || e.key === "N") {
      const p = document.querySelector(".panel.active");
      const t = p && (p.querySelector(".new-btn:not(.add-trigger)") || p.querySelector(".add-trigger"));
      if (t) { e.preventDefault(); t.click(); }
    } else if (e.key === "?") {
      e.preventDefault();
      showHelp();
    } else if (/^[1-9]$/.test(e.key)) {
      // Audit P46: numeric keys jump to the Nth tab in the currently visible menu group.
      const tabs = [...document.querySelectorAll(".menu .tab")].filter((t) =>
        t.offsetParent !== null);
      const idx = Number(e.key) - 1;
      if (tabs[idx]) { e.preventDefault(); tabs[idx].click(); tabs[idx].focus(); }
    }
  });
}

installShortcuts();
