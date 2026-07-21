// Theme (light/dark) + static a11y bootstrapping (D11 slice from app.js).
// Runs at import so the theme applies before first paint when possible.

export function applyTheme(t) {
  const dark = t === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) { /* ignore */ }
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = dark ? "☀ Light" : "🌙 Dark";
}

export function installTheme() {
  applyTheme((() => {
    try { return localStorage.getItem("theme"); } catch (e) { return null; }
  })() || "light");

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      applyTheme(document.documentElement.getAttribute("data-theme"));  // sync label
      btn.addEventListener("click", () =>
        applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));
    }
    // a11y re-review #1: every static <th> in a list-table gets scope="col" so
    // SR users get explicit header→cell mapping. JS-built grids set scope themselves.
    document.querySelectorAll(".list-table thead th").forEach((th) => {
      if (!th.hasAttribute("scope")) th.setAttribute("scope", "col");
    });
    // a11y re-review #5: register every inline form-status span as a polite
    // live region at page load so screen readers pre-track them.
    document.querySelectorAll("span.msg").forEach((el) => {
      if (!el.hasAttribute("role")) el.setAttribute("role", "status");
      if (!el.hasAttribute("aria-live")) el.setAttribute("aria-live", "polite");
    });
    // a11y re-review #7: main panel-switching tabs get role="tab" semantics.
    document.querySelectorAll(".menu-group").forEach((g) => g.setAttribute("role", "tablist"));
    document.querySelectorAll(".menu .tab").forEach((b) => {
      b.setAttribute("role", "tab");
      const target = b.dataset.target;
      if (target) b.setAttribute("aria-controls", target);
      b.setAttribute("aria-selected", b.classList.contains("active") ? "true" : "false");
    });
    const tabObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName === "class" && m.target.classList.contains("tab")) {
          m.target.setAttribute("aria-selected", m.target.classList.contains("active") ? "true" : "false");
        }
      }
    });
    document.querySelectorAll(".menu .tab").forEach((b) =>
      tabObserver.observe(b, { attributes: true, attributeFilter: ["class"] }));
    // a11y re-review #2: blank detail-title <h3>s are noisy for SR linear reads.
    document.querySelectorAll("h3.detail-title").forEach((h) => {
      if (!h.textContent.trim()) h.hidden = true;
    });
    const titleObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        const h = m.target;
        h.hidden = !h.textContent.trim();
      }
    });
    document.querySelectorAll("h3.detail-title").forEach((h) =>
      titleObserver.observe(h, { childList: true, characterData: true, subtree: true }));
    // a11y 5th-pass #3: label the per-panel "×" close buttons.
    document.querySelectorAll("button.detail-close").forEach((b) => {
      if (!b.hasAttribute("aria-label")) b.setAttribute("aria-label", "Close details");
    });
    // a11y 5th-pass #1: sr-only <caption> per static table.
    document.querySelectorAll("table.list-table").forEach((t) => {
      if (t.querySelector("caption")) return;
      const panel = t.closest(".panel, section, .card");
      const h = panel?.querySelector("h3, h2, h4");
      const label = h?.textContent.trim().replace(/\s+/g, " ") || "Data table";
      const cap = document.createElement("caption");
      cap.className = "sr-only";
      cap.textContent = label;
      t.insertBefore(cap, t.firstChild);
    });
    // a11y 5th-pass #2: WAI-ARIA roving tabindex on main panel tabs.
    document.querySelectorAll(".menu-group").forEach((group) => {
      const tabs = [...group.querySelectorAll(".tab")];
      const sync = () => {
        tabs.forEach((t) => { t.tabIndex = t.classList.contains("active") ? 0 : -1; });
      };
      sync();
      new MutationObserver(sync).observe(group, {
        attributes: true, attributeFilter: ["class"], subtree: true,
      });
      group.addEventListener("keydown", (e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        const cur = tabs.indexOf(document.activeElement);
        if (cur < 0) return;
        e.preventDefault();
        let next;
        if (e.key === "Home") next = 0;
        else if (e.key === "End") next = tabs.length - 1;
        else if (e.key === "ArrowLeft") next = (cur - 1 + tabs.length) % tabs.length;
        else next = (cur + 1) % tabs.length;
        tabs[next].focus();
        tabs[next].click();
      });
    });
  });
}

// Install on load (app.js is type=module; DOM may already be ready).
installTheme();
