// Shared detail-pane backdrop, workspace form modals, ARIA dialog enhance (D11).

/**
 * One shared backdrop + close registry for master/detail overlays.
 * @returns {{
 *   detailBackdrop: HTMLElement,
 *   closeOpenDetail: () => void,
 *   setCloseOpenDetail: (fn: (() => void) | null) => void,
 * }}
 */
export function createDetailChrome() {
  const detailBackdrop = document.createElement("div");
  detailBackdrop.className = "detail-backdrop";
  document.body.appendChild(detailBackdrop);
  let _closeOpenDetail = null;
  function closeOpenDetail() { if (_closeOpenDetail) _closeOpenDetail(); }
  function setCloseOpenDetail(fn) { _closeOpenDetail = fn; }
  detailBackdrop.addEventListener("click", closeOpenDetail);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    // Let grid cell editors swallow Escape (C8).
    if (document.querySelector(".tabulator-editing") || document.querySelector(".ag-cell-inline-editing")) {
      return;
    }
    closeOpenDetail();
  });
  return { detailBackdrop, closeOpenDetail, setCloseOpenDetail };
}

/** Workspace add-forms wrapped as centered modals (grid stays primary). */
export const FORM_MODALS = {
  "withdrawal-form": "Add withdrawal",
  "sched-form": "Add scheduling avoidance",
  "divflex-form": "Add division flexibility",
  "pairing-form": "Add pairing group",
  "doubles-form": "File doubles request",
  "photel-form": "Add player hotel",
  "late-form": "Add late entry",
  "trb-form": "Add room block",
  "asg-form": "Assign official",
  "email-form": "Add email",
};

/**
 * @param {{
 *   scheduleComboSync: () => void,
 *   detailBackdrop: HTMLElement,
 *   setCloseOpenDetail: (fn: (() => void) | null) => void,
 * }} ctx
 */
export function installFormModals(ctx) {
  const { scheduleComboSync, detailBackdrop, setCloseOpenDetail } = ctx;
  for (const [id, label] of Object.entries(FORM_MODALS)) {
    const form = document.getElementById(id);
    if (!form || form.closest(".detail-pane")) continue;
    const trigger = document.createElement("button");
    trigger.type = "button"; trigger.className = "new-btn add-trigger";
    trigger.textContent = "＋ " + label;
    const modal = document.createElement("div"); modal.className = "detail-pane form-modal";
    const close = document.createElement("button");
    close.type = "button"; close.className = "detail-close";
    close.textContent = "×"; close.title = "Close";
    const heading = document.createElement("h3");
    heading.className = "detail-title"; heading.textContent = label;
    form.parentNode.insertBefore(trigger, form);
    form.parentNode.insertBefore(modal, form);
    modal.append(close, heading, form);
    const openM = () => {
      modal.classList.add("detail-open");
      detailBackdrop.classList.add("show");
      setCloseOpenDetail(closeM);
      scheduleComboSync();
    };
    const closeM = () => {
      modal.classList.remove("detail-open");
      detailBackdrop.classList.remove("show");
      setCloseOpenDetail(null);
      if (form._wasFiling) {
        form._wasFiling = false;
        const inboxTab = document.querySelector('.tab[data-target="panel-t-inbox"]');
        if (inboxTab) inboxTab.click();
      }
    };
    trigger.addEventListener("click", () => { form._wasFiling = false; openM(); });
    close.addEventListener("click", closeM);
    form.addEventListener("reset", closeM);
    form._openModal = openM;
  }
}

/** Promote detail-panes to ARIA dialogs + focus restore + background inert. */
export function enhanceDetailDialogs() {
  let _detailPanesHoisted = false;
  function _hoistDetailPanes() {
    if (_detailPanesHoisted) return;
    for (const dlg of document.querySelectorAll(".detail-pane")) {
      document.body.appendChild(dlg);
    }
    _detailPanesHoisted = true;
  }
  function _setBackgroundInert(on) {
    if (on) _hoistDetailPanes();
    if (on) {
      const sbw = window.innerWidth - document.documentElement.clientWidth;
      if (sbw > 0) document.body.style.paddingRight = sbw + "px";
      document.documentElement.style.overflow = "hidden";
    } else {
      document.documentElement.style.overflow = "";
      document.body.style.paddingRight = "";
    }
    for (const el of [
      document.querySelector("header"),
      document.querySelector("nav.menu-l1"),
      document.querySelector("nav.menu"),
      document.querySelector("main"),
    ]) {
      if (!el) continue;
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    }
  }
  function _anyDialogOpen() {
    return !!document.querySelector(".detail-pane.detail-open")
      || !!document.querySelector(".modal:not([hidden])");
  }
  function _refreshBackgroundInert() { _setBackgroundInert(_anyDialogOpen()); }

  const confirmModal = document.getElementById("confirm-modal");
  if (confirmModal) {
    new MutationObserver(_refreshBackgroundInert).observe(
      confirmModal,
      { attributes: true, attributeFilter: ["hidden"] },
    );
  }

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName !== "class") continue;
      const dlg = m.target;
      const opening = dlg.classList.contains("detail-open");
      const wasOpen = m.oldValue && m.oldValue.split(/\s+/).includes("detail-open");
      _refreshBackgroundInert();
      if (opening && !wasOpen) {
        const a = document.activeElement;
        const row = a && a.closest && a.closest(".tabulator-row[data-id], .ag-row");
        dlg._prevFocus = a;
        dlg._prevRowId = row ? (row.getAttribute("data-id") || row.getAttribute("row-id")) : null;
        requestAnimationFrame(() => {
          const f = dlg.querySelector(
            'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
          ) || dlg.querySelector("button:not([disabled])");
          if (f) try { f.focus(); } catch (_) {}
        });
      } else if (!opening && wasOpen) {
        const prev = dlg._prevFocus;
        if (prev && prev.isConnected && typeof prev.focus === "function") {
          try { prev.focus(); } catch (_) {}
        } else if (dlg._prevRowId) {
          const restored = document.querySelector(
            `.tabulator-row[data-id="${dlg._prevRowId}"], .ag-row[row-id="${dlg._prevRowId}"]`,
          );
          if (restored) try { restored.focus(); } catch (_) {}
        }
      }
    }
  });
  for (const dlg of document.querySelectorAll(".detail-pane")) {
    if (!dlg.hasAttribute("role")) {
      dlg.setAttribute("role", "dialog");
      dlg.setAttribute("aria-modal", "true");
      const title = dlg.querySelector(".detail-title");
      if (title) {
        if (!title.id) title.id = "dlg-" + Math.random().toString(36).slice(2, 8);
        dlg.setAttribute("aria-labelledby", title.id);
      }
    }
    obs.observe(dlg, { attributes: true, attributeOldValue: true, attributeFilter: ["class"] });
  }

  // Bespoke `.modal` dialogs (payroll, admin users, auth, import) are created
  // on demand or toggled via [hidden]. Give them the same focus move/restore and
  // background inert as the detail panes.
  let _lastModalFocus = null;
  function _modalFocusables(m) {
    return [...m.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.hidden && el.getClientRects().length);
  }
  function _watchModal(m) {
    if (m._focusWatched) return;
    m._focusWatched = true;
    let open = false;
    const sync = () => {
      const nowOpen = !m.hidden;
      if (nowOpen === open) return;
      open = nowOpen;
      if (open) {
        if (!m.hasAttribute("role")) m.setAttribute("role", "dialog");
        if (!m.hasAttribute("aria-modal")) m.setAttribute("aria-modal", "true");
        _lastModalFocus = document.activeElement;
        _refreshBackgroundInert();
        requestAnimationFrame(() => {
          const f = _modalFocusables(m)[0];
          if (f) try { f.focus(); } catch (_) {}
        });
      } else {
        const prev = _lastModalFocus;
        _lastModalFocus = null;
        _refreshBackgroundInert();
        if (prev && prev.isConnected && typeof prev.focus === "function") {
          try { prev.focus(); } catch (_) {}
        }
      }
    };
    new MutationObserver(sync).observe(m, { attributes: true, attributeFilter: ["hidden"] });
    sync();
  }
  document.querySelectorAll(".modal").forEach(_watchModal);
  new MutationObserver((muts) => {
    for (const mut of muts) {
      for (const n of mut.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(".modal")) _watchModal(n);
        if (n.querySelectorAll) n.querySelectorAll(".modal").forEach(_watchModal);
      }
    }
  }).observe(document.body, { childList: true });

  // Trap Tab inside the open dialog so focus cannot walk the inert background.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const m = document.querySelector(".modal:not([hidden]), .detail-pane.detail-open");
    if (!m) return;
    const f = _modalFocusables(m);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
}
