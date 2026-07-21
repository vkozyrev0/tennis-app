// List height + viewport-resize grid redraw (D11 slice from app.js).

/**
 * @param {{ redrawPanelGrids: (panelId: string) => void }} ctx
 * @returns {{ sizeLists: () => void }}
 */
export function createLayout(ctx) {
  const { redrawPanelGrids } = ctx;

  // Bound every scrollable list to the real space left below it so it never
  // runs off the bottom of the screen, whatever the toolbar height happens to be.
  function sizeLists() {
    const ls = document.querySelector(".panel.active .list-scroll");
    const top = ls ? ls.getBoundingClientRect().top : 160;
    const max = Math.max(140, window.innerHeight - top - 16);
    document.documentElement.style.setProperty("--list-max", max + "px");
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
  window.addEventListener("load", sizeLists);
  requestAnimationFrame(sizeLists);

  return { sizeLists };
}
