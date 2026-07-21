// Global keyboard shortcuts help + handlers (D11 slice from app.js).
// `/` filter focus, `n` new record, `1`–`9` tab jump, `?` help.

export function showShortcuts() {
  let m = document.getElementById("shortcuts-modal");
  if (!m) {
    m = document.createElement("div"); m.id = "shortcuts-modal"; m.className = "modal";
    m.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <h3 id="shortcuts-title" style="margin-top:0">Keyboard shortcuts</h3>
        <table class="shortcuts"><tbody>
          <tr><th><kbd>/</kbd></th><td>Focus the page filter</td></tr>
          <tr><th><kbd>n</kbd></th><td>Add a new record on the active panel</td></tr>
          <tr><th><kbd>1</kbd>-<kbd>9</kbd></th><td>Jump to the Nth tab in the current menu</td></tr>
          <tr><th><kbd>Esc</kbd></th><td>Close the open dialog</td></tr>
          <tr><th><kbd>?</kbd></th><td>Show this help</td></tr>
        </tbody></table>
        <div class="actions-row" style="margin-top:0.75rem"><button type="button" id="shortcuts-close">Close</button></div>
      </div>`;
    document.body.appendChild(m);
    const close = () => {
      m.hidden = true;
      if (m._invoker && typeof m._invoker.focus === "function") m._invoker.focus();
    };
    m.querySelector("#shortcuts-close").addEventListener("click", close);
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    m.addEventListener("keydown", (e) => {
      if (m.hidden) return;
      if (e.key === "Tab") {
        e.preventDefault();
        m.querySelector("#shortcuts-close").focus();
      }
    });
  }
  m._invoker = document.activeElement;
  m.hidden = false;
  requestAnimationFrame(() => m.querySelector("#shortcuts-close").focus());
}

export function installShortcuts() {
  const btn = document.getElementById("shortcuts-btn");
  if (btn) btn.addEventListener("click", showShortcuts);
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const a = document.activeElement;
    const inField = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "button";
    if (inField) return;
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
      e.preventDefault(); showShortcuts();
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
