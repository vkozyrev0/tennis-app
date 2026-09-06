// Shared UI primitives (D11 / audit A47 slice) — pulled out of monolithic app.js.
// Dependency-free except html`` for status chips.
import { hstr } from "./html.js";
import { fitMenuBox, parseLocaleDate } from "./td_helpers.js";

export { fitMenuBox };

// Colored status chip for known tokens (selection status, email status, etc.).
const BADGE = {
  selected: "ok", alternate: "warn", withdrawn: "bad",
  new: "warn", filed: "ok", needs_followup: "warn",
  pending: "warn", paired: "ok",
  mutual: "info", random: "muted",
  same_club: "info", siblings: "info",
};

const BADGE_LABEL = {
  selected: "Selected", alternate: "Alternate", withdrawn: "Withdrawn",
  new: "New", filed: "Filed", needs_followup: "Follow-up",
  pending: "Pending", paired: "Paired",
  mutual: "Mutual", random: "Random",
  same_club: "Same club", siblings: "Siblings",
};

export function chip(v) {
  if (v == null || v === "") return "";
  const label = BADGE_LABEL[v] || String(v).replace(/_/g, " ");
  return hstr`<span class="badge badge-${BADGE[v] || "muted"}">${label}</span>`;
}

export function money(n) {
  return n == null ? "—" : "$" + Number(n).toFixed(2);
}

// Lightweight dropdown-menu button — collapses a cluster of related toolbar
// actions into one trigger (design-crit R-1/I-8). `items` is an array of
// { label, onClick, title } objects (or { separator: true }). Returns the
// wrapper element ready to drop into a toolbar.
export function makeMenuButton(triggerHtml, items, opts = {}) {
  const wrap = document.createElement("div");
  wrap.className = "menu-btn-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = (opts.className || "export-btn no-print") + " menu-btn-trigger";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  if (opts.title) btn.title = opts.title;
  btn.innerHTML = opts.noCaret
    ? triggerHtml
    : `${triggerHtml} <span class="menu-caret" aria-hidden="true">▾</span>`;
  const pop = document.createElement("div");
  pop.className = "menu-btn-pop";
  pop.setAttribute("role", "menu");
  pop.hidden = true;
  for (const it of items) {
    if (it.separator) {
      const hr = document.createElement("div"); hr.className = "menu-btn-sep"; pop.appendChild(hr); continue;
    }
    const mi = document.createElement("button");
    mi.type = "button";
    mi.className = "menu-btn-item" + (it.danger ? " danger" : "");
    mi.setAttribute("role", "menuitem");
    mi.textContent = it.label;
    if (it.title) mi.title = it.title;
    mi.addEventListener("click", () => { close(); it.onClick(); });
    pop.appendChild(mi);
  }
  // opts.anchor: render the popup fixed-positioned on <body> instead of
  // absolutely inside the wrapper. Needed inside Tabulator cells, which clip
  // overflow and would otherwise hide the menu. Right-aligned under the button.
  const anchored = !!opts.anchor;
  function position() {
    const r = btn.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.right = "auto";
    // Measure after it is in the document so offsetHeight is real; fall back
    // to an estimate that still keeps Delete on-screen for a typical 4-item menu.
    const mw = Math.max(pop.offsetWidth || 0, 200);
    const mh = Math.max(pop.offsetHeight || 0, 44 * Math.max(1, menuItems().length || 4));
    const box = fitMenuBox({
      triggerTop: r.top, triggerBottom: r.bottom, triggerLeft: r.left, triggerRight: r.right,
      menuWidth: mw, menuHeight: mh,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, gap: 4,
    });
    pop.style.top = `${Math.round(box.top)}px`;
    pop.style.left = `${Math.round(box.left)}px`;
  }
  const menuItems = () => [...pop.querySelectorAll(".menu-btn-item:not([disabled])")];
  function focusItem(i) { const it = menuItems(); if (it.length) it[(i + it.length) % it.length].focus(); }
  // focusIdx: 0 = first item, -1 = last, null = leave focus on the trigger (mouse open).
  function open(focusIdx = null) {
    if (anchored) {
      document.body.appendChild(pop);
      pop.hidden = false;
      position();
      requestAnimationFrame(position);
    }
    pop.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDoc, true);
    document.addEventListener("keydown", onKey);
    if (anchored) {
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    }
    if (focusIdx != null) requestAnimationFrame(() => focusItem(focusIdx));
  }
  function close() {
    pop.hidden = true; btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDoc, true);
    document.removeEventListener("keydown", onKey);
    if (anchored) {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      if (pop.parentNode === document.body) wrap.appendChild(pop);
    }
  }
  function onDoc(e) { if (!wrap.contains(e.target) && !pop.contains(e.target)) close(); }
  function onKey(e) {
    if (e.key === "Escape") { close(); btn.focus(); return; }
    if (e.key === "Tab") { close(); return; }          // let focus leave the menu naturally
    const it = menuItems(); if (!it.length) return;
    const cur = it.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(cur < 0 ? 0 : cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(cur < 0 ? -1 : cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(-1); }
  }
  // Keyboard-activated click (Enter/Space) reports detail 0 → move focus into the
  // menu; a mouse click (detail>0) opens without stealing focus.
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden ? open(e.detail === 0 ? 0 : null) : close(); });
  // ArrowDown/Up on the closed trigger opens the menu and moves focus into it.
  btn.addEventListener("keydown", (e) => {
    if (pop.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) { e.preventDefault(); open(e.key === "ArrowDown" ? 0 : -1); }
  });
  wrap.append(btn, pop);
  return wrap;
}

export function formObj(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    // Multi-select serializes as a comma-joined string (matches the existing
    // backend contract for `events` + `willing_divisions` — both stored as
    // free-text comma-separated strings in TournamentEntry / DivisionFlex).
    if (el.tagName === "SELECT" && el.multiple) {
      const vals = [...el.selectedOptions].map((opt) => opt.value).filter(Boolean);
      o[el.name] = vals.length ? vals.join(", ") : null;
    } else {
      let v = el.value === "" ? null : el.value;
      if (v && (el.classList.contains("date-locale") || el.type === "date")) {
        v = parseLocaleDate(v) || v;
      }
      o[el.name] = v;
    }
  }
  return o;
}

// Register a submit handler that preventDefaults and disables the submit button
// while the async handler runs (guards against double-submit), re-enabling after.
export function onSubmit(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    // Audit M31 + N8/N9: disable just the named inputs (so the handler can't
    // see a half-edited form mid-flight) while leaving Cancel + close buttons
    // active so a stuck request can still be escaped. Snapshot which inputs
    // were *enabled* before we toggled, so we don't re-enable a field the
    // handler legitimately disabled (e.g. mode toggles in roster).
    const inputs = [...form.elements].filter((el) => el.name);
    const wasEnabled = inputs.filter((el) => !el.disabled);
    inputs.forEach((el) => (el.disabled = true));
    if (btn) btn.disabled = true;
    form.classList.add("is-submitting");
    try { await handler(e); }
    finally {
      // Re-enable only those inputs the handler didn't itself disable.
      wasEnabled.forEach((el) => { if (el.isConnected) el.disabled = false; });
      form.classList.remove("is-submitting");
      if (btn) btn.disabled = false;
    }
  });
}

// Fill a <select> from a list of {id, ...} rows (Audit M26: one DocumentFragment
// so enhanceSelect's MutationObserver fires once per fill, not per option).
export function fillSelect(el, items, labelFn, none = true) {
  if (!el) return;
  const cur = el.value;
  const frag = document.createDocumentFragment();
  if (none) {
    const o = document.createElement("option"); o.value = ""; o.textContent = "— none —";
    frag.appendChild(o);
  }
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id; o.textContent = labelFn(it);
    frag.appendChild(o);
  }
  el.replaceChildren(frag);
  el.value = cur;
}
