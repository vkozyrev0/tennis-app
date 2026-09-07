// List / grid height + viewport-resize redraw (D11 slice from app.js).
// Pins active-panel grids so their bottom stays at the viewport edge — the
// page itself does not grow a vertical scrollbar for Setup master-detail lists.

// Inbox uses grouped headers (2 rows) + floating filters + h-scroll. A 220px
// mount left ~58px of body after that chrome. Floor is chrome + ~2 data rows.
export const LIST_HEADER_ROW_HEIGHT = 20;
export const LIST_GROUPED_HEADER_ROWS = 3; // group + column + floating filter
export const LIST_ROW_HEIGHT = 32;
export const LIST_MIN_DATA_ROWS = 2;
export const LIST_HSCROLL = 16;
export const LIST_CHROME_SLACK = 24;

export function listChromeHeight({
  headerRows = LIST_GROUPED_HEADER_ROWS,
  headerRowHeight = LIST_HEADER_ROW_HEIGHT,
  hScroll = LIST_HSCROLL,
} = {}) {
  return headerRows * headerRowHeight + hScroll;
}

export function listMinBodyHeight({
  minRows = LIST_MIN_DATA_ROWS,
  rowHeight = LIST_ROW_HEIGHT,
} = {}) {
  return minRows * rowHeight;
}

/** Body pixels remaining inside a mount after grouped header + filters + h-scroll. */
export function listBodyMinFromMount(mountHeight) {
  return Math.max(0, (Number(mountHeight) || 0) - listChromeHeight());
}

// 380px leaves ~2 data rows after grouped header + floating filters (~118px chrome).
export const LIST_MIN_HEIGHT = 380;
export const LIST_BOTTOM_PAD = 16;

/** Viewport-fill height for one .grid-mount. Never returns 0. */
export function listMountHeight({
  viewportHeight,
  top,
  bottomPad = LIST_BOTTOM_PAD,
  mountsBelow = 0,
  minHeight = LIST_MIN_HEIGHT,
} = {}) {
  const vh = Number(viewportHeight) || 0;
  const t = Number(top) || 0;
  const reserveBelow = (Number(mountsBelow) || 0) > 0
    ? (Number(mountsBelow) * (minHeight + 8)) : 0;
  return Math.max(minHeight, Math.floor(vh - t - bottomPad - reserveBelow));
}

/**
 * @param {{ redrawPanelGrids: (panelId: string) => void }} ctx
 * @returns {{ sizeLists: () => void }}
 */
export function createLayout(ctx) {
  const { redrawPanelGrids } = ctx;

  // Gap between grid bottom and viewport bottom (matches visual breathing room).
  const BOTTOM_PAD = LIST_BOTTOM_PAD;
  const MIN_H = LIST_MIN_HEIGHT;

  /**
   * Bound every scrollable list/grid in the active panel to the space left
   * below it so it never runs past the bottom of the window, whatever the
   * toolbar / breadcrumb / nav height happens to be.
   *
   * When a panel has several non-compact mounts stacked, each is sized to the
   * remaining viewport from *its* top (later ones get a shorter height so the
   * stack still ends at the viewport bottom rather than forcing a page scroll).
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
    // Prefer the last full-height mount in the panel (main list) when several
    // exist — e.g. a toolbar summary grid above a primary table.
    const mounts = [...panel.querySelectorAll(".grid-mount:not(.grid-mount--compact)")];
    mounts.forEach((el, i) => {
      const rect = el.getBoundingClientRect();
      // Not laid out yet (display:none ancestor) — skip until the panel is shown.
      if (rect.top === 0 && rect.bottom === 0 && rect.width === 0) return;
      // When multiple mounts stack, leave a small gap for mounts below this one
      // so the *last* mount reaches the viewport edge and earlier ones don't
      // force document overflow.
      const mountsBelow = mounts.length - 1 - i;
      const h = listMountHeight({
        viewportHeight: window.innerHeight,
        top: rect.top,
        bottomPad: BOTTOM_PAD,
        mountsBelow,
        minHeight: MIN_H,
      });
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
