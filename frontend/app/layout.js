// List / grid height + viewport-resize redraw (D11 slice from app.js).
// Pins active-panel grids to the remaining viewport *minus* HTML after the
// grid (summaries, headings, compact tables, ancestor padding) so those
// blocks stay on-screen and the page does not grow a stray scrollbar.

// One 20px title row (no grouped header, no floating-filter row) + h-scroll.
export const LIST_HEADER_ROW_HEIGHT = 20;
export const LIST_GROUPED_HEADER_ROWS = 1;
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

// Preferred fill when the remaining viewport is tall enough. Never used as a
// floor that would push the grid past the window (that created a page scrollbar).
export const LIST_MIN_HEIGHT = 380;
// Subpixel / scrollbar slack. Ancestor padding (card, main) is measured
// separately via measureListBelowPx — do not double-count it here.
export const LIST_BOTTOM_PAD = 8;
export const LIST_STACK_GAP = 8;
// When after-grid HTML is taller than the window, still keep this much of the
// primary list (capped by remaining) so the work surface does not collapse to
// two rows. Overflowing summaries stay reachable by scrolling the panel.
export const LIST_KEEP_MIN = 240;

/** Smallest usable mount: header + h-scroll + two body rows. */
export function listFitMin() {
  return listChromeHeight() + listMinBodyHeight();
}

/** True when the mount's bottom stays at or above the viewport minus pad. */
export function listFitsViewport({
  top,
  height,
  viewportHeight,
  bottomPad = LIST_BOTTOM_PAD,
} = {}) {
  const vh = Number(viewportHeight) || 0;
  const t = Number(top) || 0;
  const h = Number(height) || 0;
  const pad = Number(bottomPad) || 0;
  if (h <= 0) return true;
  return t + h <= vh - pad + 0.5;
}

/**
 * Height that fills remaining viewport from `top` and never crosses the
 * window bottom. `belowPx` is HTML after this mount (headings, summaries,
 * compact grids, ancestor padding) that must stay on-screen. Stacked
 * full-height mounts can also leave a slim slice via `mountsBelow`.
 * Returns 0 when `top` is already at or past the usable bottom.
 */
export function listMountHeight({
  viewportHeight,
  top,
  bottomPad = LIST_BOTTOM_PAD,
  mountsBelow = 0,
  belowPx = 0,
} = {}) {
  const vh = Number(viewportHeight) || 0;
  const t = Number(top) || 0;
  const pad = Number(bottomPad) || 0;
  const nBelow = Math.max(0, Number(mountsBelow) || 0);
  const below = Math.max(0, Number(belowPx) || 0);
  const remaining = Math.floor(vh - t - pad);
  if (remaining <= 0) return 0;
  const leaveWanted = below + nBelow * (listFitMin() + LIST_STACK_GAP);
  if (leaveWanted <= 0) return remaining;
  const keepMin = Math.min(
    remaining,
    Math.max(listFitMin(), Math.min(LIST_KEEP_MIN, Math.floor(remaining * 0.45))),
  );
  const leave = Math.min(leaveWanted, Math.max(0, remaining - keepMin));
  return remaining - leave;
}

function _cssPx(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function _isShown(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.hidden) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden") return false;
  return true;
}

function _isFillMount(el) {
  return !!(el && el.classList
    && el.classList.contains("grid-mount")
    && !el.classList.contains("grid-mount--compact"));
}

/**
 * Pixels of document-flow content after `el`, walking up through `stopAt`
 * (default: nearest `main`) and including each ancestor's padding-bottom
 * and border. Full-height grid-mounts are counted as `fillMountPx` so a
 * previous sizeLists pass cannot inflate the reserve.
 */
export function measureListBelowPx(el, { stopAt = null, fillMountPx = 0 } = {}) {
  if (!el) return 0;
  let extra = 0;
  let node = el;
  const root = stopAt || (el.closest && el.closest("main")) || el.parentElement;
  const fill = Math.max(0, Number(fillMountPx) || 0);
  while (node && node !== root) {
    extra += _cssPx(getComputedStyle(node).marginBottom);
    let sib = node.nextElementSibling;
    while (sib) {
      if (_isShown(sib)) {
        const st = getComputedStyle(sib);
        extra += _cssPx(st.marginTop) + _cssPx(st.marginBottom);
        extra += _isFillMount(sib) ? fill : sib.getBoundingClientRect().height;
      }
      sib = sib.nextElementSibling;
    }
    const parent = node.parentElement;
    if (!parent) break;
    const ps = getComputedStyle(parent);
    extra += _cssPx(ps.paddingBottom) + _cssPx(ps.borderBottomWidth);
    node = parent;
  }
  return Math.max(0, Math.ceil(extra));
}

function listViewportHeight() {
  const vv = window.visualViewport;
  if (vv && vv.height) return vv.height;
  return document.documentElement.clientHeight || window.innerHeight;
}

/**
 * @param {{ redrawPanelGrids: (panelId: string) => void }} ctx
 * @returns {{ sizeLists: () => void }}
 */
export function createLayout(ctx) {
  const { redrawPanelGrids } = ctx;

  // Gap between the last painted pixel (grid + after-grid HTML) and the
  // viewport bottom. Ancestor padding is measured, not guessed.
  const BOTTOM_PAD = LIST_BOTTOM_PAD;
  const FILL_RESERVE = listFitMin() + LIST_STACK_GAP;
  let _inSize = false;
  let _watchedPanel = null;
  let _ro = null;
  let _roTimer = 0;

  function _watchPanel(panel) {
    if (typeof ResizeObserver === "undefined") return;
    if (_watchedPanel === panel) return;
    if (!_ro) {
      _ro = new ResizeObserver(() => {
        if (_inSize) return;
        clearTimeout(_roTimer);
        _roTimer = setTimeout(sizeLists, 50);
      });
    } else {
      _ro.disconnect();
    }
    _watchedPanel = panel;
    if (panel) _ro.observe(panel);
  }

  /**
   * Bound every scrollable list/grid in the active panel to the space left
   * below it so it never runs past the bottom of the window, whatever the
   * toolbar / breadcrumb / nav height happens to be.
   *
   * HTML after a mount (h4s, compact summaries, forms, ancestor padding)
   * is measured and reserved so those blocks stay on-screen instead of
   * being pushed past the fold by a viewport-filling grid.
   */
  function sizeLists() {
    const panel = document.querySelector(".panel.active");
    if (!panel) return;
    if (_inSize) return;
    _inSize = true;
    _watchPanel(panel);
    try {
      const vh = listViewportHeight();
      const stopAt = panel.closest("main") || panel;

      // CSS var for any remaining .list-scroll (legacy tables / unmigrated panels).
      const ls = panel.querySelector(".list-scroll");
      if (ls) {
        const top = ls.getBoundingClientRect().top;
        const belowPx = measureListBelowPx(ls, { stopAt, fillMountPx: FILL_RESERVE });
        const max = listMountHeight({
          viewportHeight: vh,
          top,
          bottomPad: BOTTOM_PAD,
          belowPx,
        });
        document.documentElement.style.setProperty("--list-max", max + "px");
        ls.style.maxHeight = max + "px";
        ls.style.minHeight = "0";
      } else {
        const fallback = Math.max(0, vh - 200);
        document.documentElement.style.setProperty("--list-max", fallback + "px");
      }

      // AG Grid mounts (Setup wireEntity + workspace makeListGrid/makeReadGrid).
      // Compact summary mounts keep content height; skip mounts inside the
      // detail modal so they don't steal viewport from the master list.
      const mounts = [...panel.querySelectorAll(".grid-mount:not(.grid-mount--compact)")]
        .filter((el) => !el.closest(".detail-pane, .modal"));
      mounts.forEach((el) => {
        const rect = el.getBoundingClientRect();
        // Not laid out yet (display:none ancestor) — skip until the panel is shown.
        if (rect.top === 0 && rect.bottom === 0 && rect.width === 0) return;
        const belowPx = measureListBelowPx(el, { stopAt, fillMountPx: FILL_RESERVE });
        const h = listMountHeight({
          viewportHeight: vh,
          top: rect.top,
          bottomPad: BOTTOM_PAD,
          belowPx,
        });
        el.style.height = h + "px";
        el.style.maxHeight = h + "px";
        el.style.minHeight = "0";
      });
    } finally {
      requestAnimationFrame(() => { _inSize = false; });
    }
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
