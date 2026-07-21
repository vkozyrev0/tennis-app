// List / grid height + viewport-resize redraw (D11 slice from app.js).
// Pins active-panel grids so their bottom stays at the viewport edge — the
// page itself does not grow a vertical scrollbar for Setup master-detail lists.

/**
 * @param {{ redrawPanelGrids: (panelId: string) => void }} ctx
 * @returns {{ sizeLists: () => void }}
 */
export function createLayout(ctx) {
  const { redrawPanelGrids } = ctx;

  // Gap between grid bottom and viewport bottom (matches visual breathing room).
  const BOTTOM_PAD = 16;
  const MIN_H = 140;

  /**
   * Bound every scrollable list/grid in the active panel to the space left
   * below it so it never runs past the bottom of the window, whatever the
   * toolbar / breadcrumb / nav height happens to be.
   */
  function sizeLists() {
    const panel = document.querySelector(".panel.active");
    if (!panel) return;

    // CSS var for any remaining .list-scroll (legacy tables / unmigrated panels).
    const ls = panel.querySelector(".list-scroll");
    if (ls) {
      const top = ls.getBoundingClientRect().top;
      const max = Math.max(MIN_H, Math.floor(window.innerHeight - top - BOTTOM_PAD));
      document.documentElement.style.setProperty("--list-max", max + "px");
      ls.style.maxHeight = max + "px";
    } else {
      // Fallback var used by CSS before first measure of a list-scroll panel.
      document.documentElement.style.setProperty(
        "--list-max",
        Math.max(MIN_H, window.innerHeight - 200) + "px",
      );
    }

    // AG Grid mounts (Setup wireEntity + workspace makeListGrid/makeReadGrid).
    // Compact summary mounts keep their own fixed heights.
    panel.querySelectorAll(".grid-mount:not(.grid-mount--compact)").forEach((el) => {
      const rect = el.getBoundingClientRect();
      // Not laid out yet (display:none ancestor) — skip until the panel is shown.
      if (rect.top === 0 && rect.bottom === 0 && rect.width === 0) return;
      const h = Math.max(MIN_H, Math.floor(window.innerHeight - rect.top - BOTTOM_PAD));
      el.style.height = h + "px";
      el.style.maxHeight = h + "px";
      el.style.minHeight = MIN_H + "px";
    });
  }

  // Grids compute fitColumns widths at layout time; re-run on viewport resize
  // so both axes track the window. 120 ms keeps drag-resize smooth.
  let _resizeTimer = null;
  function _redrawVisibleGrids() {
    const activePanel = document.querySelector(".panel.active");
    if (activePanel && activePanel.id) redrawPanelGrids(activePanel.id);
  }
  function onViewportResize() {
    sizeLists();
    clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(_redrawVisibleGrids, 120);
  }
  window.addEventListener("resize", onViewportResize);
  window.addEventListener("load", () => {
    sizeLists();
    requestAnimationFrame(() => {
      sizeLists();
      _redrawVisibleGrids();
    });
  });
  // First paint + after fonts/layout settle.
  requestAnimationFrame(() => {
    sizeLists();
    requestAnimationFrame(sizeLists);
  });

  return { sizeLists };
}
