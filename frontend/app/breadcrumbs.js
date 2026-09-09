// Breadcrumb / navigation history strip (D11 slice from app.js).
// Tracks the last N (group, panel) locations *within the current L1 section*;
// chip click + Alt+Left go back. Switching Home / Inbox / Setup starts a new
// trail so sections do not stack. Clear hides the bar.

export const CRUMB_MAX = 8;

/** Next trail after a nav to (group, panel). Cross-section jumps replace. */
export function nextNavHistory(history, group, panel, { max = CRUMB_MAX } = {}) {
  if (!group || !panel) return (history || []).slice();
  const prev = Array.isArray(history) ? history : [];
  const last = prev[prev.length - 1];
  if (last && last.group === group && last.panel === panel) return prev.slice();
  if (last && last.group !== group) return [{ group, panel }];
  const next = prev.concat({ group, panel });
  return next.length > max ? next.slice(-max) : next;
}

/** Hide the strip until there is somewhere to step back to. */
export function crumbsBarHidden(historyLength) {
  return !(Number(historyLength) >= 2);
}

/**
 * @param {{ activateGroup: (key: string) => void }} ctx
 * @returns {{
 *   pushCrumb: (group: string, panel: string) => void,
 *   clearHistory: () => void,
 *   seedIfEmpty: (group: string, panel: string) => void,
 *   renderCrumbs: () => void,
 *   historyLength: () => number,
 * }}
 */
export function createBreadcrumbs(ctx) {
  const { activateGroup } = ctx;
  const _crumbsBar = document.getElementById("breadcrumbs");
  const _crumbList = document.getElementById("crumb-list");
  const _crumbBack = document.getElementById("crumb-back");
  const _crumbClear = document.getElementById("crumb-clear");
  let _navHistory = [];
  let _crumbJumping = false;

  function _crumbLabelFor(group, panel) {
    const groupEl = document.querySelector(`.menu-group[data-group="${group}"]`);
    const rawGroup = groupEl ? groupEl.querySelector(".menu-label").textContent.trim() : group;
    const groupLabel = rawGroup ? rawGroup.charAt(0).toUpperCase() + rawGroup.slice(1) : group;
    const tabEl = document.querySelector(`.tab[data-target="${panel}"]`);
    const tabLabel = tabEl ? tabEl.textContent.trim() : panel;
    return { groupLabel, tabLabel };
  }

  function pushCrumb(group, panel) {
    if (_crumbJumping) return;
    _navHistory = nextNavHistory(_navHistory, group, panel);
    _renderCrumbs();
  }

  function _jumpToCrumb(idx) {
    const target = _navHistory[idx];
    if (!target) return;
    _navHistory = _navHistory.slice(0, idx + 1);
    _crumbJumping = true;
    try {
      activateGroup(target.group);
      const tabEl = document.querySelector(`.tab[data-target="${target.panel}"]`);
      if (tabEl) tabEl.click();
    } finally {
      _crumbJumping = false;
    }
    _renderCrumbs();
  }

  function _renderCrumbs() {
    if (!_crumbsBar) return;
    if (crumbsBarHidden(_navHistory.length)) { _crumbsBar.hidden = true; return; }
    _crumbsBar.hidden = false;
    _crumbList.innerHTML = "";
    const CRUMB_VISIBLE = 4;
    const overflow = _navHistory.length > CRUMB_VISIBLE;
    const startIdx = overflow ? _navHistory.length - CRUMB_VISIBLE : 0;
    if (overflow) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "crumb-link"; btn.textContent = "…";
      btn.title = `${startIdx} earlier step(s) — jump to the oldest`;
      btn.addEventListener("click", () => _jumpToCrumb(0));
      li.appendChild(btn);
      _crumbList.appendChild(li);
    }
    _navHistory.slice(startIdx).forEach((entry, i) => {
      const idx = startIdx + i;
      const isCurrent = idx === _navHistory.length - 1;
      const { groupLabel, tabLabel } = _crumbLabelFor(entry.group, entry.panel);
      const crumbText = groupLabel.toLowerCase() === tabLabel.toLowerCase()
        ? groupLabel
        : `${groupLabel} › ${tabLabel}`;
      const li = document.createElement("li");
      if (isCurrent) {
        const span = document.createElement("span");
        span.className = "crumb-current";
        span.textContent = crumbText;
        span.setAttribute("aria-current", "page");
        li.appendChild(span);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crumb-link";
        btn.textContent = crumbText;
        btn.title = `Jump back to ${crumbText}`;
        btn.addEventListener("click", () => _jumpToCrumb(idx));
        li.appendChild(btn);
      }
      _crumbList.appendChild(li);
    });
    if (_crumbBack) _crumbBack.disabled = _navHistory.length < 2;
  }

  if (_crumbBack) {
    _crumbBack.addEventListener("click", () => {
      if (_navHistory.length < 2) return;
      _jumpToCrumb(_navHistory.length - 2);
    });
  }
  if (_crumbClear) {
    _crumbClear.addEventListener("click", () => {
      _navHistory = [];
      _renderCrumbs();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "ArrowLeft" && _navHistory.length >= 2) {
      e.preventDefault();
      _jumpToCrumb(_navHistory.length - 2);
    }
  });

  /** Clear history (e.g. on sign-out). */
  function clearHistory() {
    _navHistory = [];
    _renderCrumbs();
  }
  /** Seed with current tab if empty (first admin login / session restore). */
  function seedIfEmpty(group, panel) {
    if (_navHistory.length === 0 && group && panel) {
      _navHistory = [{ group, panel }];
      _renderCrumbs();
    }
  }
  function renderCrumbs() { _renderCrumbs(); }
  function historyLength() { return _navHistory.length; }

  return { pushCrumb, clearHistory, seedIfEmpty, renderCrumbs, historyLength };
}
