// Type-in searchable comboboxes (D11 / audit A47 slice).
// Progressively enhance every native <select> into a filterable, type-to-search
// dropdown. The native <select> stays in the DOM as the form's source of truth
// (value/required/submit/listeners all unchanged) — we just overlay a text input.

// Audit M27: many sites called scheduleComboSync() ad-hoc; this
// coalesces concurrent requests into a single rAF so combo-display refresh
// runs at most once per frame regardless of how many fillSelect calls fired.
let _comboScheduled = false;
export function scheduleComboSync() {
  if (_comboScheduled) return;
  _comboScheduled = true;
  requestAnimationFrame(() => {
    _comboScheduled = false;
    syncCombos();
  });
}

export function enhanceSelect(sel) {
  if (!sel || sel.dataset.combo) return;
  // One shared outside-click closer for ALL combos (plan P1 #7).
  if (!enhanceSelect._open) {
    enhanceSelect._open = new Set();
    document.addEventListener("click", (e) => {
      for (const c of [...enhanceSelect._open]) {
        if (!c.wrap.contains(e.target) && !c.list.contains(e.target)) c.close(true);
      }
    });
  }
  // Multi-selects (events, willing_divisions) stay as the native
  // `<select multiple size="N">` control — the type-in combo wrapper is a
  // single-value picker that wouldn't handle multi-selection.
  if (sel.multiple) return;
  sel.dataset.combo = "1";
  sel.tabIndex = -1;
  sel.classList.add("combo-native");
  const wrap = document.createElement("span");
  wrap.className = "combo";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const listId = "combo-list-" + (enhanceSelect._n = (enhanceSelect._n || 0) + 1);
  const input = document.createElement("input");
  input.type = "text"; input.className = "combo-input"; input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-haspopup", "listbox");
  input.setAttribute("aria-controls", listId);
  // Label the overlay input from the wrapping <label>'s leading text (the native
  // select is tabindex=-1, so AT reads the input).
  const lbl = sel.closest("label");
  const lblText = lbl && [...lbl.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
  input.setAttribute("aria-label",
    (sel.getAttribute("aria-label") || (lblText ? lblText.textContent : sel.name) || "select").trim());
  const list = document.createElement("div");
  list.className = "combo-list"; list.hidden = true; list.id = listId;
  list.setAttribute("role", "listbox");
  // The list is portaled to <body> (not kept inside `wrap`) so it can never be
  // clipped by a scrolling/transformed ancestor — e.g. the .detail-pane modal,
  // which is position:fixed + transform + overflow:auto and would otherwise trap
  // an absolutely-positioned dropdown inside its own scroll area.
  wrap.append(input);
  document.body.appendChild(list);
  let shown = [], hi = -1;

  function syncDisplay() {
    const o = sel.selectedOptions[0];
    const blank = [...sel.options].find((x) => x.value === "");
    // A blank/placeholder option becomes the input's grey placeholder (not its
    // value), so the field starts empty and you can type a search immediately.
    input.placeholder = blank ? blank.textContent : "";
    input.value = (o && o.value !== "") ? o.textContent : "";
    input.disabled = sel.disabled;
  }
  function render(q) {
    const t = (q || "").trim().toLowerCase();
    // The blank/placeholder option (value "") is shown as the input placeholder,
    // not as a selectable row. Optional fields are cleared by emptying the text.
    shown = [...sel.options].filter((o) => o.value !== "" && (!t || o.textContent.toLowerCase().includes(t)));
    list.innerHTML = "";
    if (!shown.length) { list.innerHTML = '<div class="combo-empty">No matches</div>'; return; }
    shown.forEach((o, i) => {
      const it = document.createElement("div");
      it.className = "combo-item" + (o.value === sel.value ? " sel" : "") + (i === hi ? " hi" : "");
      it.id = listId + "-opt-" + i;
      it.setAttribute("role", "option");
      it.setAttribute("aria-selected", o.value === sel.value ? "true" : "false");
      it.textContent = o.textContent;
      it.addEventListener("mousedown", (e) => { e.preventDefault(); choose(o); });
      list.appendChild(it);
    });
  }
  function paintHi() {
    [...list.children].forEach((c, i) => c.classList.toggle("hi", i === hi));
    const cur = list.children[hi];
    if (cur) { cur.scrollIntoView({ block: "nearest" }); input.setAttribute("aria-activedescendant", cur.id); }
    else input.removeAttribute("aria-activedescendant");
  }
  // Position the portaled list (position:fixed) under—or above—the input, using
  // the input's viewport rect. Flips up when there isn't room below, and caps the
  // height to the available space so it always scrolls internally rather than
  // pushing the page. Recomputed on open and on any scroll/resize while open.
  function positionList() {
    const r = input.getBoundingClientRect();
    const margin = 8, maxH = 240;
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const up = below < Math.min(maxH, list.scrollHeight) && above > below;
    list.style.position = "fixed";
    list.style.left = r.left + "px";
    list.style.width = r.width + "px";
    list.style.right = "auto";
    if (up) {
      list.style.top = "auto";
      list.style.bottom = (window.innerHeight - r.top + 2) + "px";
      list.style.maxHeight = Math.max(80, Math.min(maxH, above)) + "px";
    } else {
      list.style.bottom = "auto";
      list.style.top = (r.bottom + 2) + "px";
      list.style.maxHeight = Math.max(80, Math.min(maxH, below)) + "px";
    }
  }
  const reposition = () => { if (!list.hidden) positionList(); };
  // Outside-click close goes through ONE shared document listener (plan P1 #7)
  // instead of one standing listener per combo (~46 on a loaded page). Open
  // combos register in a set; the shared handler iterates 0-or-1 entries.
  const _openEntry = { wrap, list, close: (c) => close(c) };
  function open() {
    if (sel.disabled) return;
    render("");
    hi = shown.findIndex((o) => o.value === sel.value);
    paintHi();
    list.hidden = false;
    positionList();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    enhanceSelect._open.add(_openEntry);
    input.setAttribute("aria-expanded", "true");
  }
  // commit=true: if the text was cleared, clear the selection (for optional fields
  // that have a blank "" option). Otherwise just restore the displayed value.
  function close(commit) {
    list.hidden = true; hi = -1;
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    enhanceSelect._open.delete(_openEntry);
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (commit && input.value.trim() === "" && sel.value !== "" && [...sel.options].some((o) => o.value === "")) {
      sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    syncDisplay();
  }
  function choose(o) {
    sel.value = o.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    syncDisplay();
    close(false);
  }

  // Select existing text on focus so the first keystroke overtypes a prior choice.
  input.addEventListener("focus", () => { open(); input.select(); });
  input.addEventListener("click", open);
  input.addEventListener("input", () => {
    hi = -1;
    render(input.value);
    list.hidden = false;
    positionList();
    enhanceSelect._open.add(_openEntry);
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (list.hidden) return open();
      hi = Math.min(shown.length - 1, hi + 1);
      paintHi();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      hi = Math.max(0, hi - 1);
      paintHi();
    } else if (e.key === "Enter") {
      if (!list.hidden && shown[hi]) { e.preventDefault(); choose(shown[hi]); }
      else { e.preventDefault(); close(true); }
    } else if (e.key === "Escape") {
      if (!list.hidden) { e.preventDefault(); close(false); }
    }
  });
  // Keep the visible text in sync when options/value/disabled change in code.
  new MutationObserver(() => requestAnimationFrame(syncDisplay))
    .observe(sel, { childList: true, attributes: true, attributeFilter: ["disabled"] });
  sel.addEventListener("change", syncDisplay);
  sel._comboSync = syncDisplay;
  syncDisplay();
}

export function enhanceAllSelects() {
  document.querySelectorAll("select").forEach(enhanceSelect);
}

export function syncCombos() {
  document.querySelectorAll("select[data-combo]").forEach((s) => s._comboSync && s._comboSync());
}

// form.reset() doesn't fire change — resync combos after any reset.
if (typeof document !== "undefined") {
  document.addEventListener("reset", () => scheduleComboSync(), true);
}
