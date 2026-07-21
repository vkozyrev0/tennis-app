// Prerequisite callout when a workspace panel depends on an empty Setup catalog.

/**
 * @param {{ activateGroup: (key: string) => void }} ctx
 * @returns {(panelId: string, show: boolean, msg: string, setupTabId: string) => void}
 */
export function createPrereqCallout(ctx) {
  const { activateGroup } = ctx;

  return function prereqCallout(panelId, show, msg, setupTabId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    let note = panel.querySelector(":scope > .prereq-note");
    if (!show) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement("div");
      note.className = "prereq-note";
      note.setAttribute("role", "note");
      panel.prepend(note);
    }
    note.innerHTML = "";
    const span = document.createElement("span"); span.textContent = msg + " ";
    const a = document.createElement("a"); a.href = "#"; a.className = "btn-link";
    a.textContent = "Open Setup →";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      activateGroup("setup");
      const t = document.getElementById(setupTabId); if (t) t.click();
    });
    note.append(span, a);
  };
}
