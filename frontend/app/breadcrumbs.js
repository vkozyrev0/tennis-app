// Breadcrumb / navigation history strip (D11 slice from app.js).
// Tracks the last N (group, panel) locations; chip click + Alt+Left go back.

const CRUMB_MAX = 8;

/**
 * @param {{ activateGroup: (key: string) => void }} ctx
 * @returns {{ pushCrumb: (group: string, panel: string) => void }}
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
    if (!group || !panel) return;
    const last = _navHistory[_navHistory.length - 1];
    if (last && last.group === group && last.panel === panel) return;
    _navHistory.push({ group, panel });
    if (_navHistory.length > CRUMB_MAX) _navHistory = _navHistory.slice(-CRUMB_MAX);
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
    if (_navHistory.length === 0) { _crumbsBar.hidden = true; return; }
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
      const li = document.createElement("li");
      if (isCurrent) {
        const span = document.createElement("span");
        span.className = "crumb-current";
        span.textContent = `${groupLabel} › ${tabLabel}`;
        span.setAttribute("aria-current", "page");
        li.appendChild(span);
      } else {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crumb-link";
        btn.textContent = `${groupLabel} › ${tabLabel}`;
        btn.title = `Jump back to ${groupLabel} › ${tabLabel}`;
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
      const cur = _navHistory[_navHistory.length - 1];
      _navHistory = cur ? [cur] : [];
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
