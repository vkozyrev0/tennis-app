// Audit A47: imports from sibling ESM module(s). app.js itself is now loaded
// as <script type="module">.
import {
  esc, fmtDOW, fmtMDY as _fmtMDY, dowLong as _dowLong,
  isoToUTCDate as _isoToUTCDate, fmtIsoUTC as _fmtIsoUTC,
  humanizeDetail as _humanizeDetail, csvDownload as _csvDownload,
} from "./app/util.js";
import {
  SHIRT_CODES as _SHIRT_CODES, SHIRT_LABEL as _SHIRT_LABEL,
  SHIRT_LABELS, SIZE_TOKEN as _SIZE_TOKEN,
} from "./app/shirts.js";

// ============================================================================
// CourtOps Tennis — frontend (single file, vanilla JS, no framework).
//
// Two areas:
//  * Setup — persistent master data (tournaments catalog, sites, officials,
//    players, rates, hotels, distances) via generic master-detail CRUD.
//  * Tournament workspace — an active tournament (shown in the context bar,
//    persisted) scopes Sites / Roster / Assignments / Room blocks / Part B.
//
// Sections (rough line ranges — search the headers if these drift):
//   Theme + small helpers (esc, api, toast, setMsg, confirmDialog, chip)
//   Keyboard shortcuts + help modal
//   Type-in searchable comboboxes (enhanceSelect / syncCombos)
//   Caches + labels + tabs + two-level menu + sizeLists
//   Active tournament state (setActive / updateActiveUI)
//   GRIDS registry + grid helpers (wireEntity, makeListGrid, makeReadGrid,
//     wirePlayerList) — these factories own Tabulator wiring
//   Tournament workspace pages (Sites toggle, Roster, Import, Assignments,
//     Room blocks, Availability, Inbox + Part B lists, T-shirts, Pairing,
//     Doubles, Reports)
//   Setup entity configs (tournamentsCrud … distancesCrud)
//   CSV export helpers
//   FORM_MODALS — wraps workspace add-forms as modal overlays
//   ARIA enhancement for every .detail-pane (role=dialog + focus management)
//   Auth + role-based views (admin vs official)
// ============================================================================

// ---- theme (light/dark) — applied ASAP to avoid a flash, persisted locally ----
function applyTheme(t) {
  const dark = t === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) { /* ignore */ }
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = dark ? "☀ Light" : "🌙 Dark";
}
applyTheme((() => { try { return localStorage.getItem("theme"); } catch (e) { return null; } })() || "light");
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    applyTheme(document.documentElement.getAttribute("data-theme"));  // sync label
    btn.addEventListener("click", () =>
      applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark"));
  }
  // a11y re-review #1: every static <th> in a list-table gets scope="col" so
  // SR users get explicit header→cell mapping. JS-built Tabulator grids set
  // scope themselves.
  document.querySelectorAll(".list-table thead th").forEach((th) => {
    if (!th.hasAttribute("scope")) th.setAttribute("scope", "col");
  });
  // a11y re-review #5: register every inline form-status span as a polite
  // live region at page load so screen readers pre-track them. setMsg() also
  // re-asserts the role per-message; this is the safety net.
  document.querySelectorAll("span.msg").forEach((el) => {
    if (!el.hasAttribute("role")) el.setAttribute("role", "status");
    if (!el.hasAttribute("aria-live")) el.setAttribute("aria-live", "polite");
  });
  // a11y re-review #7: main panel-switching tabs get role="tab" semantics +
  // aria-selected reflecting the .active class, aria-controls pointing at the
  // panel they reveal. Each .menu-group becomes a tablist. The existing click
  // handlers flip .active; we mirror that into aria-selected via observer.
  document.querySelectorAll(".menu-group").forEach((g) => g.setAttribute("role", "tablist"));
  document.querySelectorAll(".menu .tab").forEach((b) => {
    b.setAttribute("role", "tab");
    const target = b.dataset.target;
    if (target) b.setAttribute("aria-controls", target);
    b.setAttribute("aria-selected", b.classList.contains("active") ? "true" : "false");
  });
  // Sync aria-selected when .active changes (handled by existing click code).
  const tabObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName === "class" && m.target.classList.contains("tab")) {
        m.target.setAttribute("aria-selected", m.target.classList.contains("active") ? "true" : "false");
      }
    }
  });
  document.querySelectorAll(".menu .tab").forEach((b) => tabObserver.observe(b, { attributes: true, attributeFilter: ["class"] }));
  // a11y re-review #2: blank detail-title <h3>s are noisy for SR linear reads;
  // hide them until populated. Setup populates textContent on selection.
  document.querySelectorAll("h3.detail-title").forEach((h) => {
    if (!h.textContent.trim()) h.hidden = true;
  });
  const titleObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      const h = m.target;
      h.hidden = !h.textContent.trim();
    }
  });
  document.querySelectorAll("h3.detail-title").forEach((h) =>
    titleObserver.observe(h, { childList: true, characterData: true, subtree: true }));
  // a11y 5th-pass #3: label the per-panel "×" close buttons.
  document.querySelectorAll("button.detail-close").forEach((b) => {
    if (!b.hasAttribute("aria-label")) b.setAttribute("aria-label", "Close details");
  });
  // a11y 5th-pass #1: sr-only <caption> per static table to give SR users a
  // purpose label when jumping by tables.
  document.querySelectorAll("table.list-table").forEach((t) => {
    if (t.querySelector("caption")) return;
    const panel = t.closest(".panel, section, .card");
    const h = panel?.querySelector("h3, h2, h4");
    const label = h?.textContent.trim().replace(/\s+/g, " ") || "Data table";
    const cap = document.createElement("caption");
    cap.className = "sr-only";
    cap.textContent = label;
    t.insertBefore(cap, t.firstChild);
  });
  // a11y 5th-pass #2: WAI-ARIA roving tabindex on main panel tabs. Only the
  // active tab in each group is reachable by Tab; arrow keys move focus
  // within the group (and activate the new tab so the panel switches).
  document.querySelectorAll(".menu-group").forEach((group) => {
    const tabs = [...group.querySelectorAll(".tab")];
    const sync = () => {
      tabs.forEach((t) => { t.tabIndex = t.classList.contains("active") ? 0 : -1; });
    };
    sync();
    // Re-sync on class changes (MutationObserver in DOMContentLoaded already
    // covers aria-selected; piggyback by observing here too).
    new MutationObserver(sync).observe(group, { attributes: true, attributeFilter: ["class"], subtree: true });
    group.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const cur = tabs.indexOf(document.activeElement);
      if (cur < 0) return;
      e.preventDefault();
      let next;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else if (e.key === "ArrowLeft") next = (cur - 1 + tabs.length) % tabs.length;
      else next = (cur + 1) % tabs.length;
      tabs[next].focus();
      tabs[next].click();  // activate panel to match WAI-ARIA "automatic activation" tabs pattern
    });
  });
});

let _inflight = 0;
function _progress(delta) {
  _inflight = Math.max(0, _inflight + delta);
  const p = document.getElementById("progress");
  if (p) {
    const busy = _inflight > 0;
    p.classList.toggle("active", busy);
    // a11y re-review #6: surface busy state to SR users via the progressbar
    // role declared in markup; hide it when idle so SR doesn't keep a stale
    // "loading" landmark on the page.
    p.setAttribute("aria-hidden", busy ? "false" : "true");
  }
}
// _humanizeDetail now imported from ./app/util.js (audit A47).
async function api(path, options) {
  _progress(1);
  try {
    const hasBody = options && options.body;
    // Only set Content-Type when there's a body, and never on FormData (which
    // needs the browser to set the multipart boundary itself).
    const headers = hasBody && !(options.body instanceof FormData)
      ? { "Content-Type": "application/json" } : {};
    const res = await fetch("/api" + path, { ...options, headers: { ...headers, ...(options && options.headers) } });
    let body = null;
    if (res.status !== 204) {
      try { body = await res.json(); }
      catch (_) { /* non-JSON error page (HTML 5xx, gateway, etc.) */ }
    }
    if (!res.ok) {
      const detail = body && body.detail !== undefined ? body.detail : res.statusText;
      // Audit F3: a 401 anywhere outside the login path means the session
      // expired — surface it once and prompt re-login so panels don't just
      // silently blank out (the old Promise.allSettled fix in N14 still kept
      // every individual rejection's message but never re-prompted).
      if (res.status === 401 && !path.startsWith("/auth/")) {
        document.dispatchEvent(new CustomEvent("auth-expired"));
      }
      throw new Error(_humanizeDetail(detail, `${res.status} ${res.statusText}`.trim()));
    }
    return body;
  } finally {
    _progress(-1);
  }
}
function toast(text, ok = true, action = null) {
  const box = document.getElementById("toasts");
  if (!box || !text) return;
  const t = document.createElement("div");
  t.className = "toast " + (ok ? "ok" : "bad");
  t.setAttribute("role", ok ? "status" : "alert");
  // text in its own span so the optional action button/close sit beside it
  const span = document.createElement("span"); span.textContent = text; t.appendChild(span);
  // Optional inline action (e.g. "View") — dismisses the toast then runs.
  if (action && action.label && typeof action.onClick === "function") {
    const a = document.createElement("button");
    a.type = "button"; a.className = "toast-action"; a.textContent = action.label;
    a.addEventListener("click", () => { t.remove(); action.onClick(); });
    t.appendChild(a);
  }
  // a11y #10: error toasts get a close button + stay until dismissed (WCAG
  // 2.2.1 Timing Adjustable). Success toasts still auto-fade. A success toast
  // WITH an action lingers longer so there's time to click it.
  if (!ok) {
    const x = document.createElement("button");
    x.type = "button"; x.className = "toast-close"; x.textContent = "×";
    x.setAttribute("aria-label", "Dismiss notification");
    x.addEventListener("click", () => t.remove());
    t.appendChild(x);
  }
  box.appendChild(t);
  if (ok) {
    const ttl = action ? 7000 : 2500;
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, ttl);
  }
}
function setMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.className = "msg " + (ok ? "ok" : "bad");
    el.setAttribute("role", ok ? "status" : "alert");
    // Keep error messages visible until the next form interaction; ok messages auto-clear.
    if (text && ok !== false) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
  }
  toast(text, ok);
}

// Find the form input most likely responsible for a server error message and
// flag it (aria-invalid + .field-error + focus). Errors that don't match any
// field name fall back to the form-level message only.
function markInvalid(form, errorText) {
  if (!form || !errorText) return;
  // Strip prior invalid marks before re-evaluating.
  for (const el of form.querySelectorAll("[aria-invalid='true']")) {
    el.removeAttribute("aria-invalid"); el.classList.remove("field-error");
  }
  const t = String(errorText).toLowerCase();
  // candidates: input/select/textarea with a name
  const fields = [...form.elements].filter((e) => e.name);
  // word-boundary search: the field name (or its dash/space variants) appears in the error
  const hit = fields.find((e) => {
    const n = e.name.toLowerCase();
    const words = [n, n.replace(/_/g, " "), n.replace(/_/g, "-")];
    return words.some((w) => new RegExp("\\b" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(t));
  });
  if (hit) {
    hit.setAttribute("aria-invalid", "true"); hit.classList.add("field-error");
    try { hit.focus(); } catch (_) {}
  }
}
// Clear the invalid mark as soon as the user starts editing the flagged field.
document.addEventListener("input", (e) => {
  const t = e.target;
  if (t && t.getAttribute && t.getAttribute("aria-invalid") === "true") {
    t.removeAttribute("aria-invalid"); t.classList.remove("field-error");
  }
}, true);

// Styled confirm dialog (replaces native confirm); returns a Promise<bool>.
function confirmDialog(message, okLabel = "Delete", okKind = "danger") {
  return new Promise((resolve) => {
    const m = document.getElementById("confirm-modal");
    const ok = document.getElementById("confirm-ok");
    const cancel = document.getElementById("confirm-cancel");
    document.getElementById("confirm-text").textContent = message;
    ok.textContent = okLabel;
    // Audit P41: reset class state every open so a previous "danger" label
    // doesn't leak into a benign confirm (e.g. order cancellation).
    ok.className = "confirm-ok " + (okKind === "danger" ? "danger" : "primary");
    // a11y re-review #3: remember invoker so focus returns on close, default
    // focus to Cancel (safer than focusing the destructive button), and trap
    // Tab within the modal's two buttons.
    const invoker = document.activeElement;
    // a11y 5th-pass #4: mark non-modal landmarks `inert` so assistive-tech
    // virtual cursors can't reach background controls while the dialog is up.
    const inertTargets = ["header", "nav.menu-l1", "nav.menu", "main#main-app", "main#official-app"]
      .map((sel) => document.querySelector(sel)).filter(Boolean);
    inertTargets.forEach((el) => el.setAttribute("inert", ""));
    m.hidden = false;
    cancel.focus();
    const done = (v) => {
      m.hidden = true;
      inertTargets.forEach((el) => el.removeAttribute("inert"));
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      if (invoker && typeof invoker.focus === "function") invoker.focus();
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); done(false); return; }
      if (e.key === "Enter" && document.activeElement !== cancel) { e.preventDefault(); done(true); return; }
      if (e.key === "Tab") {
        // Trap focus between cancel and ok.
        const focusables = [cancel, ok];
        const idx = focusables.indexOf(document.activeElement);
        e.preventDefault();
        const next = e.shiftKey
          ? focusables[(idx <= 0 ? focusables.length - 1 : idx - 1)]
          : focusables[(idx + 1) % focusables.length];
        next.focus();
      }
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

// Keyboard shortcuts: `/` focuses the active panel's filter, `n`/`N` triggers
// its + New / + Add button, `?` opens the shortcuts help. Skipped while the
// user is typing in a field. Esc-to-close-modal is handled by the detail-pane
// MutationObserver block elsewhere.
function showShortcuts() {
  let m = document.getElementById("shortcuts-modal");
  if (!m) {
    m = document.createElement("div"); m.id = "shortcuts-modal"; m.className = "modal";
    m.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <h3 id="shortcuts-title" style="margin-top:0">Keyboard shortcuts</h3>
        <table class="shortcuts"><tbody>
          <tr><th><kbd>/</kbd></th><td>Focus the page filter</td></tr>
          <tr><th><kbd>n</kbd></th><td>Add a new record on the active panel</td></tr>
          <tr><th><kbd>1</kbd>-<kbd>9</kbd></th><td>Jump to the Nth tab in the current menu</td></tr>
          <tr><th><kbd>Esc</kbd></th><td>Close the open dialog</td></tr>
          <tr><th><kbd>?</kbd></th><td>Show this help</td></tr>
        </tbody></table>
        <div class="actions-row" style="margin-top:0.75rem"><button type="button" id="shortcuts-close">Close</button></div>
      </div>`;
    document.body.appendChild(m);
    const close = () => {
      m.hidden = true;
      if (m._invoker && typeof m._invoker.focus === "function") m._invoker.focus();
    };
    m.querySelector("#shortcuts-close").addEventListener("click", close);
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    // a11y 4th-pass #3: trap Tab inside the shortcuts dialog the same way
    // the confirm dialog does. Only one focusable inside (Close), but Tab
    // and Shift+Tab still need to stay there.
    m.addEventListener("keydown", (e) => {
      if (m.hidden) return;
      if (e.key === "Tab") {
        e.preventDefault();
        m.querySelector("#shortcuts-close").focus();
      }
    });
  }
  m._invoker = document.activeElement;
  m.hidden = false;
  requestAnimationFrame(() => m.querySelector("#shortcuts-close").focus());
}
const _shortcutsBtn = document.getElementById("shortcuts-btn");
if (_shortcutsBtn) _shortcutsBtn.addEventListener("click", showShortcuts);
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  const a = document.activeElement;
  const inField = a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "button";
  if (inField) return;
  // Skip while a confirm dialog or shortcuts modal is open.
  const sm = document.getElementById("shortcuts-modal");
  if (sm && !sm.hidden) {
    if (e.key === "Escape") { sm.hidden = true; e.preventDefault(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") {
    const p = document.querySelector(".panel.active");
    const f = p && p.querySelector("input.filter, input[type=search]");
    if (f) { e.preventDefault(); f.focus(); f.select(); }
  } else if (e.key === "n" || e.key === "N") {
    const p = document.querySelector(".panel.active");
    const t = p && (p.querySelector(".new-btn:not(.add-trigger)") || p.querySelector(".add-trigger"));
    if (t) { e.preventDefault(); t.click(); }
  } else if (e.key === "?") {
    e.preventDefault(); showShortcuts();
  } else if (/^[1-9]$/.test(e.key)) {
    // Audit P46: numeric keys jump to the Nth tab in the currently visible
    // menu group, giving keyboard parity with mouse tab clicks.
    const tabs = [...document.querySelectorAll(".menu .tab")].filter((t) =>
      t.offsetParent !== null);  // visible only
    const idx = Number(e.key) - 1;
    if (tabs[idx]) { e.preventDefault(); tabs[idx].click(); tabs[idx].focus(); }
  }
});

// =================== Division + Event lookup lists ===================
// Loaded from the Setup catalog (/api/divisions, /api/events) on init and
// refreshed when those CRUDs change. The TD can add/edit/remove rows from the
// Setup tabs without a code change — see migration 0027 for the seed data.
let divisionsAll = [];
let eventsAll = [];

function _populateDatalist(id, items) {
  const dl = document.getElementById(id);
  if (!dl) return;
  dl.innerHTML = items.map((it) => {
    const value = typeof it === "string" ? it : it.code;
    const label = typeof it === "string" ? "" : (it.label === it.code ? "" : it.label);
    return `<option value="${esc(value)}"${label ? ` label="${esc(label)}"` : ""}>${esc(label || value)}</option>`;
  }).join("");
}
// Filter divisions / events by tournament type + (optional) player gender.
// The catalog rows carry `tournament_type` and `gender` (null = any), so the
// rule reduces to: row matches its tournament_type AND (row.gender is null OR
// row.gender equals the player's gender OR no gender supplied).
function _divisionsFor(type, gender) {
  return divisionsAll.filter((d) => d.tournament_type === type
    && (d.gender == null || !gender || d.gender === gender));
}
function _eventsFor(type, gender) {
  return eventsAll
    .filter((e) => e.tournament_type === type
      && (e.gender == null || !gender || e.gender === gender))
    .map((e) => e.name);
}
function refreshDivisionLists(gender) {
  // Default to junior when no tournament is active so the form still has
  // useful suggestions on first open.
  const type = (active && active.type) || "junior";
  _populateDatalist("divisions-list", _divisionsFor(type, gender || null));
  _populateDatalist("events-list", _eventsFor(type, gender || null));
  // Also (re)populate any `<select data-catalog="division|event">` controls
  // that have replaced the legacy free-text inputs.
  _populateCatalogSelects(type, gender || null);
}

// Tabulator `editor: "list"` parameter factories — same data source as the
// <select data-catalog> form controls. Returned object plugs into the
// column's `editorParams` (function form, so the active tournament + gender
// are evaluated lazily when the editor opens).
function _divisionListParams(opts) {
  const o = opts || {};
  const type = (active && active.type) || "junior";
  const items = _divisionsFor(type, o.gender || null);
  return {
    values: items.map((d) => ({ label: d.code, value: d.code })),
    autocomplete: true, listOnEmpty: true, clearable: true,
    multiselect: !!o.multiple,
  };
}
// Helper for in-grid editors on rows that include a player reference but
// not the player's gender column — looks it up via playersById.
function _rowGender(row) {
  if (!row || typeof playersById !== "object") return null;
  if (row.player_id && playersById[row.player_id]) return playersById[row.player_id].gender || null;
  if (row.usta_number) {
    const p = Object.values(playersById).find((x) => x.usta_number === row.usta_number);
    return p ? (p.gender || null) : null;
  }
  return null;
}
function _eventListParams(opts) {
  const o = opts || {};
  const type = (active && active.type) || "junior";
  const items = _eventsFor(type, o.gender || null);
  return {
    values: items.map((n) => ({ label: n, value: n })),
    autocomplete: true, listOnEmpty: true, clearable: true,
    multiselect: !!o.multiple,
  };
}

// Fill every <select data-catalog="division|event"> in the page from the
// catalog arrays, filtered by tournament type + (optional) player gender.
// Preserves the current selection where the value still exists.
function _populateCatalogSelects(type, gender) {
  const divs = _divisionsFor(type, gender);
  const evs = _eventsFor(type, gender);
  for (const sel of document.querySelectorAll('select[data-catalog]')) {
    const kind = sel.getAttribute("data-catalog");
    const items = kind === "event" ? evs.map((n) => ({ code: n, label: n }))
                                   : divs;  // [{code, label}, ...]
    // Snapshot current selection so we can re-apply it after rebuilding.
    const isMulti = sel.multiple;
    const prevSelected = isMulti
      ? new Set([...sel.selectedOptions].map((o) => o.value))
      : sel.value;
    // Rebuild options. Single-select keeps the existing "— pick … —"
    // placeholder (it's the first <option value="">); multi-select doesn't
    // need a placeholder.
    const placeholder = !isMulti && sel.querySelector('option[value=""]');
    sel.innerHTML = "";
    if (placeholder) sel.appendChild(placeholder);
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.code;
      o.textContent = it.label === it.code ? it.code : `${it.code} — ${it.label}`;
      sel.appendChild(o);
    }
    // Re-apply selection.
    if (isMulti) {
      [...sel.options].forEach((o) => { if (prevSelected.has(o.value)) o.selected = true; });
    } else if (prevSelected) {
      // If the prior value is no longer in the filtered set, append it as a
      // legacy option so the form doesn't silently drop it (e.g. an inbox
      // filed entry with a value the TD has since removed from the catalog).
      if (![...sel.options].some((o) => o.value === prevSelected)) {
        const o = document.createElement("option");
        o.value = prevSelected; o.textContent = prevSelected + " (legacy)";
        sel.appendChild(o);
      }
      sel.value = prevSelected;
    }
    // The type-in combo wrapper (enhanceSelect) keeps its own display state
    // that needs to be re-synced from the native <select>'s options + value.
    if (sel.dataset.combo === "1") scheduleComboSync();
  }
}
// When a division/events input gains focus, infer the player gender from the
// containing form (player_ref combobox, roster's player_id picker, or the
// inline-create gender select) and refresh the shared datalists accordingly.
function _inferFormGender(form) {
  if (!form || typeof playersById !== "object") return null;
  const pref = form.querySelector("[name='player_ref']");
  if (pref && pref.value) return (playersById[pref.value] || {}).gender || null;
  const picker = form.querySelector("[name='player_id']");
  if (picker && picker.value && !picker.disabled) {
    return (playersById[picker.value] || {}).gender || null;
  }
  const newRow = form.querySelector(".roster-new-row [name='gender']");
  if (newRow && !newRow.disabled && newRow.value) return newRow.value;
  return null;
}
document.addEventListener("focusin", (e) => {
  const t = e.target;
  if (!t) return;
  // Legacy input+datalist control (still used by a couple of free-text fields)
  if (t.tagName === "INPUT") {
    const list = t.getAttribute("list");
    if (list === "divisions-list" || list === "events-list") {
      refreshDivisionLists(_inferFormGender(t.closest("form")));
    }
    return;
  }
  // Modern dropdown control — `<select data-catalog="division|event">`.
  if (t.tagName === "SELECT" && t.hasAttribute("data-catalog")) {
    refreshDivisionLists(_inferFormGender(t.closest("form")));
  }
});

// When the player changes (or the inline-create gender select changes), the
// inferred gender changes — refresh the division/event lists in that form so
// boys see only boys' divisions + mixed, girls see only girls' divisions + mixed.
document.addEventListener("change", (e) => {
  const t = e.target;
  if (!t || !t.form) return;
  const name = t.getAttribute("name");
  if (name === "player_ref" || name === "player_id" || name === "gender") {
    refreshDivisionLists(_inferFormGender(t.form));
  }
});

// Colored status chip for known tokens (selection status, email status, etc.).
const BADGE = {
  selected: "ok", alternate: "warn", withdrawn: "bad",
  new: "warn", filed: "ok", needs_followup: "warn",
  pending: "warn", paired: "ok",
  mutual: "info", random: "muted",
  same_club: "info", siblings: "info",
};
function chip(v) {
  if (v == null || v === "") return "";
  return `<span class="badge badge-${BADGE[v] || "muted"}">${esc(v)}</span>`;
}

// Open the modal overlay wrapping a workspace add-form (used when filing/editing).
function openForm(form) {
  if (form && typeof form._openModal === "function") {
    // file-from-email sets source_email_id before openForm() — remember the
    // filing flow so the modal can route back to the Inbox after close/submit.
    form._wasFiling = !!(form.source_email_id && form.source_email_id.value);
    form._openModal();
    return;
  }
  scheduleComboSync();
}
// Lightweight dropdown-menu button — collapses a cluster of related toolbar
// actions into one trigger (design-crit R-1/I-8). `items` is an array of
// { label, onClick, title } objects (or { separator: true }). Returns the
// wrapper element ready to drop into a toolbar.
function makeMenuButton(triggerHtml, items, opts = {}) {
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
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    // right-align the popup to the trigger so it never runs off-screen on the
    // right edge where action cells live.
    pop.style.left = "auto";
    pop.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  }
  function open() {
    if (anchored) { document.body.appendChild(pop); position(); }
    pop.hidden = false; btn.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDoc, true);
    document.addEventListener("keydown", onKey);
    if (anchored) {
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    }
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
  function onKey(e) { if (e.key === "Escape") { close(); btn.focus(); } }
  btn.addEventListener("click", (e) => { e.stopPropagation(); pop.hidden ? open() : close(); });
  wrap.append(btn, pop);
  return wrap;
}

// Audit M27: many sites called scheduleComboSync() ad-hoc; this
// coalesces concurrent requests into a single rAF so combo-display refresh
// runs at most once per frame regardless of how many fillSelect calls fired.
let _comboScheduled = false;
function scheduleComboSync() {
  if (_comboScheduled || typeof syncCombos !== "function") return;
  _comboScheduled = true;
  requestAnimationFrame(() => { _comboScheduled = false; syncCombos(); });
}
// esc() now imported from ./app/util.js (audit A47).
function formObj(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    // Multi-select serializes as a comma-joined string (matches the existing
    // backend contract for `events` + `willing_divisions` — both stored as
    // free-text comma-separated strings in TournamentEntry / DivisionFlex).
    if (el.tagName === "SELECT" && el.multiple) {
      const vals = [...el.selectedOptions].map((o) => o.value).filter(Boolean);
      o[el.name] = vals.length ? vals.join(", ") : null;
    } else {
      o[el.name] = el.value === "" ? null : el.value;
    }
  }
  return o;
}
// Register a submit handler that preventDefaults and disables the submit button
// while the async handler runs (guards against double-submit), re-enabling after.
function onSubmit(form, handler) {
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
function fillSelect(el, items, labelFn, none = true) {
  if (!el) return;
  const cur = el.value;
  // Audit M26: build options inside a DocumentFragment so the enhanceSelect
  // MutationObserver fires once per fill instead of once per option.
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

// =================== Type-in dropdowns (searchable comboboxes) ===================
// Progressively enhance every native <select> into a filterable, type-to-search
// dropdown. The native <select> stays in the DOM as the form's source of truth
// (value/required/submit/listeners all unchanged) — we just overlay a text input.
function enhanceSelect(sel) {
  if (!sel || sel.dataset.combo) return;
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
  wrap.append(input, list);
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
  function open() { if (sel.disabled) return; render(""); hi = shown.findIndex((o) => o.value === sel.value); paintHi(); list.hidden = false; input.setAttribute("aria-expanded", "true"); }
  // commit=true: if the text was cleared, clear the selection (for optional fields
  // that have a blank "" option). Otherwise just restore the displayed value.
  function close(commit) {
    list.hidden = true; hi = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (commit && input.value.trim() === "" && sel.value !== "" && [...sel.options].some((o) => o.value === "")) {
      sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    syncDisplay();
  }
  function choose(o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); syncDisplay(); close(false); }

  // Select existing text on focus so the first keystroke overtypes a prior choice.
  input.addEventListener("focus", () => { open(); input.select(); });
  input.addEventListener("click", open);
  input.addEventListener("input", () => { hi = -1; render(input.value); list.hidden = false; input.setAttribute("aria-expanded", "true"); input.removeAttribute("aria-activedescendant"); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) return open(); hi = Math.min(shown.length - 1, hi + 1); paintHi(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); hi = Math.max(0, hi - 1); paintHi(); }
    else if (e.key === "Enter") { if (!list.hidden && shown[hi]) { e.preventDefault(); choose(shown[hi]); } else { e.preventDefault(); close(true); } }
    else if (e.key === "Escape") { if (!list.hidden) { e.preventDefault(); close(false); } }
  });
  document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) close(true); });

  // Keep the visible text in sync when options/value/disabled change in code.
  new MutationObserver(() => requestAnimationFrame(syncDisplay))
    .observe(sel, { childList: true, attributes: true, attributeFilter: ["disabled"] });
  sel.addEventListener("change", syncDisplay);
  sel._comboSync = syncDisplay;
  syncDisplay();
}
function enhanceAllSelects() { document.querySelectorAll("select").forEach(enhanceSelect); }
function syncCombos() { document.querySelectorAll("select[data-combo]").forEach((s) => s._comboSync && s._comboSync()); }
// form.reset() doesn't fire change — resync combos after any reset.
document.addEventListener("reset", () => scheduleComboSync(), true);

// ---- caches + labels ----
const sitesById = {}, tournamentsById = {}, officialsById = {}, playersById = {}, hotelsById = {};
const officialLabel = (o) => `${o.last_name}, ${o.first_name}`;
const siteLabel = (s) => (s.code ? s.code + " — " : "") + s.name;
const playerLabel = (p) => `${[p.last_name, p.first_name].filter(Boolean).join(", ") || "?"} (${p.usta_number})`;

// Certifications (value -> label). Audit F23: seeded as a fallback but
// overwritten from `/api/enums` at adminInit() time so the backend stays
// the single source of truth even for display strings.
let CERTS = [
  ["roving_official", "Roving official"],
  ["chair_umpire", "Chair umpire"],
  ["tournament_referee", "Tournament referee"],
  ["deputy_referee", "Deputy referee"],
  ["referee_in_training", "Referee in training"],
];
let CERT_LABEL = Object.fromEntries(CERTS);
const certLabel = (v) => CERT_LABEL[v] || v;
// fmtDOW / _fmtIsoUTC / _isoToUTCDate now imported from ./app/util.js (A47).

// Setup CRUDs each call refreshAllSelects from their onLoad — on first paint
// that fires 5+ times in the same animation frame. Coalesce via rAF.
let _refreshAllSelectsScheduled = false;
function refreshAllSelects() {
  if (_refreshAllSelectsScheduled) return;
  _refreshAllSelectsScheduled = true;
  requestAnimationFrame(() => { _refreshAllSelectsScheduled = false; _refreshAllSelectsImpl(); });
}
function _refreshAllSelectsImpl() {
  fillSelect(document.getElementById("dist-official"), Object.values(officialsById), officialLabel, false);
  fillSelect(document.getElementById("dist-site"), Object.values(sitesById), siteLabel, false);
  fillSelect(document.getElementById("roster-player"), Object.values(playersById), playerLabel, false);
  fillSelect(document.getElementById("asg-official"), Object.values(officialsById), officialLabel, false);
  // asg-site is filled per-tournament in loadAssignments() (mileage site must be
  // one of THIS tournament's sites), so it is intentionally not filled here.
  fillSelect(document.getElementById("trb-hotel"), Object.values(hotelsById), (h) => h.name, false);
  fillPlayerRefs();
  // Suggest known hotel names on the player-hotel input (free text still allowed).
  const dl = document.getElementById("known-hotels");
  if (dl) dl.innerHTML = Object.values(hotelsById)
    .map((h) => `<option value="${esc(h.name)}"></option>`).join("");
}

// Part B forms reference the existing Players list instead of free-typing a
// player. Fill any `select.player-ref` and resolve the choice back to the
// player's identity fields on submit (backend upserts by USTA #, unchanged).
function fillPlayerRef(sel) {
  if (!sel) return;
  const cur = sel.value;
  const blank = sel.name === "partner_ref" ? "— none —" : "— select player —";
  sel.innerHTML = `<option value="">${blank}</option>`;
  for (const p of Object.values(playersById)) {
    const o = document.createElement("option");
    o.value = p.id; o.textContent = playerLabel(p);
    sel.appendChild(o);
  }
  sel.value = cur;
}
function fillPlayerRefs() { document.querySelectorAll("select.player-ref").forEach(fillPlayerRef); }
// Expand a chosen player id (field) into usta_number/first_name/last_name on `b`.
function expandPlayerRef(b, field = "player_ref") {
  const id = b[field];
  delete b[field];
  if (!id) return b;
  const p = playersById[id];
  if (!p) {
    // Audit M21 + N10: stale cache. Kick off a refresh so the next attempt
    // succeeds; surface the error to the user immediately rather than
    // submitting a half-formed body.
    if (typeof playersCrud !== "undefined" && playersCrud.refresh) {
      playersCrud.refresh().catch(() => {});
    }
    throw new Error("selected player isn't loaded — refreshing the player list, try again in a moment");
  }
  b.usta_number = p.usta_number;
  b.first_name = p.first_name || null;
  b.last_name = p.last_name || null;
  return b;
}

// a11y #9: walk Tabulator header-filter inputs and tag them with a
// per-column aria-label so screen readers say "Filter Name" instead of
// the bare "search edit text". Runs on every tableBuilt + dataFiltered.
function _labelHeaderFilters(table) {
  if (!table || !table.element) return;
  table.element.querySelectorAll(".tabulator-col").forEach((col) => {
    const title = col.querySelector(".tabulator-col-title")?.textContent?.trim();
    const filter = col.querySelector(".tabulator-header-filter input, .tabulator-header-filter select");
    if (title && filter && !filter.hasAttribute("aria-label")) {
      filter.setAttribute("aria-label", `Filter ${title}`);
    }
  });
}
// a11y 4th-pass #4: reflect Tabulator's current sort direction into aria-sort
// so SR users hear "ascending" / "descending" on the column they're inspecting.
// Tabulator already sets `aria-sort` on sortable columns to "none" by default;
// we update it post-sort.
function _reflectAriaSort(table) {
  if (!table || !table.element) return;
  const sorters = (typeof table.getSorters === "function") ? table.getSorters() : [];
  const active = new Map(sorters.map((s) => [s.field, s.dir]));
  table.element.querySelectorAll(".tabulator-col[tabulator-field]").forEach((col) => {
    const field = col.getAttribute("tabulator-field");
    if (!field) return;
    const dir = active.get(field);
    col.setAttribute("aria-sort", dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none");
  });
}

// ---- tabs ----
// ARIA: expose the menu as a tablist and make tabs keyboard-navigable.
const _menuEl = document.getElementById("menu");
_menuEl.setAttribute("role", "tablist");
document.querySelectorAll(".tab").forEach((t) => {
  t.setAttribute("role", "tab");
  t.setAttribute("aria-selected", t.classList.contains("active") ? "true" : "false");
});

// ---- two-level menu: level 1 = section group, level 2 = that group's tabs ----
// Only one group's tabs are visible at a time (no more all-at-once toolbar).
const _groupsEl = document.getElementById("menu-groups");
const _groups = [...document.querySelectorAll(".menu-group")];
function _markGroup(key) {
  _groups.forEach((g) => g.classList.toggle("group-active", g.dataset.group === key));
  [..._groupsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.group === key));
}
function activateGroup(key) {
  _markGroup(key);
  const grp = _groups.find((g) => g.dataset.group === key);
  if (grp && !grp.querySelector(".tab.active")) {
    const first = [...grp.querySelectorAll(".tab")].find((t) => !t.classList.contains("disabled"));
    if (first) first.click();
  }
  sizeLists();
}
_groups.forEach((g) => {
  const b = document.createElement("button");
  b.type = "button"; b.className = "gbtn";
  b.dataset.group = g.dataset.group;
  // Inline SVG icon from the sprite — one per group. Stroke uses
  // currentColor so the icon follows the button's text color (white on the
  // green nav bar; the active state inherits it the same way).
  const iconNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(iconNs, "svg");
  svg.setAttribute("class", "gicon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS(iconNs, "use");
  use.setAttribute("href", `#i-${g.dataset.group}`);
  svg.appendChild(use);
  const labelText = g.querySelector(".menu-label").textContent;
  const label = document.createElement("span");
  label.textContent = labelText;
  b.append(svg, label);
  // aria-label keeps the button identifiable when the label is visually
  // hidden under the icon-only narrow-viewport CSS rule.
  b.setAttribute("aria-label", labelText);
  if (g.classList.contains("group-active")) b.classList.add("active");
  b.addEventListener("click", () => activateGroup(g.dataset.group));
  _groupsEl.appendChild(b);
});
_menuEl.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const tabs = [...document.querySelectorAll(".tab")];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  next.focus();
});
// Design-crit pass 7 #1: wire ARIA tab semantics on the main nav at init.
// Each .menu-group is a tablist; each .tab is a tab pointing at its .panel
// via aria-controls; each .panel is a tabpanel. This lets a screen reader
// announce "tab 1 of 11, Tournaments" instead of "button, Tournaments".
document.querySelectorAll(".menu-group").forEach((g) => {
  const label = g.querySelector(".menu-label");
  g.setAttribute("role", "tablist");
  if (label) g.setAttribute("aria-label", label.textContent.trim());
});
document.querySelectorAll(".tab").forEach((t) => {
  const panelId = t.dataset.target;
  if (!panelId) return;
  if (!t.id) t.id = "tab-" + panelId;
  t.setAttribute("role", "tab");
  t.setAttribute("aria-controls", panelId);
  t.setAttribute("aria-selected", t.classList.contains("active") ? "true" : "false");
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", t.id);
    if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
    // a11y #11: give each panel a sr-only <h2> so the document outline
    // doesn't skip from h1 → h3. Uses the tab's label as the heading text.
    if (!panel.querySelector("h2.sr-only")) {
      const h2 = document.createElement("h2");
      h2.className = "sr-only";
      h2.textContent = t.textContent.trim();
      panel.prepend(h2);
    }
  }
});

_menuEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  closeOpenDetail();  // never leave an edit overlay/backdrop hanging across tabs
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t === tab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  const grpEl = tab.closest(".menu-group");
  if (grpEl) _markGroup(grpEl.dataset.group);  // keep level-1 in sync (e.g. file-from-email jumps)
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === tab.dataset.target));
  // Refresh tournament-scoped panels on open so they always reflect current
  // data. Built once and shared with updateActiveUI (audit M14).
  if (!Object.keys(_tournamentLoaders).length) _populateTournamentLoaders();
  if (active && _tournamentLoaders[tab.dataset.target]) _tournamentLoaders[tab.dataset.target]();
  if (tab.dataset.target === "panel-tshirts") loadTshirts();  // Setup tab (no active needed)
  if (tab.dataset.target === "panel-import") buildImportPage();
  // Tabulator can't lay out columns while hidden — redraw the grid(s) when shown.
  _redrawPanelGrids(tab.dataset.target);
  sizeLists();
  // a11y #8: focus the newly-active panel so screen readers re-announce the
  // tabpanel context after a tab switch. preventScroll keeps the layout still.
  // Only fire on real user clicks (not programmatic .click()) so the focus
  // doesn't jump while routine setup code activates a default tab.
  if (e.isTrusted) {
    const panel = document.getElementById(tab.dataset.target);
    if (panel) { try { panel.focus({ preventScroll: true }); } catch (_) {} }
  }
  // Track navigation in the breadcrumb history so the TD can step back
  // through their visited tab chain. Only record real user clicks — programmatic
  // .click() during init shouldn't pollute the trail.
  if (e.isTrusted) {
    const grpEl2 = tab.closest(".menu-group");
    _pushCrumb(grpEl2 ? grpEl2.dataset.group : null, tab.dataset.target);
  }
});

// =================== Breadcrumb / navigation history ===================
// Tracks the last N (group, panel) locations the user visited. Renders a
// strip of clickable chips below the nav. Clicking a chip jumps back to
// that location and truncates the trail to that point (classic browser-back
// semantics, but explicit). Alt+Left also pops one step.
const CRUMB_MAX = 8;
const _crumbsBar = document.getElementById("breadcrumbs");
const _crumbList = document.getElementById("crumb-list");
const _crumbBack = document.getElementById("crumb-back");
const _crumbClear = document.getElementById("crumb-clear");
let _navHistory = [];
let _crumbJumping = false;  // suppress re-recording while we programmatically jump

function _crumbLabelFor(group, panel) {
  const groupEl = document.querySelector(`.menu-group[data-group="${group}"]`);
  const rawGroup = groupEl ? groupEl.querySelector(".menu-label").textContent.trim() : group;
  // Title-case the group key fallback so "setup" → "Setup" if the .menu-label
  // node isn't reachable for any reason.
  const groupLabel = rawGroup ? rawGroup.charAt(0).toUpperCase() + rawGroup.slice(1) : group;
  const tabEl = document.querySelector(`.tab[data-target="${panel}"]`);
  const tabLabel = tabEl ? tabEl.textContent.trim() : panel;
  return { groupLabel, tabLabel };
}
function _pushCrumb(group, panel) {
  if (_crumbJumping) return;
  if (!group || !panel) return;
  // Collapse consecutive duplicates.
  const last = _navHistory[_navHistory.length - 1];
  if (last && last.group === group && last.panel === panel) return;
  _navHistory.push({ group, panel });
  if (_navHistory.length > CRUMB_MAX) _navHistory = _navHistory.slice(-CRUMB_MAX);
  _renderCrumbs();
}
function _jumpToCrumb(idx) {
  const target = _navHistory[idx];
  if (!target) return;
  // Truncate trail to and including the clicked entry — the user is "back" there.
  _navHistory = _navHistory.slice(0, idx + 1);
  _crumbJumping = true;
  try {
    // Activate the group, then click the tab. activateGroup will auto-click the
    // first tab of the group if none is active; clicking explicitly afterward
    // ensures the right panel ends up active.
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
  // G-2: cap the visible chain to the last CRUMB_VISIBLE entries so the strip
  // never wraps. When older crumbs are hidden, show a leading "…" that jumps
  // back to the oldest retained step.
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
  _crumbBack.disabled = _navHistory.length < 2;
}
if (_crumbBack) {
  _crumbBack.addEventListener("click", () => {
    if (_navHistory.length < 2) return;
    _jumpToCrumb(_navHistory.length - 2);
  });
}
if (_crumbClear) {
  _crumbClear.addEventListener("click", () => {
    // Keep the current location as the only crumb so we don't disappear
    // mid-task. If nothing recorded yet, just hide.
    const cur = _navHistory[_navHistory.length - 1];
    _navHistory = cur ? [cur] : [];
    _renderCrumbs();
  });
}
// Alt+Left as a keyboard accelerator for "back one step".
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft" && _navHistory.length >= 2) {
    e.preventDefault();
    _jumpToCrumb(_navHistory.length - 2);
  }
});
// Initial seed is done by applyAuth() when the user becomes admin — that
// avoids a race where the boot-time applyAuth(null) clears anything we'd seed
// here. See the !isAdmin branch in applyAuth above.


// Bound every scrollable list to the real space left below it so it never runs
// off the bottom of the screen, whatever the toolbar height happens to be.
function sizeLists() {
  const ls = document.querySelector(".panel.active .list-scroll");
  const top = ls ? ls.getBoundingClientRect().top : 160;
  const max = Math.max(140, window.innerHeight - top - 16);
  document.documentElement.style.setProperty("--list-max", max + "px");
}
// Tabulator computes fitColumns widths and resolves vh-based maxHeight at
// layout time; it does not always re-run on a viewport resize when the table
// lives inside a flex/tab container, so grids could keep a stale width/height
// after the window changed. Debounce a redraw of the *active* panel's grids
// (plus any visible master-detail grids) on resize so both axes track the
// viewport. 120 ms keeps drag-resize smooth without thrashing layout.
let _resizeTimer = null;
function _redrawVisibleGrids() {
  const activePanel = document.querySelector(".panel.active");
  if (activePanel && activePanel.id) _redrawPanelGrids(activePanel.id);
}
function onViewportResize() {
  sizeLists();
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(_redrawVisibleGrids, 120);
}
window.addEventListener("resize", onViewportResize);
window.addEventListener("load", sizeLists);
requestAnimationFrame(sizeLists);

// =================== Active tournament state ===================
let active = null;
let lastSelectedTournamentId = null;
const activeSelect = document.getElementById("active-tournament");

function fillActiveSelect(rows) {
  const cur = activeSelect.value;
  // Design-crit pass 7 #3: signal the first-time empty state on the
  // tournament selector itself, so a brand-new admin isn't stuck staring
  // at an empty dropdown with no clue where to start.
  if (!rows || rows.length === 0) {
    activeSelect.innerHTML = '<option value="">— no tournaments yet — create one in Setup → Tournaments —</option>';
    activeSelect.disabled = true;
    return;
  }
  activeSelect.disabled = false;
  activeSelect.innerHTML = '<option value="">— select a tournament —</option>';
  for (const t of rows) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name;
    activeSelect.appendChild(o);
  }
  activeSelect.value = cur;
}

function setActive(id) {
  const prev = active;
  active = id ? tournamentsById[id] || null : null;
  activeSelect.value = active ? String(active.id) : "";
  if (active) localStorage.setItem("activeTid", active.id);
  else localStorage.removeItem("activeTid");
  syncCombos();
  updateActiveUI();
  // Switching the active tournament mid-edit would otherwise leave a modal open
  // against a different tournament's data — close any open detail and toast.
  // Audit F21: toast on every transition (set/cleared/switched).
  const prevId = prev ? prev.id : null;
  const nextId = active ? active.id : null;
  if (prevId !== nextId) {
    closeOpenDetail();
    document.querySelectorAll(".tpanel form").forEach((f) => { try { f.reset(); } catch (_) {} });
    if (active) toast(`Switched to ${active.name}`, true);
    else if (prev) toast(`Cleared active tournament (${prev.name})`, true);
  }
}

function updateActiveUI() {
  const info = document.getElementById("active-info");
  document.getElementById("context-bar").classList.toggle("has-active", !!active);
  document.querySelectorAll(".needs-active").forEach((t) => t.classList.toggle("disabled", !active));
  document.querySelectorAll(".t-name").forEach((s) => (s.textContent = active ? active.name : ""));
  document.querySelectorAll(".tpanel").forEach((p) => {
    const note = p.querySelector(".needs-active-note");
    note.hidden = !!active;
    // Design-crit #8: turn the static warning into an actionable empty state.
    // Inject a "Pick tournament" button once that focuses the context-bar
    // select so a keyboard user reaches the picker in one tab.
    if (!note.dataset.actionWired) {
      note.dataset.actionWired = "1";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Pick tournament";
      btn.addEventListener("click", () => {
        const sel = document.getElementById("active-tournament");
        sel.focus();
        // design-crit pass 2 #7: showPicker() works in Chrome/Edge but not
        // Safari or older browsers — surface a hint so the user knows the
        // picker is now the focused element they should expand.
        if (typeof sel.showPicker === "function") {
          try { sel.showPicker(); }
          catch (_) { toast("Pick a tournament from the bar above", true); }
        } else {
          toast("Pick a tournament from the bar above", true);
        }
      });
      note.appendChild(btn);
    }
    p.querySelector(".t-content").hidden = !active;
  });
  refreshDivisionLists();  // datalists track the active tournament's type
  if (active) {
    info.textContent = `${active.type} · ${active.play_start_date} → ${active.play_end_date}`;
    // Audit M14: only refresh the currently-visible tournament tab; the rest
    // load lazily on tab activation (tab click handler has the loader map).
    // Audit N11: ensure the loader map is populated before we look anything
    // up — on initial-load setActive() runs before any tab click, so the
    // tab-click-handler's lazy init hasn't fired yet.
    if (!Object.keys(_tournamentLoaders).length) _populateTournamentLoaders();
    const activePanel = document.querySelector(".tab.active")?.dataset.target;
    if (activePanel && _tournamentLoaders[activePanel]) _tournamentLoaders[activePanel]();
  } else {
    info.textContent = "";
  }
}
// Loader map shared between the tab-switch click handler and updateActiveUI.
// Populated lazily because schedList/divflexList/photelList are `const`s
// defined later in the file (audit M14 + N11).
const _tournamentLoaders = {};
function _populateTournamentLoaders() {
  Object.assign(_tournamentLoaders, {
    "panel-t-sites": () => { loadTSites(); loadTSiteDivisions(); },
    "panel-t-roster": () => loadRoster(),
    "panel-t-assignments": () => loadAssignments(),
    "panel-t-roomblocks": () => loadRoomBlocks(),
    "panel-t-staff": () => loadStaff(),
    "panel-t-availability": () => loadAvailability(),
    "panel-t-tshirt-order": () => { loadTshirtOrder(); loadTshirtsBySite(); },
    "panel-t-inbox": () => loadInbox(),
    "panel-t-late": () => loadLate(),
    "panel-t-withdrawals": () => loadWithdrawals(),
    "panel-t-sched": () => schedList.load(),
    "panel-t-divflex": () => divflexList.load(),
    "panel-t-pairing": () => loadPairing(),
    "panel-t-doubles": () => loadDoubles(),
    "panel-t-photels": () => photelList.load(),
    "panel-t-reports": () => loadReports(),
  });
}
activeSelect.addEventListener("change", () => setActive(activeSelect.value));

// =================== generic master-detail CRUD (Setup), Tabulator grid ======
const GRIDS = {};  // panelId -> Tabulator (redrawn when its tab becomes visible)
// Audit M24: one place that redraws every Tabulator inside a panel when its
// tab becomes visible. Called from the tab-click handler + anywhere else that
// reveals a previously-hidden grid (e.g. player history sub-panel).
function _redrawPanelGrids(panelId) {
  const grids = GRIDS[panelId];
  if (!grids) return;
  requestAnimationFrame(() => grids.forEach((g) => { try { g.redraw(true); } catch (_) {} }));
}
// Audit M12: shared "deferred setData" pattern — Tabulator can't accept data
// until `tableBuilt` fires; without this helper every grid factory carried
// its own `built / pending` pair. Returns a function callers use in place of
// table.setData() directly.
function deferredSetData(table) {
  const state = { built: false, pending: null };
  const onBuilt = () => {
    state.built = true;
    if (state.pending !== null) { table.setData(state.pending); state.pending = null; }
    _labelHeaderFilters(table);   // a11y #9
  };
  table.on("tableBuilt", onBuilt);
  // Cover the case where Tabulator fires tableBuilt synchronously inside its
  // constructor — our listener is registered AFTER `new Tabulator()` returns,
  // so the sync-fire is missed and pending never flushes. Check the flag.
  if (table.initialized) onBuilt();
  const fn = (rows) => { if (state.built) table.setData(rows); else state.pending = rows; };
  fn._state = state;  // makeListGrid uses .built directly to gate filter installs
  return fn;
}
// Audit A48: an IntersectionObserver also catches *any* panel that becomes
// visible (history sub-panels, modals revealing a grid, etc.) without each
// caller having to wire up its own redraw. The Tabulator grids inside that
// panel can't lay out columns while their container is `display:none`.
const _panelObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting && e.target.id) _redrawPanelGrids(e.target.id);
  }
}, { threshold: 0 });
function _observePanel(el) { if (el) _panelObserver.observe(el); }
// Walk the DOM after init wires panels.
requestAnimationFrame(() => {
  document.querySelectorAll(".panel").forEach(_observePanel);
});
// Player column: "Last, First" (sorts by last name). Used by the player-keyed grids.
const _playerCell = (cell) => {
  const d = cell.getData();
  return esc([d.last_name, d.first_name].filter(Boolean).join(", "));
};
// Shared backdrop for the master/detail edit overlay (one open at a time).
const _detailBackdrop = document.createElement("div");
_detailBackdrop.className = "detail-backdrop";
document.body.appendChild(_detailBackdrop);
let _closeOpenDetail = null;
function closeOpenDetail() { if (_closeOpenDetail) _closeOpenDetail(); }
_detailBackdrop.addEventListener("click", closeOpenDetail);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Let Tabulator cell editors swallow Escape themselves; otherwise the user
  // canceling a cell edit accidentally closes the surrounding modal (C8).
  if (document.querySelector(".tabulator-editing")) return;
  closeOpenDetail();
});

function wireEntity(cfg) {
  const panel = document.getElementById(cfg.panelId);
  const form = document.getElementById(cfg.formId);
  const filterInput = panel.querySelector(".filter");
  const newBtn = panel.querySelector(".new-btn");
  // Add a ⬇ CSV button next to + New so Setup lists match the workspace lists
  // (Tabulator's native download writes a clean CSV from the current data).
  const csvBtn = document.createElement("button");
  csvBtn.type = "button"; csvBtn.className = "export-btn no-print"; csvBtn.textContent = "⬇ CSV";
  csvBtn.title = "Download as CSV";
  newBtn.parentNode.insertBefore(csvBtn, newBtn.nextSibling);
  const title = panel.querySelector(".detail-title");
  const detailPane = panel.querySelector(".detail-pane");
  const submitBtn = form.querySelector('button[type="submit"]');
  const deleteBtn = form.querySelector(".delete");
  const cancelBtn = form.querySelector(".cancel");
  // (label is set in index.html now — audit P35.)
  let items = [];
  let selectedId = null;
  let built = false, pending = null;

  // prev/next record navigation (steps through the grid's active = filtered+sorted rows)
  const nav = document.createElement("div");
  nav.className = "detail-nav";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button"; prevBtn.className = "nav-btn"; prevBtn.textContent = "‹ Prev"; prevBtn.title = "Previous record";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button"; nextBtn.className = "nav-btn"; nextBtn.textContent = "Next ›"; nextBtn.title = "Next record";
  const navPos = document.createElement("span");
  navPos.className = "nav-pos";
  nav.append(prevBtn, navPos, nextBtn);
  detailPane.insertBefore(nav, detailPane.firstChild);

  // The detail form is a modal overlay (the grid owns the full page width).
  const closeBtn = document.createElement("button");
  closeBtn.type = "button"; closeBtn.className = "detail-close"; closeBtn.textContent = "×"; closeBtn.title = "Close";
  detailPane.insertBefore(closeBtn, detailPane.firstChild);
  function openModal() { detailPane.classList.add("detail-open"); _detailBackdrop.classList.add("show"); _closeOpenDetail = closeModal; }
  function closeModal() { detailPane.classList.remove("detail-open"); _detailBackdrop.classList.remove("show"); _closeOpenDetail = null; }
  closeBtn.addEventListener("click", closeModal);

  // Build the grid into the old .list-scroll container (reuse the thead titles).
  const tableEl = panel.querySelector(".list-table");
  const titles = [...tableEl.querySelectorAll("thead th")].map((t) => t.textContent.trim());
  const mount = tableEl.closest(".list-scroll") || tableEl.parentElement;
  mount.classList.remove("list-scroll"); mount.innerHTML = ""; mount.classList.add("grid-mount");

  // Columns may opt into in-grid editing via `c.edit` (double-click a cell).
  // Only columns whose `key` maps 1:1 to a writable DB field should set it;
  // composite/computed columns (fmt over several fields) stay form-only.
  const columns = cfg.columns.map((c, i) => {
    const col = {
      title: titles[i] || c.key, field: c.key,
      formatter: c.fmt ? (cell) => esc(c.fmt(cell.getData())) : undefined,
    };
    if (c.hozAlign) col.hozAlign = c.hozAlign;
    if (c.width) col.width = c.width;
    // Narrow, non-growing ID column so fitColumns distributes the extra width
    // to the *meaningful* (name / city / …) columns.
    if (c.key === "id") { col.width = 64; col.widthGrow = 0; }
    if (c.edit) {
      col.editor = c.edit.editor;
      if (c.edit.params) col.editorParams = c.edit.params;
      col.cssClass = "editable-cell";
    }
    // Per-column header filter on the meaningful columns (skip the id column).
    // List-editable columns reuse their value set as a dropdown filter; computed
    // (fmt) columns filter against the rendered text.
    if (c.key !== "id") {
      if (c.edit && c.edit.editor === "list") {
        col.headerFilter = "list";
        col.headerFilterParams = { values: c.edit.params.values, clearable: true };
        // List filter: exact match on the raw field value (not substring on the
        // formatted label) — otherwise "female" matches a "male" filter, etc.
        col.headerFilterFunc = (term, _v, data) => String(data[c.key] ?? "") === String(term);
      } else {
        col.headerFilter = "input";
        if (c.fmt) col.headerFilterFunc = (term, _v, data) => c.fmt(data).toLowerCase().includes(String(term).toLowerCase());
      }
    }
    return col;
  });
  columns.push({
    // a11y 6th-pass: column widened so two 44×44 .btn-icon buttons (+ optional
    // rowAction button) fit without clipping. The old 72 px was narrower than
    // 2× 44 px → edit button overflowed left and got clipped by the previous
    // cell's right edge.
    title: "", field: "_act", headerSort: false, widthGrow: 0, width: cfg.rowAction ? 160 : 84,
    cssClass: "grid-actions-cell",
    formatter: (cell) => {
      const item = cell.getData();
      const wrap = document.createElement("div"); wrap.className = "grid-actions";
      if (cfg.rowAction) { const ex = cfg.rowAction(item); if (ex) wrap.append(ex); }
      const e = document.createElement("button"); e.type = "button"; e.className = "btn-icon"; e.textContent = "✎";
      e.title = "Edit " + cfg.singular; e.setAttribute("aria-label", e.title);
      e.addEventListener("click", (ev) => { ev.stopPropagation(); select(item); openModal(); });
      const d = document.createElement("button"); d.type = "button"; d.className = "btn-icon danger"; d.textContent = "✕";
      d.title = "Delete " + cfg.singular; d.setAttribute("aria-label", d.title);
      d.addEventListener("click", (ev) => { ev.stopPropagation(); removeItem(item.id); });
      wrap.append(e, d); return wrap;
    },
  });

  const table = new Tabulator(mount, {
    index: "id", layout: "fitColumns", maxHeight: "calc(100vh - 16rem)",
    placeholder: `No ${cfg.singular}s yet — use the form to add one.`,
    columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 },
    editTriggerEvent: "click",  // single click opens the cell editor (discoverable in-place edit)
    renderVertical: "basic",  // small lists; avoids the virtual-render resize loop
    columns,
  });
  (GRIDS[cfg.panelId] ||= []).push(table);
  // Setup CSV exports include every importable column (not just what's visible
  // in the grid), so a round-trip via spreadsheet / re-import keeps all fields.
  csvBtn.addEventListener("click", () => {
    const filename = cfg.path.replace(/^\//, "") + ".csv";
    if (cfg.exportCols && cfg.exportCols.length) {
      const headers = cfg.exportCols.map((c) => c.header);
      const rows = table.getData("active").map((r) =>
        cfg.exportCols.map((c) => (c.fmt ? c.fmt(r) : r[c.key])));
      _csvDownload([headers, ...rows], cfg.path.replace(/^\//, ""));
    } else {
      table.download("csv", filename);
    }
  });
  // Tabulator can fire tableBuilt synchronously (small grids, hidden mount,
  // some timing windows) — in which case the listener below registers AFTER
  // the event and never sees it. Cover the sync case with an explicit check
  // on `table.initialized`. (Critical regression discovered in preview.)
  const onBuilt = () => { built = true; if (pending) { table.setData(pending); pending = null; } applySelection(); };
  table.on("tableBuilt", onBuilt);
  if (table.initialized) onBuilt();
  // Single click only highlights the row (keeps double-click free for in-grid
  // editing); use the Edit button to open the form overlay.
  table.on("rowClick", (e, row) => { selectedId = row.getData().id; applySelection(); });
  table.on("dataFiltered", () => { markRows(); updateNav(); });
  table.on("dataSorted", () => { markRows(); updateNav(); _reflectAriaSort(table); });
  // In-grid edit: PUT the whole row (the *Out record has every field the model
  // needs; Pydantic ignores extras). Refresh to pick up server normalization.
  table.on("cellEdited", async (cell) => {
    const data = cell.getRow().getData();
    if (cell.getValue() === cell.getOldValue()) return;  // no-op
    try {
      let body = { ...data }; delete body._act;
      if (cfg.transform) body = cfg.transform(body);
      // Audit M19 + M8: send the snapshot's updated_at only when the entity
      // opts in (cfg.optimisticConcurrency); avoids implicit feature-detection
      // on payload shape if some future *Out model adds an unrelated updated_at.
      const headers = cfg.optimisticConcurrency && data.updated_at
        ? { "X-If-Updated-At": data.updated_at } : {};
      await api(`${cfg.path}/${data.id}`, { method: "PUT", body: JSON.stringify(body), headers });
      setMsg(cfg.msgId, "saved", true);
      await refresh();
      if (cfg.afterChange) cfg.afterChange();
      if (selectedId === data.id) fillForm(table.getRow(data.id)?.getData() || data);
    } catch (err) {
      setMsg(cfg.msgId, err.message, false);
      try { cell.restoreOldValue(); } catch (_) {}
      await refresh();
    }
  });

  function activeData() { return built ? table.getRows("active").map((r) => r.getData()) : items; }
  function updateNav() {
    const shown = activeData();
    const idx = shown.findIndex((it) => it.id === selectedId);
    const have = selectedId != null && idx >= 0;
    navPos.textContent = shown.length ? `${have ? idx + 1 : "–"} / ${shown.length}` : "";
    prevBtn.disabled = !have || idx <= 0;
    nextBtn.disabled = !have || idx >= shown.length - 1;
  }
  function navTo(delta) {
    const shown = activeData();
    const idx = shown.findIndex((it) => it.id === selectedId);
    if (idx < 0 || !shown[idx + delta]) return;
    select(shown[idx + delta]);
    if (built) try { table.scrollToRow(selectedId, "nearest", false); } catch (_) {}
  }
  prevBtn.addEventListener("click", () => navTo(-1));
  nextBtn.addEventListener("click", () => navTo(1));

  function markRows() {  // highlight the selected row
    if (!built) return;
    for (const r of table.getRows()) r.getElement().classList.toggle("row-selected", r.getData().id === selectedId);
  }
  function applySelection() { markRows(); updateNav(); }

  function matchesFilter(data) {
    const q = filterInput.value.trim().toLowerCase();
    if (!q) return true;
    // Only match the values the user can actually *see* in the grid; otherwise
    // typing a number matches arbitrary internal ids (audit C6).
    const visible = cfg.columns
      .filter((c) => c.key !== "id")
      .map((c) => (c.fmt ? c.fmt(data) : data[c.key]))
      .filter((v) => v !== null && v !== undefined)
      .join(" ")
      .toLowerCase();
    return visible.includes(q);
  }

  function fillForm(item) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = item ? item[el.name] : null;
      // Multi-select: split the stored comma-string back into selected options.
      if (el.tagName === "SELECT" && el.multiple) {
        const wanted = new Set(String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
        [...el.options].forEach((o) => { o.selected = wanted.has(o.value); });
        continue;
      }
      el.value = v === null || v === undefined ? "" : v;
    }
    scheduleComboSync();  // refresh type-in dropdown displays
  }
  function showNew() {
    selectedId = null; fillForm(null);
    title.textContent = "New " + cfg.singular[0].toUpperCase() + cfg.singular.slice(1);
    submitBtn.textContent = "Create";
    deleteBtn.hidden = true;
    applySelection();
    if (cfg.onNew) cfg.onNew();
  }
  function select(item) {
    selectedId = item.id; fillForm(item);
    title.textContent = `${cfg.singular[0].toUpperCase() + cfg.singular.slice(1)} #${item.id}`;
    submitBtn.textContent = "Save";
    deleteBtn.hidden = false;
    applySelection();
    if (cfg.onSelect) cfg.onSelect(item);
  }
  async function removeItem(id) {
    if (!(await confirmDialog(`Delete ${cfg.singular} #${id}?`))) return;
    try {
      await api(`${cfg.path}/${id}`, { method: "DELETE" });
      setMsg(cfg.msgId, "deleted", true);
      if (selectedId === id) showNew();
      closeModal();
      await refresh();
      if (cfg.afterChange) cfg.afterChange();
    } catch (err) { setMsg(cfg.msgId, err.message, false); }
  }
  async function refresh() {
    // Note: Tabulator 6.3.1 doesn't expose `setPlaceholder` at runtime. The
    // empty-state text is set once at construction via the `placeholder`
    // option (above). An earlier audit (P36) tried to swap to "Loading…"
    // here and back — it threw and the surrounding try/catch in adminInit
    // swallowed the error, leaving every Setup grid blank. Reverted: just
    // call setData.
    items = await api(cfg.path);
    if (cfg.onLoad) cfg.onLoad(items);
    if (built) await table.setData(items);
    else pending = items;
    applySelection();
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      let body = formObj(form);
      if (cfg.transform) body = cfg.transform(body);
      const editing = selectedId != null;
      // Audit M19 + M8: include `X-If-Updated-At` only when the entity
      // opts in. items.find() returns the row-as-of-modal-open, which is
      // exactly the snapshot we want to detect "another tab wrote first".
      const orig = editing && cfg.optimisticConcurrency
        ? items.find((it) => it.id === selectedId) : null;
      const headers = orig && orig.updated_at ? { "X-If-Updated-At": orig.updated_at } : {};
      const saved = await api(editing ? `${cfg.path}/${selectedId}` : cfg.path,
        { method: editing ? "PUT" : "POST", body: JSON.stringify(body), headers });
      if (saved && saved.id != null) selectedId = saved.id;
      setMsg(cfg.msgId, editing ? "saved" : "created", true);
      await refresh();
      if (cfg.afterChange) cfg.afterChange();
      if (saved && saved.id != null) select(saved);
      closeModal();
    } catch (err) { setMsg(cfg.msgId, err.message, false); markInvalid(form, err.message); }
    finally { submitBtn.disabled = false; }
  });
  deleteBtn.addEventListener("click", () => { if (selectedId != null) removeItem(selectedId); });
  newBtn.addEventListener("click", () => { showNew(); openModal(); });
  cancelBtn.addEventListener("click", closeModal);
  // Audit M32: debounce typing so we don't run setFilter on every keystroke.
  let _filterTimer = 0;
  filterInput.addEventListener("input", () => {
    clearTimeout(_filterTimer);
    _filterTimer = setTimeout(() => { if (built) table.setFilter(matchesFilter); }, 120);
  });
  showNew();
  return { refresh };
}

async function refreshHealth() {
  const pill = document.getElementById("health");
  try {
    const h = await api("/health");
    const ok = h.db === "ok";
    pill.textContent = ok ? "API + DB ok" : "DB " + h.db;
    pill.className = "pill " + (ok ? "ok" : "bad");
  } catch (e) { pill.textContent = "API down"; pill.className = "pill bad"; }
}

// =================== Tournament workspace ===================

// --- Sites: filterable grid with membership toggles ---
let tSitesSelected = new Set();
async function loadTSites() {
  if (!active) return;
  tSitesSelected = new Set((await api(`/tournaments/${active.id}/sites`)).map((s) => s.id));
  renderTSites();
}
// Membership grid: the "Add / ✓ In" toggle lives in an action column; members
// get the row-selected highlight via a rowFormatter (re-runs on every redraw).
const tSitesGrid = makeReadGrid("t-sites-table", [
  { title: "", field: "_toggle", headerSort: false, width: 90, cssClass: "grid-actions-cell",
    formatter: (cell) => {
      const s = cell.getData(); const inSet = tSitesSelected.has(s.id);
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn-link" + (inSet ? "" : " add"); b.textContent = inSet ? "✓ In" : "Add";
      b.addEventListener("click", (ev) => { ev.stopPropagation(); toggleSite(s.id); });
      return b;
    } },
  { title: "Code", field: "code" },
  { title: "Name", field: "name" },
  { title: "City", field: "city" },
// Import/export #6: "t-sites" gets its own CSV export so a TD can hand the
// venue list to ops; rows reflect every site, with an `assigned` flag for
// whether it's currently part of the active tournament.
], "tournament-sites", "No sites match.", {
  index: "id",
  rowFormatter: (row) => row.getElement().classList.toggle("row-selected", tSitesSelected.has(row.getData().id)),
});
function tSitesMatches(s) {
  const q = document.getElementById("t-sites-filter").value.trim().toLowerCase();
  return !q || siteLabel(s).toLowerCase().includes(q) || (s.city || "").toLowerCase().includes(q);
}
function renderTSites() {
  tSitesGrid.setData(Object.values(sitesById));
  tSitesGrid.setFilter(tSitesMatches);
}
async function toggleSite(id) {
  if (tSitesSelected.has(id)) tSitesSelected.delete(id); else tSitesSelected.add(id);
  try {
    await api(`/tournaments/${active.id}/sites`, { method: "PUT", body: JSON.stringify({ site_ids: [...tSitesSelected] }) });
    setMsg("t-sites-msg", "saved", true);
    renderTSites();
  } catch (e) { setMsg("t-sites-msg", e.message, false); loadTSites(); }
}
document.getElementById("t-sites-filter").addEventListener("input", () => tSitesGrid.setFilter(tSitesMatches));

// ---- B1: division → site assignment (Tournament → Sites panel) -----------
// One row per division (LEFT JOIN from the API) with a Site dropdown.
// Persists via PUT /api/tournaments/{id}/site-divisions/{division_id} —
// site_id=null clears the assignment.
async function loadTSiteDivisions() {
  if (!active) return;
  const tbody = document.querySelector("#t-site-divisions-table tbody");
  if (!tbody) return;
  // Need the linked sites first — division can only be assigned to a site
  // that's already used by this tournament.
  const [matrix, sites] = await Promise.all([
    api(`/tournaments/${active.id}/site-divisions`),
    api(`/tournaments/${active.id}/sites`),
  ]);
  tbody.innerHTML = "";
  if (!sites.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Add sites above first, then come back to assign divisions.</td></tr>`;
    return;
  }
  // Limit divisions to the active tournament's type so a junior tournament
  // doesn't list NTRP adult buckets and vice versa.
  const ttype = active.type;
  const rows = matrix.filter((d) => d.tournament_type === ttype);
  for (const d of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(d.label || d.code)}</td><td class="muted">${esc(d.tournament_type)}</td><td></td>`;
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Site for ${d.label || d.code}`);
    sel.innerHTML = `<option value="">— unassigned —</option>` +
      sites.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    sel.value = d.site_id ? String(d.site_id) : "";
    sel.addEventListener("change", async () => {
      const sid = sel.value ? Number(sel.value) : null;
      try {
        await api(`/tournaments/${active.id}/site-divisions/${d.division_id}`, {
          method: "PUT", body: JSON.stringify({ site_id: sid }),
        });
        setMsg("t-site-divisions-msg", `${d.label || d.code} → ${sid ? sites.find((s) => s.id === sid).name : "unassigned"}`, true);
      } catch (e) {
        setMsg("t-site-divisions-msg", e.message, false);
        loadTSiteDivisions();  // re-pull truth
      }
    });
    tr.lastElementChild.appendChild(sel);
    tbody.appendChild(tr);
  }
  // T-1: section count — "N sites · M/total divisions assigned".
  const cnt = document.getElementById("t-site-div-count");
  if (cnt) {
    const assigned = rows.filter((d) => d.site_id).length;
    cnt.textContent = `${sites.length} site${sites.length === 1 ? "" : "s"} · ${assigned}/${rows.length} divisions assigned`;
  }
}

// --- Roster (master/detail, like the Setup entities) ---
const rosterForm = document.getElementById("roster-form");
const rosterTitle = document.getElementById("roster-title");
const rosterSubmit = rosterForm.querySelector('button[type="submit"]');
let rosterRows = [];
let rosterEditId = null;
// Roster detail form is a modal overlay (parity with the Setup pages).
const rosterDetail = rosterForm.closest(".detail-pane");
const rosterCloseBtn = document.createElement("button");
rosterCloseBtn.type = "button"; rosterCloseBtn.className = "detail-close"; rosterCloseBtn.textContent = "×"; rosterCloseBtn.title = "Close";
rosterDetail.insertBefore(rosterCloseBtn, rosterDetail.firstChild);
function rosterOpenModal() {
  rosterDetail.classList.add("detail-open"); _detailBackdrop.classList.add("show"); _closeOpenDetail = rosterCloseModal;
  scheduleComboSync();
}
function rosterCloseModal() { rosterDetail.classList.remove("detail-open"); _detailBackdrop.classList.remove("show"); _closeOpenDetail = null; }
rosterCloseBtn.addEventListener("click", rosterCloseModal);
async function loadRoster() {
  if (!active) return;
  rosterRows = await api(`/tournaments/${active.id}/players`);  // kept for the sign-in export
  if (rosterBuilt) await rosterGrid.setData(rosterRows); else rosterPending = rosterRows;
  applyRosterSel();
  _updateRosterCounts();
}
// R-4: a one-line summary strip above the roster grid.
function _updateRosterCounts() {
  const el = document.getElementById("roster-counts");
  if (!el) return;
  const rows = rosterRows || [];
  const n = (s) => rows.filter((r) => r.selection_status === s).length;
  if (!rows.length) { el.textContent = ""; return; }
  el.textContent =
    `${rows.length} on roster · ${n("selected")} selected · ${n("alternate")} alternate · ${n("withdrawn")} withdrawn`;
}
const rosterName = (e) => [e.last_name, e.first_name].filter(Boolean).join(", ") || e.usta_number;

// Tabulator grid for the roster (master/detail like the Setup entities).
const rosterTableEl = document.getElementById("roster-table");
const rosterMount = rosterTableEl.closest(".list-scroll") || rosterTableEl.parentElement;
rosterMount.classList.remove("list-scroll"); rosterMount.innerHTML = ""; rosterMount.classList.add("grid-mount");
let rosterBuilt = false, rosterPending = null;
const rosterGrid = new Tabulator(rosterMount, {
  index: "id", layout: "fitColumns", maxHeight: "calc(100vh - 16rem)",
  placeholder: "No players on this roster yet.",
  columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 },
  editTriggerEvent: "click",  // single click opens the cell editor (discoverable in-place edit)
  renderVertical: "basic",  // small lists; avoids the virtual-render resize loop
  columns: [
    { title: "Player", field: "last_name",
      // design-crit R-1: show just the name (the USTA # was truncating the cell
      // mid-paren); the number is still searchable and shown on hover.
      formatter: (cell) => { const e = cell.getData(); const u = e.usta_number ? ` (USTA ${esc(e.usta_number)})` : "";
        return `<span title="${esc(rosterName(e))}${u}">${esc(rosterName(e))}</span>`; },
      headerFilter: "input", headerFilterFunc: (term, _v, e) => (rosterName(e) + " " + (e.usta_number || "")).toLowerCase().includes(String(term).toLowerCase()) },
    { title: "Div", field: "age_division", editor: "list", cssClass: "editable-cell",
      editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }),
      headerFilter: "input" },
    { title: "Status", field: "selection_status", cssClass: "editable-cell",
      editor: "list", editorParams: { values: ["selected", "alternate", "withdrawn"] },
      headerFilter: "list", headerFilterParams: { values: ["selected", "alternate", "withdrawn"], clearable: true },
      formatter: (cell) => chip(cell.getData().selection_status) },
    { title: "Shirt", field: "t_shirt_size", cssClass: "editable-cell",
      // Audit M28: source from the canonical list defined alongside _SHIRT_LABEL
      // so the roster grid editor and the t-shirt order page can't drift.
      editor: "list", editorParams: () => ({ values: ["", ...SHIRT_LABELS] }),
      formatter: (c) => c.getValue() ? esc(c.getValue()) : `<span class="muted">—</span>`,
      headerFilter: "input" },
    { title: "Dietary", field: "dietary_preference", editor: "input", cssClass: "editable-cell",
      formatter: (c) => c.getValue() ? esc(c.getValue()) : `<span class="muted">—</span>`,
      headerFilter: "input" },
    // B3 lodging — canonical plan from the combined import. Falls back to
    // the raw free-text answer (rendered in muted italic) when the mapper
    // couldn't categorize it. Click-to-edit lets the TD upgrade a raw answer
    // into a canonical bucket without leaving the grid.
    { title: "Lodging", field: "lodging_plan", cssClass: "editable-cell",
      editor: "list", editorParams: { values: ["", "Hotel", "Local / family", "Commuter", "Commuter 1-2 hrs", "Commuter 2+ hrs"] },
      formatter: (cell) => {
        const e = cell.getData();
        if (e.lodging_plan) return esc(e.lodging_plan);
        if (e.lodging_plan_raw) return `<span class="muted" style="font-style:italic" title="Unmapped — click to set a canonical plan">${esc(e.lodging_plan_raw)}</span>`;
        return "";
      },
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) => ((e.lodging_plan || e.lodging_plan_raw || "").toLowerCase().includes(String(term).toLowerCase())) },
    { title: "", field: "_act", headerSort: false, widthGrow: 0, width: 110, cssClass: "grid-actions-cell",
      formatter: (cell) => {
        const e = cell.getData();
        const wrap = document.createElement("div"); wrap.className = "grid-actions";
        // Edit is the primary action; Withdraw + Remove fold into a ⋯ overflow
        // menu (design-crit R-2) so the destructive verbs don't sit on every row.
        const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-icon"; ed.textContent = "✎";
        ed.title = "Edit roster entry"; ed.setAttribute("aria-label", ed.title);
        ed.addEventListener("click", (ev) => { ev.stopPropagation(); rosterSelect(e); rosterOpenModal(); });

        const withdrawn = e.selection_status === "withdrawn";
        const doWithdraw = () => {
          if (withdrawn) return;
          // Switch tab first — the tab handler refreshes some selects, which
          // would otherwise wipe our preset value. Set the player after, then
          // open the modal so syncCombos shows the chosen name in the combobox.
          document.querySelector('.tab[data-target="panel-t-withdrawals"]').click();
          const wdForm = document.getElementById("withdrawal-form");
          wdForm.player_ref.value = e.player_id;
          openForm(wdForm);
          scheduleComboSync();
        };
        const doDelete = async () => {
          if (!(await confirmDialog("Remove player from roster?"))) return;
          try { await api(`/roster/${e.id}`, { method: "DELETE" }); if (rosterEditId === e.id) { rosterShowNew(); rosterCloseModal(); } await loadRoster(); }
          catch (err) { toast(err.message, false); }
        };
        const items = [
          { label: withdrawn ? "Already withdrawn" : "Withdraw…",
            title: withdrawn ? "Player is already withdrawn" : "File a withdrawal for this player",
            onClick: doWithdraw },
          { separator: true },
          { label: "Remove from roster", danger: true, onClick: doDelete },
        ];
        const menu = makeMenuButton("⋯", items, { className: "btn-icon row-more", title: "More actions", anchor: true, noCaret: true });
        wrap.append(ed, menu); return wrap;
      } },
  ],
});
(GRIDS["panel-t-roster"] ||= []).push(rosterGrid);
rosterGrid.on("tableBuilt", () => { rosterBuilt = true; if (rosterPending) { rosterGrid.setData(rosterPending); rosterPending = null; } applyRosterSel(); _labelHeaderFilters(rosterGrid); });
// Single click only highlights (keeps double-click free for in-grid editing);
// the Edit button opens the form overlay.
rosterGrid.on("rowClick", (e, row) => { rosterEditId = row.getData().id; applyRosterSel(); });
rosterGrid.on("dataFiltered", applyRosterSel);
rosterGrid.on("dataSorted", () => { applyRosterSel(); _reflectAriaSort(rosterGrid); });
// In-grid edit: PUT the whole entry (RosterEntryOut has every field the model
// needs; the backend re-normalizes t_shirt_size). Refresh to reflect that.
rosterGrid.on("cellEdited", async (cell) => {
  if (cell.getValue() === cell.getOldValue()) return;
  const e = cell.getRow().getData();
  try {
    const body = {
      player_id: e.player_id, age_division: e.age_division || null, events: e.events || null,
      selection_status: e.selection_status, t_shirt_size: e.t_shirt_size || null,
      dietary_preference: e.dietary_preference || null,
      lodging_plan: e.lodging_plan || null,
    };
    await api(`/roster/${e.id}`, { method: "PUT", body: JSON.stringify(body) });
    setMsg("roster-msg", "saved", true);
    await loadRoster();
  } catch (err) {
    setMsg("roster-msg", err.message, false);
    try { cell.restoreOldValue(); } catch (_) {}
    await loadRoster();
  }
});
function rosterMatches(data) {
  const q = document.getElementById("roster-filter").value.trim().toLowerCase();
  if (!q) return true;
  // Match only the fields a TD can see in the grid — not internal ids
  // (audit C6: typing "1" used to match player_id:1 et al.).
  const hay = [data.first_name, data.last_name, data.usta_number,
    data.age_division, data.events, data.selection_status,
    data.t_shirt_size, data.dietary_preference]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}
function rosterActiveData() { return rosterBuilt ? rosterGrid.getRows("active").map((r) => r.getData()) : rosterRows; }
function rosterMarkRows() {
  if (!rosterBuilt) return;
  for (const r of rosterGrid.getRows()) r.getElement().classList.toggle("row-selected", r.getData().id === rosterEditId);
}
function applyRosterSel() { rosterMarkRows(); rosterUpdateNav(); }
function rosterSelect(e) {
  rosterEditId = e.id;
  rosterSetMode("pick");  // editing an existing entry — always pick mode
  rosterForm.player_id.value = e.player_id;
  // Filter the division + events lists by the picked player's gender BEFORE
  // we set the age_division value, so the existing value finds its <option>.
  refreshDivisionLists(_inferFormGender(rosterForm));
  rosterForm.age_division.value = e.age_division || "";
  // Multi-select: `events` is stored comma-joined ("Singles, Doubles") so a
  // plain `.value =` won't match any single <option>. Split + select each.
  _setMultiSelect(rosterForm.events, e.events);
  rosterForm.selection_status.value = e.selection_status;
  rosterForm.t_shirt_size.value = e.t_shirt_size || "";
  rosterForm.dietary_preference.value = e.dietary_preference || "";
  rosterTitle.textContent = "Edit: " + rosterName(e);
  rosterSubmit.textContent = "Save";  // audit P40: one verb across all forms
  if (typeof syncCombos === "function") syncCombos();
  applyRosterSel();
}

// Set the selected options on a <select multiple> from a comma-joined string
// (the format the backend stores for events + willing_divisions).
function _setMultiSelect(sel, csv) {
  if (!sel || !sel.multiple) return;
  const wanted = new Set(String(csv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  [...sel.options].forEach((o) => { o.selected = wanted.has(o.value); });
}
function rosterShowNew() {
  rosterEditId = null; rosterForm.reset();
  rosterTitle.textContent = "New roster entry";
  rosterSubmit.textContent = "Create";  // audit P40: matches wireEntity's "Create" on new
  rosterSetMode("pick");
  if (typeof syncCombos === "function") syncCombos();
  applyRosterSel();
}
// Two-mode add: pick an existing player, or inline-create a new one (handler
// upserts via the backend). Single-source-of-truth flag drives the form fields
// and the submit body shape.
let rosterMode = "pick";
function rosterSetMode(mode) {
  rosterMode = mode;
  const pickRow = rosterForm.querySelector(".roster-pick-row");
  const newRow = rosterForm.querySelector(".roster-new-row");
  const pickBtn = document.getElementById("roster-mode-pick");
  const newBtn = document.getElementById("roster-mode-new");
  const picker = rosterForm.querySelector("[name='player_id']");
  pickRow.hidden = mode !== "pick";
  newRow.hidden = mode !== "new";
  picker.required = mode === "pick";
  picker.disabled = mode !== "pick";
  newRow.querySelectorAll("input, select").forEach((el) => { el.disabled = mode !== "new"; });
  // Design-crit #4: segmented control reflects the active state via class +
  // aria-selected so screen readers also see the toggle.
  pickBtn.classList.toggle("seg-active", mode === "pick");
  newBtn.classList.toggle("seg-active", mode === "new");
  pickBtn.setAttribute("aria-selected", mode === "pick" ? "true" : "false");
  newBtn.setAttribute("aria-selected", mode === "new" ? "true" : "false");
  // a11y re-review #2: roving tabindex so the tablist matches the WAI-ARIA
  // pattern — Tab enters the active tab, then arrow keys move between tabs.
  pickBtn.tabIndex = mode === "pick" ? 0 : -1;
  newBtn.tabIndex = mode === "new" ? 0 : -1;
}
document.getElementById("roster-mode-pick").addEventListener("click", () => rosterSetMode("pick"));
document.getElementById("roster-mode-new").addEventListener("click", () => rosterSetMode("new"));
// Arrow-key navigation between the two roster-source tabs.
[["roster-mode-pick", "roster-mode-new"], ["roster-mode-new", "roster-mode-pick"]].forEach(([from, to]) => {
  document.getElementById(from).addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const target = document.getElementById(to);
      rosterSetMode(to === "roster-mode-pick" ? "pick" : "new");
      target.focus();
    }
  });
});
// Prev/Next record navigation (parity with the Setup master/detail forms).
const rosterNav = document.createElement("div"); rosterNav.className = "detail-nav";
const rosterPrev = document.createElement("button"); rosterPrev.type = "button"; rosterPrev.className = "nav-btn"; rosterPrev.textContent = "‹ Prev";
const rosterNext = document.createElement("button"); rosterNext.type = "button"; rosterNext.className = "nav-btn"; rosterNext.textContent = "Next ›";
const rosterPos = document.createElement("span"); rosterPos.className = "nav-pos";
rosterNav.append(rosterPrev, rosterPos, rosterNext);
rosterTitle.parentNode.insertBefore(rosterNav, rosterTitle);
function rosterUpdateNav() {
  const shown = rosterActiveData();
  const idx = shown.findIndex((e) => e.id === rosterEditId);
  const have = rosterEditId != null && idx >= 0;
  rosterPos.textContent = shown.length ? `${have ? idx + 1 : "–"} / ${shown.length}` : "";
  rosterPrev.disabled = !have || idx <= 0;
  rosterNext.disabled = !have || idx >= shown.length - 1;
}
function rosterNavTo(delta) {
  const shown = rosterActiveData();
  const idx = shown.findIndex((e) => e.id === rosterEditId);
  if (idx < 0 || !shown[idx + delta]) return;
  rosterSelect(shown[idx + delta]);
  if (rosterBuilt) try { rosterGrid.scrollToRow(rosterEditId, "nearest", false); } catch (_) {}
}
rosterPrev.addEventListener("click", () => rosterNavTo(-1));
rosterNext.addEventListener("click", () => rosterNavTo(1));
onSubmit(rosterForm, async () => {
  const b = formObj(rosterForm);
  // pick mode → numeric player_id; new mode → usta_number/first/last (player_id null).
  if (rosterMode === "pick") {
    b.player_id = Number(b.player_id); delete b.usta_number; delete b.first_name; delete b.last_name;
  } else {
    b.player_id = null;
  }
  try {
    const editing = rosterEditId != null;
    const saved = editing
      ? await api(`/roster/${rosterEditId}`, { method: "PUT", body: JSON.stringify(b) })
      : await api(`/tournaments/${active.id}/players`, { method: "POST", body: JSON.stringify(b) });
    setMsg("roster-msg", editing ? "saved" : "added", true);
    // If we just inline-created a player, refresh the Setup Players list so
    // the picker has the new option next time.
    if (!editing && rosterMode === "new") { try { await playersCrud.refresh(); } catch (_) {} }
    await loadRoster();
    const row = saved && saved.id != null && rosterRows.find((r) => r.id === saved.id);
    if (row) rosterSelect(row); else rosterShowNew();
    rosterCloseModal();
  } catch (err) { setMsg("roster-msg", err.message, false); markInvalid(rosterForm, err.message); }
});
rosterForm.querySelector(".cancel").textContent = "Cancel";
rosterForm.querySelector(".cancel").addEventListener("click", rosterCloseModal);
document.getElementById("roster-new").addEventListener("click", () => { rosterShowNew(); rosterOpenModal(); });
document.getElementById("roster-filter").addEventListener("input", () => { if (rosterBuilt) rosterGrid.setFilter(rosterMatches); });
// Sign-in sheet: the workbook's roster format (status/events/size/hotel/lodging),
// joining the loaded roster with this tournament's player-hotel rows.
const SIGNIN_HEADERS = ["Status", "Events", "Player", "USTA #", "City", "State",
  "Division", "T-shirt", "Hotel", "Lodging plan", "Dietary"];
function rosterSignInTemplate() { _csvDownload([SIGNIN_HEADERS], "sign-in-sheet-template"); }
async function rosterSignInExport() {
  if (!active) { toast("Select a tournament first", false); return; }
  let hotelByPlayer = {};
  try {
    for (const r of await api(`/tournaments/${active.id}/player-hotels`)) {
      hotelByPlayer[r.player_id] = { hotel: r.hotel_name || "", lodging: r.lodging_plan || "" };
    }
  } catch (e) { /* hotels optional — sheet still useful without them */ }
  const rows = [SIGNIN_HEADERS.slice()];
  for (const e of [...rosterRows].sort((a, b) =>
    (a.last_name || "").localeCompare(b.last_name || "") || (a.first_name || "").localeCompare(b.first_name || ""))) {
    const h = hotelByPlayer[e.player_id] || {};
    const p = playersById[e.player_id] || {};
    rows.push([
      e.selection_status, e.events || "",
      [e.last_name, e.first_name].filter(Boolean).join(", "), e.usta_number,
      p.city || "", p.state || "", e.age_division || "", e.t_shirt_size || "",
      h.hotel || "", h.lodging || "", e.dietary_preference || "",
    ]);
  }
  _csvDownload(rows, `sign-in-sheet-${(active.name || "").replace(/\s+/g, "_")}`);
}
// --- Data → Import page: per-type upload → staging → merge (built from /api/import/types) ---
function _importRefresh() {
  // Audit (fifth-pass #1 + seventh-pass B2): refresh every grid that an
  // importer can touch. Roster + Part B grids are tournament-scoped; Setup →
  // Players and Distances are cross-tournament and can be filled by an
  // importer creating new player rows or new distance entries.
  if (active) {
    loadRoster(); loadLate(); loadWithdrawals();
    schedList.load(); divflexList.load(); photelList.load();
    loadPairing(); loadDoubles();
  }
  if (typeof playersCrud !== "undefined" && playersCrud.refresh) {
    playersCrud.refresh().catch(() => {});
  }
  if (typeof distancesCrud !== "undefined" && distancesCrud.refresh) {
    distancesCrud.refresh().catch(() => {});
  }
}
function _renderBatch(el, body) {
  el.innerHTML = `<div class="muted">Staged ${body.total}: <strong>${body.valid} valid</strong>, ${body.invalid} invalid.</div>`;
  if (body.errors && body.errors.length) {
    el.innerHTML += '<ul class="import-errors">' +
      body.errors.map((e) => `<li>row ${e.row}: ${esc(e.error)}</li>`).join("") + "</ul>";
  }
  const merge = document.createElement("button");
  merge.type = "button"; merge.className = "export-btn"; merge.disabled = !body.valid;
  merge.textContent = `Merge ${body.valid} valid row(s)`;
  merge.addEventListener("click", async () => {
    merge.disabled = true;
    try {
      const r = await api(`/import/batches/${body.batch_id}/merge`, { method: "POST" });
      const nConf = (r.conflicts || []).length;
      toast(`Merged ${r.merged}${r.failed ? `, ${r.failed} failed` : ""}${nConf ? `, ${nConf} conflict(s)` : ""}`, !r.failed);
      let html = `<div class="muted">Merged ${r.merged} row(s)${r.failed ? `; ${r.failed} failed` : ""}.</div>`;
      if (nConf) {
        html += `<div class="warn" style="margin-top:0.2rem">⚠ ${nConf} conflict(s) — merged anyway:</div>` +
          '<ul class="import-errors" style="color:var(--warn-ink,#8a6d1b)">' +
          r.conflicts.map((c) => `<li>row ${c.row}: ${esc(c.detail)}</li>`).join("") + "</ul>";
      }
      if (r.errors && r.errors.length) {
        html += '<ul class="import-errors"><li>' +
          r.errors.map((e) => `row ${e.row}: ${esc(e.error)}`).join("</li><li>") + "</li></ul>";
      }
      el.innerHTML = html;
      _importRefresh();
    } catch (e) { toast(e.message, false); merge.disabled = false; }
  });
  const disc = document.createElement("button");
  disc.type = "button"; disc.className = "export-btn"; disc.textContent = "Discard";
  disc.addEventListener("click", async () => {
    try { await api(`/import/batches/${body.batch_id}`, { method: "DELETE" }); el.innerHTML = ""; }
    catch (e) { toast(e.message, false); }
  });
  const actions = document.createElement("div"); actions.className = "export-grid";
  actions.append(merge, disc); el.appendChild(actions);
}
// Which import types are Setup catalogs (no active tournament needed) vs
// tournament-scoped. Used to split the Import page into two groups and to
// gate the active-tournament needs-note.
const _IMPORT_SETUP_KEYS = new Set(["distances", "divisions", "events", "players", "officials"]);

async function buildImportPage() {
  const tRoot = document.getElementById("import-sections-tournament");
  const sRoot = document.getElementById("import-sections-setup");
  const note = document.getElementById("import-needs-active");
  if (!tRoot || !sRoot) return;
  // Toggle the needs-active hint based on current selection.
  if (note) note.hidden = !!active;
  if (tRoot.dataset.built) return;
  // Set the guard BEFORE the await so a second concurrent call (e.g. the tab
  // click handler + gotoImport both firing) doesn't race past this check and
  // append a duplicate set of sections.
  tRoot.dataset.built = "1";
  let types;
  try { types = await api("/import/types"); }
  catch (e) { tRoot.textContent = e.message; tRoot.dataset.built = ""; return; }
  for (const t of types) {
    const sec = document.createElement("section");
    sec.className = "export-section";
    sec.id = "import-" + t.key;     // deep-link target for per-panel ⬆ Import buttons
    // a11y 9th-pass: tabindex="-1" makes the heading programmatically focusable
    // so gotoImport() can land focus here. Sighted users see no change; SR /
    // keyboard users get correct focus order after the deep-link.
    sec.innerHTML = `<h4 tabindex="-1">${esc(t.label)}</h4><p class="muted">${esc(t.desc)} ` +
      `<span class="muted">Columns: ${esc(t.columns.join(", "))}${t.required.length ? ` (required: ${esc(t.required.join(", "))})` : ""}.</span></p>`;
    const row = document.createElement("div"); row.className = "export-grid";
    for (const fmt of ["csv", "xlsx"]) {
      const a = document.createElement("a"); a.className = "export-btn"; a.setAttribute("download", "");
      a.href = `/api/import/template/${t.key}?fmt=${fmt}`;
      a.textContent = fmt === "csv" ? "⬇ Template CSV" : "⬇ Template Excel";
      row.appendChild(a);
    }
    // CSV/XLSX for the row-shaped importers; PDF for the emails_pdf type.
    const file = document.createElement("input"); file.type = "file";
    file.accept = t.key === "emails_pdf" ? ".pdf" : ".csv,.xlsx,.xlsm";
    const up = document.createElement("button"); up.type = "button"; up.className = "export-btn"; up.textContent = "Upload & stage";
    const msg = document.createElement("span"); msg.className = "msg";
    row.append(file, up, msg);
    const result = document.createElement("div"); result.className = "import-result";
    sec.append(row, result);
    up.addEventListener("click", async () => {
      if (!active) { msg.textContent = "select a tournament first"; msg.className = "msg bad"; return; }
      if (!file.files[0]) { msg.textContent = "choose a file"; msg.className = "msg bad"; return; }
      up.disabled = true; msg.textContent = "";
      try {
        // Audit M25: route through api() so the progress bar runs and 422
        // detail arrays get the same humanizer as the rest of the app.
        const fd = new FormData(); fd.append("file", file.files[0]);
        const body = await api(`/import/tournaments/${active.id}/${t.key}`, { method: "POST", body: fd });
        file.value = "";
        _renderBatch(result, body);
      } catch (e) { msg.textContent = e.message; msg.className = "msg bad"; }
      finally { up.disabled = false; }
    });
    (_IMPORT_SETUP_KEYS.has(t.key) ? sRoot : tRoot).appendChild(sec);
  }
}

// Deep-link helper: activates the Setup → Import tab, builds the page if
// it hasn't been opened yet, and scrolls to the target section. Used by the
// per-panel ⬆ Import… buttons so users get contextual entry without the
// page having to duplicate every importer's UI.
async function gotoImport(typeKey) {
  // 1. Switch to the Setup group + Import tab.
  const setupGroupBtn = document.querySelector('.gbtn[data-group="setup"]');
  if (setupGroupBtn) setupGroupBtn.click();
  const importTab = document.querySelector('.tab[data-target="panel-import"]');
  if (importTab) importTab.click();
  // 2. Build the page if it hasn't been built yet, then scroll.
  await buildImportPage();
  const target = document.getElementById("import-" + typeKey);
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.classList.add("import-section-flash");
    setTimeout(() => target.classList.remove("import-section-flash"), 1400);
    // a11y 9th-pass: programmatically focus the section's heading so keyboard
    // users land at the right place in tab order. The activation cascade
    // (group click → first-tab click → import-tab click → buildImportPage
    // → redraws) keeps resetting focus during the ~200 ms it takes to settle,
    // so we re-apply focus a few times. Cheap, and idempotent.
    const h = target.querySelector("h4");
    const reapply = () => { if (h && document.activeElement !== h) h.focus({ preventScroll: true }); };
    reapply();
    [40, 120, 250, 450].forEach((ms) => setTimeout(reapply, ms));
  }
}
// Expose for inline handlers + tests.
window.gotoImport = gotoImport;

// Per-panel ⬆ Import… entry points. data-import-type can be a single key OR
// a comma-separated list — the Roster panel has two (`roster_initial` for
// the bulk pre-tournament load + `roster_correction` for the post-deadline
// status patch). Each key gets its own button.
let _importTypeLabels = null;
async function _ensureImportLabels() {
  if (_importTypeLabels) return _importTypeLabels;
  try {
    const types = await api("/import/types");
    _importTypeLabels = Object.fromEntries(types.map((t) => [t.key, t.label]));
  } catch (_) { _importTypeLabels = {}; }
  return _importTypeLabels;
}
async function _wirePanelImportButtons() {
  const labels = await _ensureImportLabels();
  document.querySelectorAll(".panel[data-import-type]").forEach((panel) => {
    if (panel.querySelector(".panel-import-btn")) return;
    const keys = panel.dataset.importType.split(",").map((k) => k.trim()).filter(Boolean);
    if (!keys.length) return;
    const target = panel.querySelector(".list-toolbar")
      || panel.querySelector(".actions-row")
      || panel.querySelector(".t-content > h3, .card > h3");
    if (!target) return;
    // design-crit R-1: panels with more than one import type collapse into a
    // single "⬆ Import ▾" menu (one item per type) instead of N side-by-side
    // buttons that truncate the toolbar. Single-type panels keep the compact
    // "⬆ Import…" button.
    if (keys.length > 1) {
      const items = keys.map((key) => {
        const label = labels[key] || "Import";
        // Strip the shared "Roster — " prefix so menu items read "Initial…",
        // "Correction…" rather than repeating the noun on every line.
        const tail = label.replace(/^[^—]*—\s*/, "");
        return { label: `${tail}…`, title: `Open the Import page and jump to "${label}"`, onClick: () => gotoImport(key) };
      });
      const menu = makeMenuButton(`<span aria-hidden="true">⬆</span> Import`, items, { className: "export-btn no-print panel-import-btn" });
      target.appendChild(menu);
      return;
    }
    const key = keys[0];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "export-btn no-print panel-import-btn";
    const label = labels[key] || "Import";
    btn.title = `Open the Import page and jump to "${label}"`;
    btn.innerHTML = `<span aria-hidden="true">⬆</span> Import…`;
    btn.addEventListener("click", () => gotoImport(key));
    target.appendChild(btn);
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _wirePanelImportButtons);
} else {
  _wirePanelImportButtons();
}

// --- Assignments ---
const asgForm = document.getElementById("asg-form");
let asgEditId = null;
// True when a work date falls outside the active tournament's play window.
// Audit M23: string-compare only when all three values are valid `YYYY-MM-DD`
// (the API always returns this form; defensive against any future drift).
const _ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function _outOfWindow(d) {
  if (!active || !d) return false;
  if (!_ISO_DATE.test(d) || !_ISO_DATE.test(active.play_start_date)
      || !_ISO_DATE.test(active.play_end_date)) return false;
  return d < active.play_start_date || d > active.play_end_date;
}
async function loadAssignments() {
  if (!active) return;
  // Mileage site must be one of THIS tournament's sites (audit §3 — not any site).
  // Audit M15 + N14: fire all four fetches in parallel; allSettled so one
  // failure doesn't blank the whole panel.
  const results = await Promise.allSettled([
    api(`/tournaments/${active.id}/sites`),
    api(`/room-blocks?tournament_id=${active.id}&kind=official`),
    api(`/tournaments/${active.id}/assignments`),
    api(`/tournaments/${active.id}/availability`),
  ]);
  const [tSitesR, rbListR, listR, availR] = results;
  const tSites = tSitesR.status === "fulfilled" ? tSitesR.value : [];
  const rbList = rbListR.status === "fulfilled" ? rbListR.value : [];
  const list = listR.status === "fulfilled" ? listR.value : [];
  const avail = availR.status === "fulfilled" ? availR.value : [];
  for (const r of results) if (r.status === "rejected") toast(r.reason.message, false);
  fillSelect(document.getElementById("asg-site"), tSites, siteLabel);
  fillSelect(document.getElementById("asg-room-block"), rbList, (b) => {
    const hn = hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : "hotel " + b.hotel_id;
    return `${hn} (${b.rooms_remaining}/${b.room_count} left)`;
  });
  const availByOfficial = {};
  for (const r of avail) (availByOfficial[r.official_id] ||= []).push(r.available_date);
  // Surface availability in the official picker for this tournament.
  fillSelect(document.getElementById("asg-official"), Object.values(officialsById), (o) => {
    const n = (availByOfficial[o.id] || []).length;
    return `${officialLabel(o)} — ${n ? n + " avail day(s)" : "no availability"}`;
  }, false);
  const box = document.getElementById("asg-list");
  box.innerHTML = "";
  // Audit P42: match the Tabulator placeholder styling so empty states across
  // the app look the same (✦ icon + centered muted text).
  if (list.length === 0) {
    box.innerHTML = '<div class="grid-empty"><span class="grid-empty-icon" aria-hidden="true">✦</span> No officials assigned yet — click <strong>+ Assign official</strong> above to start.</div>';
    return;
  }
  for (const a of list) box.appendChild(renderAssignment(a, (availByOfficial[a.official_id] || []).sort()));
}
function renderAssignment(a, availDates) {
  const card = document.createElement("div");
  card.className = "asg";
  // Structured header: name + actions on top; venue/hotel meta line; then
  // pay/mileage/total badges and any flags as colored chips (no run-on line).
  const mileage = a.missing_distance ? '<span class="warn">no distance</span>'
    : (a.mileage == null ? "—" : "$" + a.mileage.toFixed(2));
  // Cross-tournament double-booking (a warning, not a block — audit §3.4). A
  // different-site clash is impossible (badge-bad); same/no site is a soft
  // heads-up (badge-warn). Tooltip lists where else the official is booked.
  const conflictTitle = "Also booked the same day — " + (a.conflicts || []).map(
    (c) => `${c.work_date}${c.other_site ? ` @ ${c.other_site}` : ""} (${c.other_tournament})`
  ).join("; ");
  const flagChips = [
    a.has_conflict ? `<span class="badge badge-${a.has_hard_conflict ? "bad" : "warn"}" title="${esc(conflictTitle)}">⚠ double-booked</span>` : "",
    a.hotel_date_mismatch ? '<span class="badge badge-warn">⚠ hotel dates</span>' : "",
    a.work_date_out_of_window ? '<span class="badge badge-warn">⚠ off-window day</span>' : "",
    a.missing_distance ? '<span class="badge badge-muted">no distance</span>' : "",
  ].filter(Boolean).join(" ");
  const head = document.createElement("div"); head.className = "asg-head";
  head.innerHTML =
    `<div class="asg-name"><strong>${esc(a.official_name)}</strong></div>` +
    `<div class="asg-meta">site: ${esc(a.site_label) || "—"} · hotel: ${esc(a.hotel_name) || "—"}` +
    (a.dietary_restrictions ? ` · diet: ${esc(a.dietary_restrictions)}` : "") + `</div>` +
    `<div class="asg-badges">` +
      `<span class="badge badge-info">pay $${a.pay.toFixed(2)}</span>` +
      `<span class="badge badge-info">mileage ${mileage}</span>` +
      `<span class="badge badge-ok">total $${a.total.toFixed(2)}</span>` +
      (flagChips ? " " + flagChips : "") +
    `</div>`;
  const actions = document.createElement("span"); actions.className = "asg-actions";
  const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
  ed.addEventListener("click", () => {
    asgEditId = a.id;
    asgForm.official_id.value = a.official_id;
    asgForm.site_id.value = a.site_id || "";
    asgForm.room_block_id.value = a.room_block_id || "";
    asgForm.querySelector('button[type="submit"]').textContent = "Update assignment";
    openForm(asgForm);  // expand the (collapsible) add-form when editing
    // The fields are comboboxes — a direct .value set needs a display resync.
    if (typeof syncCombos === "function") syncCombos();
    asgForm.scrollIntoView({ block: "nearest" });
    setMsg("asg-msg", `editing assignment #${a.id} — change site/hotel, then Update`, true);
  });
  const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn-link danger"; dl.textContent = "Delete";
  dl.addEventListener("click", async () => {
    if (!(await confirmDialog("Delete assignment?"))) return;
    try { await api(`/assignments/${a.id}`, { method: "DELETE" }); loadAssignments(); } catch (e) { setMsg("asg-msg", e.message, false); }
  });
  actions.append(ed, dl); head.appendChild(actions); card.appendChild(head);

  // Inline mileage fix: if the venue site has no distance on file, add it right
  // here instead of switching to the Distances tab.
  if (a.missing_distance && a.site_id) {
    const fix = document.createElement("div"); fix.className = "add-day";
    fix.innerHTML = '<span class="muted">No mileage on file — </span>';
    const mi = document.createElement("input");
    mi.type = "number"; mi.min = "0"; mi.step = "0.1"; mi.placeholder = "one-way miles";
    mi.style.maxWidth = "9rem";
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn-link"; btn.textContent = "add distance";
    btn.addEventListener("click", async () => {
      const v = parseFloat(mi.value);
      if (!(v >= 0)) { setMsg("asg-msg", "enter one-way miles", false); return; }
      try {
        await api("/distances", { method: "POST", body: JSON.stringify({
          official_id: a.official_id, site_id: a.site_id, one_way_miles: v, source: "manual" }) });
        loadAssignments();
      } catch (e) { setMsg("asg-msg", e.message, false); }
    });
    fix.append(mi, btn);
    card.appendChild(fix);
  }

  // Confirmed days, grouped chips (cert + date with weekday). Days outside the
  // tournament's play window are flagged (a warning, not a block — audit §3.4).
  const days = document.createElement("div"); days.className = "days";
  for (const d of a.days) {
    const chip = document.createElement("span"); chip.className = "chip";
    const oow = _outOfWindow(d.work_date);
    chip.innerHTML = `${oow ? '<span class="warn" title="outside the play window">⚠ </span>' : ""}` +
      `${d.conflict ? '<span class="warn" title="double-booked: this official is assigned elsewhere this day">⚠ </span>' : ""}` +
      `${esc(fmtDOW(d.work_date))} · ${esc(certLabel(d.working_as))} $${d.rate_applied.toFixed(2)} `;
    const x = document.createElement("button"); x.type = "button"; x.className = "chip-x"; x.textContent = "×";
    x.addEventListener("click", async () => { try { await api(`/assignment-days/${d.id}`, { method: "DELETE" }); loadAssignments(); } catch (e) { setMsg("asg-msg", e.message, false); } });
    chip.appendChild(x); days.appendChild(chip);
  }
  card.appendChild(days);

  // Add days: certification dropdown + the official's available days (select all /
  // individual), falling back to a manual date if no availability is on file.
  const addRow = document.createElement("div"); addRow.className = "add-day";
  const certSel = document.createElement("select");
  CERTS.forEach(([v, lbl]) => { const o = document.createElement("option"); o.value = v; o.textContent = lbl; certSel.appendChild(o); });
  addRow.appendChild(certSel);

  const assigned = new Set(a.days.map((d) => d.work_date));
  const remaining = availDates.filter((d) => !assigned.has(d));
  let manualIn = null;
  const pickWrap = document.createElement("span"); pickWrap.className = "day-picks";
  if (availDates.length) {
    if (remaining.length) {
      const all = document.createElement("label"); all.className = "chip";
      const allCb = document.createElement("input"); allCb.type = "checkbox";
      allCb.addEventListener("change", () => pickWrap.querySelectorAll("input.dpick").forEach((c) => { c.checked = allCb.checked; }));
      all.append(allCb, document.createTextNode(" all"));
      pickWrap.appendChild(all);
      for (const d of remaining) {
        const lbl = document.createElement("label"); lbl.className = "chip";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "dpick"; cb.value = d;
        lbl.append(cb, document.createTextNode(" " + fmtDOW(d)));
        pickWrap.appendChild(lbl);
      }
    } else {
      pickWrap.innerHTML = '<span class="muted">all available days added</span>';
    }
  } else {
    pickWrap.innerHTML = '<span class="muted">no availability set — </span>';
    manualIn = document.createElement("input"); manualIn.type = "date";
    pickWrap.appendChild(manualIn);
  }
  addRow.appendChild(pickWrap);

  const addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn-link"; addBtn.textContent = "Add day(s)";
  addBtn.addEventListener("click", async () => {
    let dates = manualIn
      ? (manualIn.value ? [manualIn.value] : [])
      : [...pickWrap.querySelectorAll("input.dpick:checked")].map((c) => c.value);
    if (!dates.length) { setMsg("asg-msg", "pick day(s)", false); return; }
    const oow = dates.filter(_outOfWindow);
    if (oow.length && !(await confirmDialog(
      `${oow.length} day(s) fall outside the play window (${active.play_start_date} → ${active.play_end_date}). Add anyway?`,
      "Add anyway"))) return;
    // Double-booking pre-check: warn before adding a date this official already
    // works in another tournament (a warning, not a block — audit §3.4).
    const elsewhere = new Map((a.official_other_dates || []).map((c) => [c.work_date, c]));
    const clash = dates.filter((d) => elsewhere.has(d));
    if (clash.length && !(await confirmDialog(
      `${clash.length} day(s) double-book ${a.official_name} — already assigned elsewhere: ` +
      clash.map((d) => { const c = elsewhere.get(d); return `${d}${c.other_site ? ` @ ${c.other_site}` : ""} (${c.other_tournament})`; }).join("; ") +
      `. Add anyway?`, "Add anyway"))) return;
    try {
      for (const d of dates) {
        await api(`/assignments/${a.id}/days`, { method: "POST", body: JSON.stringify({ work_date: d, working_as: certSel.value }) });
      }
      loadAssignments();
    } catch (e) { setMsg("asg-msg", e.message, false); }
  });
  addRow.appendChild(addBtn);
  card.appendChild(addRow);
  return card;
}
function asgReset() { asgEditId = null; asgForm.reset(); asgForm.querySelector('button[type="submit"]').textContent = "Add official"; }
onSubmit(asgForm, async (e) => {
  const b = formObj(asgForm);
  b.official_id = Number(b.official_id);
  b.site_id = b.site_id ? Number(b.site_id) : null;
  b.room_block_id = b.room_block_id ? Number(b.room_block_id) : null;
  try {
    if (asgEditId) await api(`/assignments/${asgEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/tournaments/${active.id}/assignments`, { method: "POST", body: JSON.stringify(b) });
    setMsg("asg-msg", asgEditId ? "saved" : "added", true); asgReset(); loadAssignments();
  } catch (err) { setMsg("asg-msg", err.message, false); markInvalid(asgForm, err.message); }
});
asgForm.querySelector(".cancel").addEventListener("click", asgReset);

// --- Room blocks (tournament-scoped) ---
const trbForm = document.getElementById("trb-form");
let trbEditId = null;
const trbGrid = makeListGrid("trb-table", [
  { title: "ID", field: "id", width: 64 },
  { title: "Hotel", field: "hotel_id", formatter: (c) => { const b = c.getData(); return esc(hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : b.hotel_id); },
    headerFilter: "input", headerFilterFunc: (term, _v, b) => String(hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : b.hotel_id).toLowerCase().includes(String(term).toLowerCase()) },
  { title: "Type", field: "kind", cssClass: "editable-cell", formatter: (c) => (c.getData().kind === "official" ? "Officials comp" : "Player rate"),
    editor: "list", editorParams: { values: { player: "Player rate", official: "Officials comp" } } },
  { title: "Rooms", field: "room_count", hozAlign: "right", width: 90, cssClass: "editable-cell", editor: "number", editorParams: { min: 0 } },
  { title: "Left", field: "rooms_remaining", hozAlign: "right", width: 80 },
  { title: "Check-in", field: "check_in", cssClass: "editable-cell", editor: "date" },
  { title: "Check-out", field: "check_out", cssClass: "editable-cell", editor: "date" },
], "room-blocks", "No room blocks for this tournament yet.",
  async (b) => { if (!(await confirmDialog("Delete room block?"))) return; try { await api(`/room-blocks/${b.id}`, { method: "DELETE" }); loadRoomBlocks(); } catch (e) { setMsg("trb-msg", e.message, false); } },
  (b) => {
    trbEditId = b.id;
    trbForm.hotel_id.value = b.hotel_id;
    trbForm.kind.value = b.kind || "player";
    trbForm.room_count.value = b.room_count;
    trbForm.confirmation_number.value = b.confirmation_number || "";
    trbForm.check_in.value = b.check_in || "";
    trbForm.check_out.value = b.check_out || "";
    trbForm.cancellation_info.value = b.cancellation_info || "";
    trbForm.querySelector('button[type="submit"]').textContent = "Update block";
    openForm(trbForm);
  },
  // In-grid edit: PUT the whole row (RoomBlockOut carries every required field).
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const b = cell.getRow().getData();
    try {
      const body = { ...b }; delete body._act;
      body.hotel_id = Number(body.hotel_id);
      body.room_count = body.room_count == null ? 0 : Number(body.room_count);
      body.tournament_id = active.id;
      await api(`/room-blocks/${b.id}`, { method: "PUT", body: JSON.stringify(body) });
      setMsg("trb-msg", "saved", true);
      loadRoomBlocks();  // refresh rooms_remaining
    } catch (e) { setMsg("trb-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadRoomBlocks(); }
  });
async function loadRoomBlocks() {
  if (!active) return;
  trbGrid.setData(await api(`/room-blocks?tournament_id=${active.id}`));
}
function trbReset() { trbEditId = null; trbForm.reset(); trbForm.querySelector('button[type="submit"]').textContent = "Add block"; }
onSubmit(trbForm, async (e) => {
  const b = formObj(trbForm);
  b.hotel_id = Number(b.hotel_id);
  b.tournament_id = active.id;
  b.room_count = b.room_count == null ? 0 : Number(b.room_count);
  try {
    if (trbEditId) await api(`/room-blocks/${trbEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/room-blocks`, { method: "POST", body: JSON.stringify(b) });
    setMsg("trb-msg", trbEditId ? "saved" : "added", true); trbReset(); loadRoomBlocks();
  } catch (err) { setMsg("trb-msg", err.message, false); markInvalid(trbForm, err.message); }
});
trbForm.querySelector(".cancel").addEventListener("click", trbReset);

// --- Staff (non-official support roles, tournament-scoped) ---
const STAFF_ROLES = { site_director: "Site Director", player_amenities: "Player Amenities",
  trainer: "Trainer", operations: "Operations", stringer: "Stringer", other: "Other" };
const staffForm = document.getElementById("staff-form");
let staffEditId = null;
const staffGrid = makeListGrid("staff-table", [
  { title: "Name", field: "name", headerFilter: "input" },
  { title: "Role", field: "role", cssClass: "editable-cell",
    formatter: (c) => esc(STAFF_ROLES[c.getValue()] || c.getValue()),
    editor: "list", editorParams: { values: STAFF_ROLES } },
  { title: "Days", field: "days", headerSort: false,
    formatter: (c) => esc((c.getValue() || []).map(fmtDOW).join(", ")) },
  { title: "Phone", field: "phone" },
  { title: "Email", field: "email" },
  { title: "Notes", field: "notes" },
], "staff", "No staff for this tournament yet.",
  async (s) => { if (!(await confirmDialog("Delete staff member?"))) return; try { await api(`/staff/${s.id}`, { method: "DELETE" }); loadStaff(); } catch (e) { setMsg("staff-msg", e.message, false); } },
  (s) => {
    staffEditId = s.id;
    staffForm.name.value = s.name;
    staffForm.role.value = s.role;
    staffForm.phone.value = s.phone || "";
    staffForm.email.value = s.email || "";
    staffForm.notes.value = s.notes || "";
    _fillStaffDays(new Set(s.days || []));  // pre-select this member's days
    staffForm.querySelector('button[type="submit"]').textContent = "Update staff";
    openForm(staffForm);
  },
  // In-grid edit: PUT the whole row (StaffOut carries name + role).
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const s = cell.getRow().getData();
    try {
      const body = { ...s }; delete body._act; delete body.id; delete body.tournament_id;
      await api(`/staff/${s.id}`, { method: "PUT", body: JSON.stringify(body) });
      setMsg("staff-msg", "saved", true); loadStaff();
    } catch (e) { setMsg("staff-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadStaff(); }
  });
// Populate the staff Days multi-select from the active tournament's play window;
// `selected` is an optional Set of ISO dates to pre-check.
function _fillStaffDays(selected) {
  const sel = document.getElementById("staff-days");
  if (!sel) return;
  const want = selected || new Set([...sel.selectedOptions].map((o) => o.value));
  sel.innerHTML = "";
  if (!active) return;
  for (const d of _datesInRange(active.play_start_date, active.play_end_date)) {
    const o = document.createElement("option");
    o.value = d; o.textContent = fmtDOW(d);
    if (want.has(d)) o.selected = true;
    sel.appendChild(o);
  }
}
async function loadStaff() {
  if (!active) return;
  _fillStaffDays();  // play-window options for the add/edit form
  staffGrid.setData(await api(`/tournaments/${active.id}/staff`));
}
function staffReset() { staffEditId = null; staffForm.reset(); _fillStaffDays(new Set()); staffForm.querySelector('button[type="submit"]').textContent = "Add staff"; }
onSubmit(staffForm, async (e) => {
  const b = formObj(staffForm);
  // formObj joins a multi-select into "a, b"; the API wants a list of dates.
  b.days = b.days ? b.days.split(", ") : [];
  try {
    if (staffEditId) await api(`/staff/${staffEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/tournaments/${active.id}/staff`, { method: "POST", body: JSON.stringify(b) });
    setMsg("staff-msg", staffEditId ? "saved" : "added", true); staffReset(); loadStaff();
  } catch (err) { setMsg("staff-msg", err.message, false); markInvalid(staffForm, err.message); }
});
staffForm.querySelector(".cancel").addEventListener("click", staffReset);

// --- Availability (per official, per tournament) ---
let availAll = [];
function _datesInRange(start, end) {
  // Audit N20: parse + step in UTC so a DST spring-forward/fall-back day
  // doesn't skip or duplicate an ISO output.
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function renderAvailDates() {
  const sel = document.getElementById("avail-official");
  const oid = sel.value ? Number(sel.value) : null;
  const mine = availAll.filter((r) => r.official_id === oid);
  const checked = new Set(mine.map((r) => r.available_date));
  document.getElementById("avail-hotel").checked = mine.some((r) => r.hotel_needed);
  const box = document.getElementById("avail-dates");
  box.innerHTML = "";
  if (!active) return;
  for (const d of _datesInRange(active.play_start_date, active.play_end_date)) {
    const lbl = document.createElement("label"); lbl.className = "chip";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = d; cb.checked = checked.has(d);
    lbl.append(cb, document.createTextNode(" " + fmtDOW(d)));
    box.appendChild(lbl);
  }
}
const availGrid = makeReadGrid("avail-table", [
  { title: "Official", field: "official_name" },
  { title: "Available dates", field: "dates_text", headerSort: false },
  { title: "Hotel", field: "hotel", width: 90, noFilter: true, formatter: (c) => (c.getData().hotel ? "yes" : "") },
], "availability", "No availability recorded yet.");
function renderAvailTable() {
  const byOff = {};
  for (const r of availAll) {
    (byOff[r.official_name] ||= { dates: [], hotel: false });
    byOff[r.official_name].dates.push(r.available_date);
    if (r.hotel_needed) byOff[r.official_name].hotel = true;
  }
  const rows = Object.keys(byOff).sort().map((n) => ({
    official_name: n, hotel: byOff[n].hotel,
    dates_text: byOff[n].dates.sort().map(fmtDOW).join(", "),
  }));
  availGrid.setData(rows);
}
async function renderAvailCerts(oid) {
  const box = document.getElementById("avail-certs");
  box.innerHTML = "";
  if (!oid) return;
  const certs = await api(`/officials/${oid}/certifications`);
  const held = {};
  certs.forEach((c) => (held[c.cert_type] = c.id));
  for (const [v, lbl] of CERTS) {
    const wrap = document.createElement("label"); wrap.className = "chip";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = v in held;
    cb.addEventListener("change", async () => {
      try {
        if (cb.checked) await api(`/officials/${oid}/certifications`, { method: "POST", body: JSON.stringify({ cert_type: v }) });
        else if (held[v] != null) await api(`/certifications/${held[v]}`, { method: "DELETE" });
        renderAvailCerts(oid);
      } catch (e) { setMsg("avail-msg", e.message, false); cb.checked = !cb.checked; }
    });
    wrap.append(cb, document.createTextNode(" " + lbl));
    box.appendChild(wrap);
  }
}
async function loadAvailability() {
  if (!active) return;
  // Audit M34: officialsById may be empty on first load (the Officials Setup
  // tab hasn't refreshed yet). Fetch directly so the picker is always populated.
  const sel = document.getElementById("avail-official");
  const officials = Object.values(officialsById).length
    ? Object.values(officialsById)
    : await api("/officials");
  fillSelect(sel, officials, officialLabel, false);
  availAll = await api(`/tournaments/${active.id}/availability`);
  // Pick the current value once and feed it through both renderers, instead of
  // letting renderAvailDates read .value while comboSync may still be settling.
  const oid = sel.value ? Number(sel.value) : null;
  renderAvailDates();
  renderAvailTable();
  renderAvailCerts(oid);
}
document.getElementById("avail-official").addEventListener("change", () => {
  renderAvailDates();
  renderAvailCerts(Number(document.getElementById("avail-official").value) || null);
});
document.getElementById("avail-save").addEventListener("click", async () => {
  if (!active) return;
  const sel = document.getElementById("avail-official");
  if (!sel.value) { setMsg("avail-msg", "pick an official", false); return; }
  const dates = [...document.querySelectorAll("#avail-dates input:checked")].map((c) => c.value);
  try {
    await api(`/tournaments/${active.id}/availability`, {
      method: "PUT",
      body: JSON.stringify({ official_id: Number(sel.value), dates, hotel_needed: document.getElementById("avail-hotel").checked }),
    });
    setMsg("avail-msg", "saved", true);
    await loadAvailability();
  } catch (e) { setMsg("avail-msg", e.message, false); }
});

// --- Part B: review inbox + late entries ---
const EMAIL_CLASSES = ["unclassified", "late_entry", "withdrawal", "doubles",
  "pairing_avoidance", "scheduling_avoidance", "division_flex", "hotel", "other"];
// design-crit I-7: title-case labels + badge color per classification so the
// Inbox column reads as colored chips (matching the Status column) instead of
// raw lowercase enum text. `color` keys map to the .badge-* CSS variants.
const EMAIL_CLASS_META = {
  unclassified:         { label: "Unclassified",  color: "muted" },
  late_entry:           { label: "Late entry",     color: "info" },
  withdrawal:           { label: "Withdrawal",     color: "bad" },
  doubles:              { label: "Doubles",        color: "info" },
  pairing_avoidance:    { label: "Pairing avoid.", color: "warn" },
  scheduling_avoidance: { label: "Scheduling",     color: "warn" },
  division_flex:        { label: "Division flex",  color: "info" },
  hotel:                { label: "Hotel",          color: "ok" },
  other:                { label: "Other",          color: "muted" },
};
// Object map {value: label} for Tabulator list editor + header-filter so those
// dropdowns also show the friendly labels.
const EMAIL_CLASS_VALUES = Object.fromEntries(
  EMAIL_CLASSES.map((v) => [v, (EMAIL_CLASS_META[v] || {}).label || v]));
function classChip(v) {
  const meta = EMAIL_CLASS_META[v];
  if (!meta) return v ? `<span class="badge badge-muted">${esc(v)}</span>` : "";
  return `<span class="badge badge-${meta.color}">${esc(meta.label)}</span>`;
}
// Confidence hint for an auto-detected player: a small dot after the name whose
// color + tooltip explain HOW the player was matched, so the TD trusts a USTA #
// hit more than a bare-surname guess (and can spot ones worth double-checking).
const MATCH_KIND_META = {
  usta:              { dot: "●", cls: "ok",   label: "Matched by USTA # in the email — high confidence" },
  withdraw_template: { dot: "●", cls: "ok",   label: "Matched by USTA withdrawal template — high confidence" },
  usta_subject:      { dot: "●", cls: "ok",   label: "Matched by USTA subject (first name + division) — high confidence" },
  fullname_subject:  { dot: "●", cls: "ok",   label: "Full name in the subject — high confidence" },
  fullname_body:     { dot: "◐", cls: "warn", label: "Full name in the body — medium confidence" },
  lastname_subject:  { dot: "○", cls: "warn", label: "Surname only (subject) — please verify" },
  lastname:          { dot: "○", cls: "warn", label: "Surname only — please verify" },
  manual:            { dot: "✎", cls: "info", label: "Set manually" },
};
function matchHint(kind) {
  const m = MATCH_KIND_META[kind];
  if (!m) return "";
  return ` <span class="match-hint match-${m.cls}" title="${esc(m.label)}" aria-label="${esc(m.label)}">${m.dot}</span>`;
}
const lateForm = document.getElementById("late-form");
const wdForm = document.getElementById("withdrawal-form");
// Audit A49: FILE_TARGETS is keyed by *classification* (so the Inbox knows
// where to file an email) while FORM_MODALS is keyed by *form id* (so the
// generic modal wrapping logic knows which forms to overlay). They overlap
// on form elements but the lookup keys differ — kept separate intentionally;
// any TD-visible label drift between them should be flagged in code review.
const FILE_TARGETS = {
  late_entry: { label: "Late entry", tab: "panel-t-late", form: lateForm, msg: "late-msg" },
  withdrawal: { label: "Withdrawal", tab: "panel-t-withdrawals", form: wdForm, msg: "withdrawal-msg" },
  scheduling_avoidance: { label: "Scheduling avoid.", tab: "panel-t-sched", form: document.getElementById("sched-form"), msg: "sched-msg" },
  division_flex: { label: "Division flex", tab: "panel-t-divflex", form: document.getElementById("divflex-form"), msg: "divflex-msg" },
  hotel: { label: "Player hotel", tab: "panel-t-photels", form: document.getElementById("photel-form"), msg: "photel-msg" },
  pairing_avoidance: { label: "Pairing avoid.", tab: "panel-t-pairing", form: document.getElementById("pairing-form"), msg: "pairing-msg" },
  doubles: { label: "Doubles", tab: "panel-t-doubles", form: document.getElementById("doubles-form"), msg: "doubles-msg" },
};
// FILE_TARGETS holds the *DOM wiring* (tab/form/msg), which can only live in the
// frontend. The set of classification keys + their labels + which are
// bulk-populatable is owned by the backend registry (app/email_targets.py),
// exposed at GET /api/emails/targets. verifyEmailTargets() reconciles the two at
// boot so the keys/labels can't silently drift (the bug class that left bulk
// "scheduling" filing into nothing): the server label becomes authoritative and
// any key the server knows but the UI can't file — or vice versa — is logged
// loudly. The literal above is the fallback when the fetch hasn't run / fails,
// so single-file filing keeps working regardless.
async function verifyEmailTargets() {
  let targets;
  try { targets = await api("/emails/targets"); }
  catch (e) { console.warn("[email-targets] could not load registry:", e.message); return; }
  const serverKeys = new Set(targets.map((t) => t.key));
  for (const t of targets) {
    const dom = FILE_TARGETS[t.key];
    if (!dom) { console.warn(`[email-targets] DRIFT: server target '${t.key}' has no FILE_TARGETS DOM wiring — emails of this class can't be filed in the UI.`); continue; }
    dom.label = t.label;                                   // server is authoritative for the label
    if (EMAIL_CLASS_META[t.key]) EMAIL_CLASS_META[t.key].label = t.label;
    dom.bulk = t.bulk;                                     // expose bulk-ness to the UI if needed
  }
  for (const key of Object.keys(FILE_TARGETS)) {
    if (!serverKeys.has(key)) console.warn(`[email-targets] DRIFT: FILE_TARGETS offers '${key}' but the backend registry doesn't know it — bulk populate will skip these.`);
  }
}

// Inbox grid. Classification is an inline list-editor (double-click); the per-row
// File-target picker + File / Suggest / Delete buttons live in the actions column.
async function _inboxPutClass(m, classification) {
  // Preserve the detected player on a classification-only change — the PUT
  // overwrites detected_player_id with whatever we send, so omitting it would
  // silently unlink the player (and clear its match_kind).
  await api(`/emails/${m.id}`, { method: "PUT", body: JSON.stringify({
    // Preserve the email's OWN tournament — the inbox is cross-tournament, so
    // forcing active.id here silently re-homed an email belonging to another
    // tournament whenever its classification was changed/suggested. Only fall
    // back to the active workspace for an as-yet-unassigned email.
    tournament_id: m.tournament_id ?? (active && active.id) ?? null,
    classification, status: m.status,
    detected_player_id: m.detected_player_id ?? null,
  }) });
}
const inboxGrid = makeReadGrid("inbox-table", [
  // Mass-select column: master checkbox in header + per-row toggle. Drives
  // the bulk-action toolbar shown above the grid.
  { title: "", field: "_sel", headerSort: false, width: 40, hozAlign: "center",
    titleFormatter: () => {
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.setAttribute("aria-label", "Select all visible");
      cb.addEventListener("change", (e) => _inboxBulkToggleAll(e.target.checked));
      return cb;
    },
    formatter: (cell) => {
      const m = cell.getData();
      const cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = _inboxSelected.has(m.id);
      cb.setAttribute("aria-label", `Select email ${m.subject || m.id}`);
      cb.addEventListener("click", (ev) => ev.stopPropagation());
      cb.addEventListener("change", (e) => _inboxBulkToggle(m.id, e.target.checked));
      return cb;
    } },
  { title: "Received", field: "received_at", width: 110, formatter: (c) => esc((c.getData().received_at || "").slice(0, 10)) },
  // Which tournament this email is filed under. The inbox shows every
  // tournament's mail; this column (+ its header filter) is how the TD scopes
  // or reassigns. Header-filtered to the active tournament by default.
  { title: "Tournament", field: "tournament_name", width: 150,
    formatter: (c) => c.getValue() ? esc(c.getValue()) : `<span class="muted">— unassigned —</span>`,
    headerFilter: "input" },
  { title: "From", field: "from_address" },
  { title: "Subject", field: "subject" },
  // Detected player — name + USTA from the LEFT JOIN. Click-to-edit lands
  // in the detail pane's player picker.
  { title: "Player", field: "detected_player_name", width: 160,
    formatter: (cell) => {
      const m = cell.getData(); const row = cell.getRow();
      // I-4: empty cell offers an inline "Detect" link instead of a dead "—".
      if (!m.detected_player_name) {
        const wrap = document.createElement("span");
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "btn-link inline-detect"; btn.textContent = "Detect";
        btn.title = "Detect the player this email is about";
        btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          try {
            const det = await api(`/emails/${m.id}/detect-player`, { method: "POST" });
            row.update({
              detected_player_id: det.detected_player_id,
              detected_usta: det.detected_usta,
              detected_player_name: det.detected_player_name,
              detected_match_kind: det.match_kind,
            });
            row.reformat();
            toast(det.detected_player_name ? `Detected: ${det.detected_player_name}` : "No player match", !!det.detected_player_name);
          } catch (e) { toast(e.message, false); }
        });
        wrap.appendChild(btn);
        return wrap;
      }
      const usta = m.detected_usta ? ` <span class="muted">(${esc(m.detected_usta)})</span>` : "";
      return esc(m.detected_player_name) + usta + matchHint(m.detected_match_kind);
    },
    headerFilter: "input",
    headerFilterFunc: (term, _v, e) =>
      ((e.detected_player_name || "") + " " + (e.detected_usta || "")).toLowerCase().includes(String(term).toLowerCase()) },
  { title: "Classification", field: "classification", width: 150, cssClass: "editable-cell",
    formatter: (c) => classChip(c.getValue()),
    editor: "list", editorParams: { values: EMAIL_CLASS_VALUES },
    headerFilter: "list", headerFilterParams: { values: EMAIL_CLASS_VALUES, clearable: true } },
  { title: "Status", field: "status", width: 110, formatter: (c) => chip(c.getData().status),
    headerFilter: "list", headerFilterParams: { values: ["", "new", "filed", "needs_followup"], clearable: true } },
  { title: "", field: "_act", headerSort: false, widthGrow: 0, width: 150, cssClass: "grid-actions-cell",
    formatter: (cell) => {
      // Review is the primary per-row action; Suggest / File / Delete fold into
      // a ⋯ overflow menu (design-crit I-2) to keep the row uncluttered. The
      // menu is body-anchored so it isn't clipped by the grid cell.
      const m = cell.getData(); const row = cell.getRow();
      const fileable = !!FILE_TARGETS[m.classification];
      const wrap = document.createElement("div"); wrap.className = "grid-actions";
      const rvBtn = document.createElement("button"); rvBtn.type = "button";
      rvBtn.className = "btn-link"; rvBtn.textContent = "Review";
      rvBtn.title = "Open the full email in a modal";
      rvBtn.addEventListener("click", (ev) => { ev.stopPropagation(); _openInboxDetail(m); });

      const doSuggest = async () => {
        try {
          // 1) classification suggestion (preserves any existing player link)
          const res = await api(`/emails/${m.id}/suggest`, { method: "POST" });
          await _inboxPutClass(m, res.classification);
          m.classification = res.classification;
          // 2) player detection — resolve who the email is about and persist it
          const det = await api(`/emails/${m.id}/detect-player`, { method: "POST" });
          row.update({
            classification: res.classification,
            detected_player_id: det.detected_player_id,
            detected_usta: det.detected_usta,
            detected_player_name: det.detected_player_name,
            detected_match_kind: det.match_kind,
          });
          row.reformat();
          const clsLabel = (EMAIL_CLASS_META[res.classification] || {}).label || res.classification;
          const who = det.detected_player_name ? ` · player: ${det.detected_player_name}` : " · no player match";
          toast(`Suggested: ${clsLabel}${who}`, true);
        } catch (e) { toast(e.message, false); }
      };
      const doFile = () => {
        const t = FILE_TARGETS[m.classification]; if (!t) return;
        // File into the email's OWN tournament, not whatever is active. The inbox
        // is cross-tournament and every filing form POSTs to
        // /tournaments/<active>/… , so re-scope the workspace to the email's
        // tournament first (setActive toasts the switch). An unassigned email
        // (no tournament_id) falls through and files under the active workspace.
        if (m.tournament_id && (!active || m.tournament_id !== active.id)) {
          setActive(String(m.tournament_id));
        }
        // Switch tab FIRST — the tab handler refreshes some player selects, which
        // would otherwise wipe a preset value (same ordering as the roster→withdraw
        // flow above). Set the form fields after, then open the modal so
        // scheduleComboSync() shows the chosen name in the type-in combobox.
        document.querySelector(`.tab[data-target="${t.tab}"]`).click();
        t.form.source_email_id.value = m.id;
        // Carry the auto-detected player into the form's required picker so the
        // TD doesn't re-select someone the inbox already identified (mirrors the
        // bulk-populate path, which files on detected_player_id directly). Stays
        // editable before saving; forms without a single player_ref (e.g.
        // pairing's member rows) are skipped by the guard.
        if (t.form.player_ref && m.detected_player_id) {
          t.form.player_ref.value = String(m.detected_player_id);
          // Sync the combobox display SYNCHRONOUSLY (not the rAF-debounced
          // scheduleComboSync): this same menu click bubbles to the document
          // click handler that closes open comboboxes, and close() resets the
          // select to blank when the combo's text input is still empty. Filling
          // the display now means the input is non-empty by the time that fires.
          if (typeof t.form.player_ref._comboSync === "function") t.form.player_ref._comboSync();
        }
        // Carry the auto-detected withdrawal reason into the form so the TD
        // doesn't retype it (still editable before saving).
        if (m.classification === "withdrawal" && t.form.reason && m.detected_reason) {
          t.form.reason.value = m.detected_reason;
        }
        // Carry the locally-parsed age division + events into the form's
        // catalog pickers (late entry has both; withdrawal has events). Only
        // select option values that actually exist for this tournament's
        // catalog; unknown/unmatched values are left blank for the TD.
        const div = t.form.elements.age_division;
        if (div && m.detected_division &&
            [...div.options].some((o) => o.value === m.detected_division)) {
          div.value = m.detected_division;
          if (typeof div._comboSync === "function") div._comboSync();
        }
        const evSel = t.form.elements.events;
        if (evSel && evSel.multiple && m.detected_events) {
          const want = new Set(m.detected_events.split(",").map((s) => s.trim()));
          [...evSel.options].forEach((o) => { if (want.has(o.value)) o.selected = true; });
        }
        // Scheduling avoidance: carry the parsed day + time-range free-text.
        if (t.form.elements.avoid_day && m.detected_avoid_day) {
          t.form.elements.avoid_day.value = m.detected_avoid_day;
        }
        if (t.form.elements.avoid_time_range && m.detected_avoid_time) {
          t.form.elements.avoid_time_range.value = m.detected_avoid_time;
        }
        openForm(t.form);
        scheduleComboSync();
        setMsg(t.msg, `filing from email #${m.id}`, true);
        const focusEl = t.form.querySelector(".combo-input") || t.form.querySelector("input, select");
        if (focusEl) focusEl.focus();
      };
      const doDelete = async () => {
        if (!(await confirmDialog("Delete email?"))) return;
        try { await api(`/emails/${m.id}`, { method: "DELETE" }); loadInbox(); }
        catch (e) { toast(e.message, false); }
      };
      const items = [
        { label: "Suggest classification + player", title: "Run the local classifier and player detector", onClick: doSuggest },
        { label: fileable ? `File as ${FILE_TARGETS[m.classification].label}` : "File (set a classification first)",
          title: fileable ? "" : "Pick a fileable classification first", onClick: () => { if (fileable) doFile(); } },
        { separator: true },
        { label: "Delete email", danger: true, onClick: doDelete },
      ];
      const menu = makeMenuButton("⋯", items, { className: "btn-icon row-more", title: "More actions", anchor: true, noCaret: true });
      wrap.append(rvBtn, menu); return wrap;
    } },
], "inbox", "Inbox empty — add a forwarded email above.", { index: "id" });
// Persist an inline classification edit (double-click the cell).
inboxGrid.grid.on("cellEdited", async (cell) => {
  if (cell.getField() !== "classification" || cell.getValue() === cell.getOldValue()) return;
  try { await _inboxPutClass(cell.getData(), cell.getValue()); cell.getRow().reformat(); }
  catch (e) { setMsg("email-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} }
});

// Detail pane: clicking a row opens it below the grid. Lets the TD read the
// full email body and override the classification or status.
let _inboxDetailId = null;
let _inboxDetailTid = null;  // the open email's own tournament_id (preserved on save)
function _populateInboxClassSelect() {
  const sel = document.getElementById("inbox-detail-classification");
  if (!sel || sel.options.length) return;
  for (const v of EMAIL_CLASSES) {
    const o = document.createElement("option"); o.value = v;
    o.textContent = (EMAIL_CLASS_META[v] || {}).label || v; sel.appendChild(o);
  }
}
// Format the email body for syntax-highlighted display. Escapes the raw
// text first (XSS-safe), then wraps known email-header markers in spans
// the CSS colors. Recognizes both forwarding styles:
//   Outlook: From: / Sent: / To: / Cc: / Bcc: / Subject: / Date:
//   Apple Mail: "On <date>, <name> wrote:"
//   Wrapper-injected: [Date: ...] / [To: ...] (added by emails_pdf importer)
function _formatEmailBody(raw) {
  if (!raw) return "";
  return raw.split("\n").map((line) => {
    const e = esc(line);
    // Wrapper-injected metadata at the very top: [Date: …] or [To: …]
    const meta = e.match(/^\[(Date|To|From|Subject):\s*(.+)\]$/);
    if (meta) {
      return `<span class="email-meta">[<span class="email-hdr-key">${meta[1]}:</span> ${meta[2]}]</span>`;
    }
    // Standard email-thread header line: From: / Sent: / To: / etc.
    const hdr = e.match(/^(\s*)(From|To|Cc|Bcc|Subject|Sent|Date|Reply-To):\s*(.*)$/i);
    if (hdr) {
      return `${hdr[1]}<span class="email-hdr-key">${hdr[2]}:</span> <span class="email-hdr-val">${hdr[3]}</span>`;
    }
    // Quote boundary marker ("On <date>, X wrote:")
    if (/^On .+ wrote:\s*$/.test(line)) {
      return `<span class="email-quote-marker">${e}</span>`;
    }
    return e;
  }).join("\n");
}

async function _populateInboxPlayerSelect(activeId) {
  const sel = document.getElementById("inbox-detail-player");
  if (!sel) return;
  // Populate once per open: roster of the active tournament.
  sel.innerHTML = '<option value="">— none —</option>';
  if (!activeId) return;
  try {
    const roster = await api(`/tournaments/${activeId}/players`);
    for (const r of roster) {
      const o = document.createElement("option"); o.value = r.player_id;
      const usta = r.usta_number ? ` (${r.usta_number})` : "";
      o.textContent = `${r.last_name || ""}, ${r.first_name || ""}${usta}`.trim();
      sel.appendChild(o);
    }
  } catch (_) { /* leave just the "none" option */ }
}

function _openInboxDetail(m) {
  _populateInboxClassSelect();
  _inboxDetailId = m.id;
  _inboxDetailTid = m.tournament_id ?? null;  // preserve on save (don't re-home to active)
  const box = document.getElementById("inbox-detail");
  box.hidden = false;
  document.getElementById("inbox-detail-subject").textContent = m.subject || "(no subject)";
  document.getElementById("inbox-detail-from").textContent = m.from_address || "(no sender)";
  document.getElementById("inbox-detail-received").textContent = (m.received_at || "").slice(0, 16).replace("T", " ");
  document.getElementById("inbox-detail-body").innerHTML = _formatEmailBody(m.body || "");
  document.getElementById("inbox-detail-classification").value = m.classification || "";
  document.getElementById("inbox-detail-status").value = m.status || "new";
  // Withdrawal reason row: show only for withdrawals, pre-filled with the
  // detected reason (a sibling helper keeps it in sync when the classification
  // is changed to/from withdrawal in the modal).
  _syncInboxReasonRow(m.classification, m.detected_reason);
  // Player picker reflects the detected_player_id (or "none").
  _populateInboxPlayerSelect(m.tournament_id || (active && active.id))
    .then(() => {
      document.getElementById("inbox-detail-player").value = m.detected_player_id || "";
    });
  setMsg("inbox-detail-msg", "", true);
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
// Show/hide + fill the withdrawal-reason row based on the current
// classification. `reason` is only applied when provided (initial open);
// toggling the dropdown just shows/hides the field without clobbering text.
function _syncInboxReasonRow(classification, reason) {
  const row = document.getElementById("inbox-detail-reason-row");
  const input = document.getElementById("inbox-detail-reason");
  if (!row || !input) return;
  const isWd = classification === "withdrawal";
  row.hidden = !isWd;
  if (isWd && reason !== undefined && reason !== null) input.value = reason;
  if (!isWd) input.value = "";
}
// Toggle the reason row when the classification is changed in the modal.
document.getElementById("inbox-detail-classification")
  ?.addEventListener("change", (e) => _syncInboxReasonRow(e.target.value));
function _closeInboxDetail() {
  _inboxDetailId = null;
  document.getElementById("inbox-detail").hidden = true;
}
// Esc closes the modal when it's open and the user isn't typing in a field
// inside it (where Esc means "cancel edit", handled by the input itself).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const box = document.getElementById("inbox-detail");
  if (!box || box.hidden) return;
  // Don't fight with the input — only swallow Esc if focus isn't inside the
  // body pre (which is tabindex=0 + focusable but has no edit mode).
  _closeInboxDetail();
});
// Click on the backdrop (outside the modal-box) also closes.
document.getElementById("inbox-detail").addEventListener("click", (e) => {
  if (e.target.id === "inbox-detail") _closeInboxDetail();
});
// Import PDF — opens the hidden file picker, posts to the emails_pdf type,
// auto-merges, reloads the inbox. No need to walk through Setup → Import.
document.getElementById("inbox-import-pdf-btn").addEventListener("click", () => {
  document.getElementById("inbox-import-pdf-input").click();
});
document.getElementById("inbox-import-pdf-input").addEventListener("change", async (e) => {
  if (!active) return;
  const f = e.target.files[0];
  if (!f) return;
  setMsg("inbox-import-pdf-msg", `uploading ${f.name}…`, true);
  try {
    const fd = new FormData(); fd.append("file", f);
    const up = await api(`/import/tournaments/${active.id}/emails_pdf`, { method: "POST", body: fd });
    setMsg("inbox-import-pdf-msg", `staged ${up.valid} of ${up.total} — merging…`, true);
    const m = await api(`/import/batches/${up.batch_id}/merge`, { method: "POST" });
    setMsg("inbox-import-pdf-msg",
      `imported ${m.merged} email${m.merged === 1 ? "" : "s"}` +
        (m.conflicts.length ? ` (+${m.conflicts.length} dupes skipped)` : ""), true);
    await loadInbox();
  } catch (err) {
    setMsg("inbox-import-pdf-msg", err.message, false);
  } finally {
    e.target.value = "";
  }
});
// Note: rowClick used to open the detail pane; replaced by the per-row
// Review button so a stray click while bulk-selecting doesn't pop the modal.
document.getElementById("inbox-detail-close").addEventListener("click", _closeInboxDetail);
document.getElementById("inbox-detail-save").addEventListener("click", async () => {
  if (_inboxDetailId == null) return;
  const cls = document.getElementById("inbox-detail-classification").value;
  const status = document.getElementById("inbox-detail-status").value;
  const pickerVal = document.getElementById("inbox-detail-player").value;
  const detected_player_id = pickerVal ? Number(pickerVal) : null;
  try {
    await api(`/emails/${_inboxDetailId}`, {
      method: "PUT",
      body: JSON.stringify({
        // keep the email's own tournament (see _inboxPutClass) — don't re-home
        // to the active workspace; only default to active if it was unassigned.
        tournament_id: _inboxDetailTid ?? (active && active.id) ?? null,
        classification: cls, status,
        detected_player_id,
      }),
    });
    setMsg("inbox-detail-msg", "saved", true);
    await loadInbox();
  } catch (e) { setMsg("inbox-detail-msg", e.message, false); }
});
document.getElementById("inbox-detail-suggest").addEventListener("click", async () => {
  if (_inboxDetailId == null) return;
  try {
    const res = await api(`/emails/${_inboxDetailId}/suggest`, { method: "POST" });
    document.getElementById("inbox-detail-classification").value = res.classification;
    setMsg("inbox-detail-msg", `suggested: ${res.classification}`, true);
  } catch (e) { setMsg("inbox-detail-msg", e.message, false); }
});

// ---- Bulk inbox selection state + toolbar wiring ------------------------
const _inboxSelected = new Set();
function _inboxBulkToggle(id, on) {
  if (on) _inboxSelected.add(id); else _inboxSelected.delete(id);
  _inboxBulkRefreshUi();
}
function _inboxBulkToggleAll(on) {
  for (const row of inboxGrid.grid.getRows("active")) {
    const id = row.getData().id;
    if (on) _inboxSelected.add(id); else _inboxSelected.delete(id);
  }
  inboxGrid.grid.redraw();
  _inboxBulkRefreshUi();
}
function _inboxBulkRefreshUi() {
  const bar = document.getElementById("inbox-bulk-toolbar");
  bar.hidden = _inboxSelected.size === 0;
  const n = _inboxSelected.size;
  document.getElementById("inbox-bulk-count").textContent =
    n === 0 ? "" : `${n} selected`;
}
// I-3: build a per-target-list breakdown of what Populate would create, so the
// TD sees "5 Withdrawals, 3 Doubles, 2 unfileable" before committing. Reads the
// classification off each selected row's grid data and maps via FILE_TARGETS.
function _inboxPopulatePreview() {
  const byLabel = new Map();
  const tabByLabel = new Map();
  let unfileable = 0;
  const rows = inboxGrid.grid.getData();
  const sel = new Set(_inboxSelected);
  for (const m of rows) {
    if (!sel.has(m.id)) continue;
    const t = FILE_TARGETS[m.classification];
    if (!t) { unfileable += 1; continue; }
    byLabel.set(t.label, (byLabel.get(t.label) || 0) + 1);
    tabByLabel.set(t.label, t.tab);
  }
  // Most-populated target first — drives the toast "View" deep-link.
  const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
  const parts = ranked.map(([label, c]) => `${c} ${label}`);
  const top = ranked[0];
  return {
    parts, unfileable, fileable: parts.length > 0,
    topLabel: top ? top[0] : null,
    topTab: top ? tabByLabel.get(top[0]) : null,
  };
}
async function _inboxPopulateTournamentDropdown() {
  const sel = document.getElementById("inbox-bulk-tournament");
  if (sel.dataset.loaded === "1") return;
  try {
    const ts = await api("/tournaments");
    for (const t of ts) {
      const o = document.createElement("option"); o.value = t.id;
      o.textContent = `${t.name} (#${t.id})`;
      sel.appendChild(o);
    }
    sel.dataset.loaded = "1";
  } catch (_) { /* leave empty */ }
}
document.getElementById("inbox-bulk-clear").addEventListener("click", () => {
  _inboxSelected.clear();
  inboxGrid.grid.redraw();
  _inboxBulkRefreshUi();
});
document.getElementById("inbox-bulk-detect").addEventListener("click", async () => {
  if (!_inboxSelected.size) return;
  try {
    const res = await api("/emails/bulk/detect-players", {
      method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected] }),
    });
    const hits = res.filter((r) => r.detected_player_id).length;
    setMsg("inbox-bulk-msg", `detected ${hits} of ${res.length}`, true);
    await loadInbox();
  } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
});
document.getElementById("inbox-bulk-reassign").addEventListener("click", async () => {
  if (!_inboxSelected.size) return;
  const sel = document.getElementById("inbox-bulk-tournament");
  if (!sel.value) { setMsg("inbox-bulk-msg", "pick a tournament", false); return; }
  try {
    const res = await api("/emails/bulk/reassign", {
      method: "POST",
      body: JSON.stringify({ email_ids: [..._inboxSelected], tournament_id: Number(sel.value) }),
    });
    setMsg("inbox-bulk-msg", `moved ${res.updated} emails`, true);
    _inboxSelected.clear();
    await loadInbox();
    _inboxBulkRefreshUi();
  } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
});
document.getElementById("inbox-bulk-populate").addEventListener("click", async (ev) => {
  if (!_inboxSelected.size) return;
  const btn = ev.currentTarget;
  // I-3: show exactly what will be created, broken down by destination list,
  // plus a count of selections that can't be filed (no fileable classification).
  const { parts, unfileable, fileable, topLabel, topTab } = _inboxPopulatePreview();
  if (!fileable) {
    setMsg("inbox-bulk-msg", "None of the selected emails have a fileable classification yet.", false);
    return;
  }
  const lines = [
    `This will create rows in their target lists from ${_inboxSelected.size} selected emails:`,
    "",
    ...parts.map((p) => `  • ${p}`),
  ];
  if (unfileable) lines.push("", `${unfileable} selected email(s) have no fileable classification and will be skipped.`);
  if (!(await confirmDialog(lines.join("\n"), "Populate lists"))) return;
  // Guard against accidental double-insert: disable until the request resolves.
  btn.disabled = true;
  try {
    const res = await api("/emails/bulk/populate", {
      method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected] }),
    });
    const skippedMsg = res.skipped.length
      ? ` · ${res.skipped.length} skipped (${res.skipped.slice(0, 3).map((s) => s.reason).join("; ")}${res.skipped.length > 3 ? "…" : ""})`
      : "";
    setMsg("inbox-bulk-msg", `filed ${res.filed}${skippedMsg}`, res.skipped.length === 0);
    // I-1: close the loop with a visible toast summarizing where rows landed,
    // plus a "View" deep-link to the most-populated target list.
    const summary = `Filed ${res.filed}: ${parts.join(", ")}${skippedMsg}`;
    const action = topTab
      ? { label: `View ${topLabel}`, onClick: () => { const t = document.querySelector(`.tab[data-target="${topTab}"]`); if (t) t.click(); } }
      : null;
    toast(summary, res.skipped.length === 0, action);
    _inboxSelected.clear();
    await loadInbox();
    _inboxBulkRefreshUi();
  } catch (e) {
    setMsg("inbox-bulk-msg", e.message, false);
    toast(e.message, false);
  } finally {
    btn.disabled = false;
  }
});
// Populate the tournament dropdown lazily — once when the panel opens.
_inboxPopulateTournamentDropdown();
let _inboxFilterInit = false;
async function loadInbox() {
  if (!active) return;
  // Fetch ALL emails (not just the active tournament's) so the inbox is a true
  // triage surface — the TD can see which tournament each email belongs to and
  // reassign across tournaments. The Tournament column header-filter is set to
  // the active tournament by default so the familiar single-tournament view is
  // what shows first; clearing it reveals every tournament's mail + unassigned.
  inboxGrid.setData(await api(`/emails`));
  // Default filters: status "new" + the active tournament. One-time for status
  // (respect manual choice); the tournament filter re-applies each load so it
  // tracks the active tournament as the TD switches between them.
  if (!_inboxFilterInit) {
    _inboxFilterInit = true;
    try { inboxGrid.grid.setHeaderFilterValue("status", "new"); } catch (_) {}
  }
  try { inboxGrid.grid.setHeaderFilterValue("tournament_name", active.name || ""); } catch (_) {}
}
onSubmit(document.getElementById("email-form"), async (e) => {
  if (!active) return;
  const b = formObj(e.target); b.tournament_id = active.id;
  try { await api("/emails", { method: "POST", body: JSON.stringify(b) }); setMsg("email-msg", "added", true); e.target.reset(); loadInbox(); }
  catch (err) { setMsg("email-msg", err.message, false); markInvalid(e.target, err.message); }
});

// Generic simple list grid (no master-detail): replaces a static table with a
// Tabulator grid + a Delete action + a per-grid CSV download. Used by the
// delete-only workspace lists (late entries, withdrawals).
// Give each meaningful data column a header filter box (skip synthetic `_…`
// fields and any column that already declares its own filter). `input` matches a
// substring against the column's field value (works through formatters since the
// underlying value is what's filtered).
function _autoHeaderFilters(cols) {
  for (const col of cols) {
    if (col.headerFilter || col.noFilter || !col.field) continue;
    // Skip synthetic (`_…`) and raw key columns (id / *_id) — filtering numeric
    // keys as substrings isn't meaningful; name-bearing columns get a func instead.
    if (col.field.startsWith("_") || col.field === "id" || col.field.endsWith("_id")) continue;
    col.headerFilter = "input";
  }
  return cols;
}
function makeListGrid(tableId, columns, exportName, placeholder, onDelete, onEdit, onCellEdited, exportCols) {
  // Import/export #3: exportCols (when given) drives a *re-importable* CSV
  // export with snake_case headers, not just the visible Tabulator columns.
  // Each entry is { header, key, fmt? }; fmt(row) lets you compute e.g. a
  // comma-joined player USTA list for pairing-avoidance groups.
  const tableEl = document.getElementById(tableId);
  const panelId = tableEl.closest(".panel")?.id;
  const mount = document.createElement("div"); mount.className = "grid-mount";
  tableEl.parentElement.insertBefore(mount, tableEl); tableEl.remove();
  const csv = document.createElement("button");
  csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
  csv.addEventListener("click", () => {
    if (exportCols && exportCols.length) {
      const headers = exportCols.map((c) => c.header);
      const rows = grid.getData("active").map((r) =>
        exportCols.map((c) => (c.fmt ? c.fmt(r) : r[c.key])));
      _csvDownload([headers, ...rows], exportName);
    } else {
      grid.download("csv", exportName + ".csv");
    }
  });
  mount.parentElement.insertBefore(csv, mount);
  const cols = _autoHeaderFilters(columns.slice());
  cols.push({
    title: "", field: "_act", headerSort: false, widthGrow: 0, width: onEdit ? 72 : 48, cssClass: "grid-actions-cell",
    formatter: (cell) => {
      const r = cell.getData(); const wrap = document.createElement("div"); wrap.className = "grid-actions";
      if (onEdit) {
        const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-icon"; ed.textContent = "✎";
        ed.title = "Edit"; ed.setAttribute("aria-label", "Edit");
        ed.addEventListener("click", (ev) => { ev.stopPropagation(); onEdit(r); });
        wrap.append(ed);
      }
      const del = document.createElement("button"); del.type = "button"; del.className = "btn-icon danger"; del.textContent = "✕";
      del.title = "Delete"; del.setAttribute("aria-label", "Delete");
      del.addEventListener("click", (ev) => { ev.stopPropagation(); onDelete(r); });
      wrap.append(del); return wrap;
    },
  });
  let built = false, pending = null;
  const grid = new Tabulator(mount, {
    index: "id", layout: "fitColumns", maxHeight: "55vh", placeholder,
    renderVertical: "basic", editTriggerEvent: "click",  // single click opens the cell editor (where set)
    columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 }, columns: cols,
  });
  const _onBuilt = () => { built = true; if (pending) { grid.setData(pending); pending = null; } };
  grid.on("tableBuilt", _onBuilt);
  if (grid.initialized) _onBuilt();  // covers sync-fire race
  if (onCellEdited) grid.on("cellEdited", onCellEdited);
  if (panelId) (GRIDS[panelId] ||= []).push(grid);
  return { setData: (rows) => { if (built) grid.setData(rows); else pending = rows; } };
}

// Read-only Tabulator list (summaries / reference tables): sortable + optional
// CSV, no row actions. Replaces the <table id> in place and registers for the
// redraw-on-tab-show pass. Returns { grid, setData, setFilter }.
function makeReadGrid(tableId, columns, exportName, placeholder, opts = {}) {
  const tableEl = document.getElementById(tableId);
  const panelId = tableEl.closest(".panel")?.id;
  const mount = document.createElement("div"); mount.className = "grid-mount";
  if (opts.compact) mount.classList.add("grid-mount--compact");
  tableEl.parentElement.insertBefore(mount, tableEl); tableEl.remove();
  if (exportName) {
    const csv = document.createElement("button");
    csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
    csv.addEventListener("click", () => grid.download("csv", exportName + ".csv"));
    mount.parentElement.insertBefore(csv, mount);
  }
  let built = false, pending = null, pendingFilter = null;
  const grid = new Tabulator(mount, {
    layout: "fitColumns", maxHeight: opts.maxHeight || "55vh", placeholder,
    renderVertical: "basic",
    columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 }, columns: _autoHeaderFilters(columns),
    ...(opts.index ? { index: opts.index } : {}),
    ...(opts.rowFormatter ? { rowFormatter: opts.rowFormatter } : {}),
  });
  const _onBuilt = () => {
    built = true;
    if (pending) { grid.setData(pending); pending = null; }
    if (pendingFilter) { grid.setFilter(pendingFilter); pendingFilter = null; }
  };
  grid.on("tableBuilt", _onBuilt);
  if (grid.initialized) _onBuilt();  // covers sync-fire race
  if (panelId) (GRIDS[panelId] ||= []).push(grid);
  return {
    grid,
    // Read-only summary grids are often loaded async AFTER their panel becomes
    // visible (loadCvb / loadHotelSummary / …). If the grid was built while
    // hidden, fitColumns has nothing to size against — schedule a redraw once
    // data lands so columns expand to fill the now-visible container.
    setData: (rows) => {
      if (built) {
        const p = grid.setData(rows);
        if (p && typeof p.then === "function") p.then(() => { try { grid.redraw(true); } catch (_) {} });
        else requestAnimationFrame(() => { try { grid.redraw(true); } catch (_) {} });
      } else pending = rows;
    },
    setFilter: (fn) => { if (built) grid.setFilter(fn); else pendingFilter = fn; },
  };
}
const lateGrid = makeListGrid("late-table", [
  { title: "Date", field: "request_date", editor: "date", cssClass: "editable-cell",
    formatter: (c) => { const e = c.getData(); return esc(e.request_date) + (e.past_deadline ? ' <span class="warn" title="Past the late-entry deadline">⚠</span>' : ""); } },
  { title: "Time", field: "request_time", editor: "input", cssClass: "editable-cell" },
  { title: "Player", field: "last_name", formatter: _playerCell },
  { title: "USTA #", field: "usta_number" },
  { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell",
    editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }) },
  { title: "Events", field: "events", editor: "list", cssClass: "editable-cell",
    editorParams: (cell) => _eventListParams({ multiple: true, gender: _rowGender(cell.getData()) }) },
], "late-entries", "No late entries yet.",
  async (e) => { if (!(await confirmDialog("Delete late entry?"))) return; try { await api(`/late-entries/${e.id}`, { method: "DELETE" }); loadLate(); } catch (err) { setMsg("late-msg", err.message, false); } },
  undefined,
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const e = cell.getRow().getData();
    try {
      await api(`/late-entries/${e.id}`, { method: "PUT", body: JSON.stringify({
        age_division: e.age_division || null, events: e.events || null,
        request_date: e.request_date || null, request_time: e.request_time || null,
      }) });
      setMsg("late-msg", "saved", true); loadLate();
    } catch (err) { setMsg("late-msg", err.message, false); try { cell.restoreOldValue(); } catch (_) {} loadLate(); }
  },
  // Import/export #3: full importable column set with snake_case headers
  // matching importer.TYPES["late_entries"]["cols"] aliases.
  [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" },
    { header: "last_name", key: "last_name" },
    { header: "age_division", key: "age_division" },
    { header: "events", key: "events" },
    { header: "request_date", key: "request_date" },
    { header: "request_time", key: "request_time" },
    { header: "source_email_id", key: "source_email_id" },
  ]);
async function loadLate() {
  if (!active) return;
  lateGrid.setData(await api(`/tournaments/${active.id}/late-entries`));
}
function lateReset() { lateForm.reset(); lateForm.source_email_id.value = ""; }
onSubmit(lateForm, async (e) => {
  if (!active) return;
  const b = expandPlayerRef(formObj(lateForm));
  b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
  try {
    await api(`/tournaments/${active.id}/late-entries`, { method: "POST", body: JSON.stringify(b) });
    setMsg("late-msg", "added", true); lateReset(); loadLate(); loadInbox();
  } catch (err) { setMsg("late-msg", err.message, false); markInvalid(lateForm, err.message); }
});
lateForm.querySelector(".cancel").addEventListener("click", lateReset);

const wdGrid = makeListGrid("withdrawal-table", [
  { title: "Player", field: "last_name", formatter: _playerCell },
  { title: "USTA #", field: "usta_number" },
  { title: "Division", field: "age_division" },
  { title: "Events", field: "events", editor: "list", cssClass: "editable-cell",
    editorParams: (cell) => _eventListParams({ multiple: true, gender: _rowGender(cell.getData()) }) },
  { title: "Alt?", field: "was_alternate", formatter: (c) => (c.getData().was_alternate ? "yes" : "") },
  { title: "Reason", field: "reason", editor: "input", cssClass: "editable-cell" },
  { title: "Notes", field: "notes", editor: "input", cssClass: "editable-cell" },
], "withdrawals", "No withdrawals yet.",
  async (w) => { if (!(await confirmDialog("Delete withdrawal?"))) return; try { await api(`/withdrawals/${w.id}`, { method: "DELETE" }); loadWithdrawals(); loadRoster(); } catch (e) { setMsg("withdrawal-msg", e.message, false); } },
  undefined,
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const w = cell.getRow().getData();
    try {
      await api(`/withdrawals/${w.id}`, { method: "PUT", body: JSON.stringify({
        events: w.events || null, reason: w.reason || null, notes: w.notes || null,
      }) });
      setMsg("withdrawal-msg", "saved", true); loadWithdrawals();
    } catch (e) { setMsg("withdrawal-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadWithdrawals(); }
  },
  // Import/export #3: full importable column set.
  [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" },
    { header: "last_name", key: "last_name" },
    { header: "events", key: "events" },
    { header: "reason", key: "reason" },
    { header: "notes", key: "notes" },
    { header: "source_email_id", key: "source_email_id" },
  ]);
async function loadWithdrawals() {
  if (!active) return;
  wdGrid.setData(await api(`/tournaments/${active.id}/withdrawals`));
}
function wdReset() { wdForm.reset(); wdForm.source_email_id.value = ""; }
onSubmit(wdForm, async (e) => {
  if (!active) return;
  const b = expandPlayerRef(formObj(wdForm));
  b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
  try {
    await api(`/tournaments/${active.id}/withdrawals`, { method: "POST", body: JSON.stringify(b) });
    setMsg("withdrawal-msg", "added", true); wdReset(); loadWithdrawals(); loadRoster(); loadInbox();
  } catch (err) { setMsg("withdrawal-msg", err.message, false); markInvalid(wdForm, err.message); }
});
wdForm.querySelector(".cancel").addEventListener("click", wdReset);

// Generic player-keyed Part B list (form + table + delete + file-from-email).
function wirePlayerList(cfg) {
  const form = document.getElementById(cfg.formId);
  // Replace the static <table> with a Tabulator mount (don't wipe the parent card).
  const tableEl = document.getElementById(cfg.tableId);
  const panelId = tableEl.closest(".panel")?.id;  // for redraw-on-tab-show
  const mount = document.createElement("div"); mount.className = "grid-mount";
  tableEl.parentElement.insertBefore(mount, tableEl);
  tableEl.remove();
  const csv = document.createElement("button");
  csv.type = "button"; csv.className = "export-btn no-print"; csv.textContent = "⬇ CSV";
  // Import/export #3: same exportCols pattern as wireEntity — CSV includes
  // every field the matching importer can read back, not just visible cols.
  csv.addEventListener("click", () => {
    if (cfg.exportCols && cfg.exportCols.length) {
      const headers = cfg.exportCols.map((c) => c.header);
      const rows = table.getData("active").map((r) =>
        cfg.exportCols.map((c) => (c.fmt ? c.fmt(r) : r[c.key])));
      _csvDownload([headers, ...rows], cfg.exportName);
    } else {
      table.download("csv", cfg.exportName + ".csv");
    }
  });
  mount.parentElement.insertBefore(csv, mount);

  const columns = cfg.columns.slice();
  columns.push({
    title: "", field: "_act", headerSort: false, widthGrow: 0, width: 48, cssClass: "grid-actions-cell",
    formatter: (cell) => {
      const r = cell.getData();
      const wrap = document.createElement("div"); wrap.className = "grid-actions";
      const del = document.createElement("button"); del.type = "button"; del.className = "btn-icon danger"; del.textContent = "✕";
      del.title = "Delete"; del.setAttribute("aria-label", "Delete");
      del.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!(await confirmDialog("Delete?"))) return;
        try { await api(`${cfg.del}/${r.id}`, { method: "DELETE" }); load(); }
        catch (e) { setMsg(cfg.msgId, e.message, false); }
      });
      wrap.append(del); return wrap;
    },
  });
  let built = false, pending = null;
  const table = new Tabulator(mount, {
    index: "id", layout: "fitColumns", maxHeight: "55vh", placeholder: cfg.empty,
    renderVertical: "basic", editTriggerEvent: "click",  // single click opens the cell editor (where set)
    columnDefaults: { headerSortTristate: true, resizable: true, tooltip: true, widthGrow: 1 }, columns: _autoHeaderFilters(columns),
  });
  const _onBuilt = () => { built = true; if (pending) { table.setData(pending); pending = null; } };
  table.on("tableBuilt", _onBuilt);
  if (table.initialized) _onBuilt();  // covers sync-fire race
  // In-grid edit: PUT only the editable fields (cfg.editFields maps field→true);
  // identity columns (player/usta) stay read-only.
  if (cfg.editFields) table.on("cellEdited", async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const r = cell.getData();
    const body = {}; for (const f of Object.keys(cfg.editFields)) body[f] = r[f] || null;
    try { await api(`${cfg.del}/${r.id}`, { method: "PUT", body: JSON.stringify(body) }); setMsg(cfg.msgId, "saved", true); load(); if (cfg.after) cfg.after(); }
    catch (e) { setMsg(cfg.msgId, e.message, false); try { cell.restoreOldValue(); } catch (_) {} load(); }
  });
  if (panelId) (GRIDS[panelId] ||= []).push(table);

  async function load() {
    if (!active) return;
    const rows = await api(`/tournaments/${active.id}${cfg.path}`);
    if (built) await table.setData(rows); else pending = rows;
    if (cfg.after) cfg.after();
  }
  function reset() { form.reset(); form.source_email_id.value = ""; }
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (!active) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const b = expandPlayerRef(formObj(form)); b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
    try { await api(`/tournaments/${active.id}${cfg.path}`, { method: "POST", body: JSON.stringify(b) }); setMsg(cfg.msgId, "added", true); reset(); load(); loadInbox(); }
    catch (err) { setMsg(cfg.msgId, err.message, false); markInvalid(form, err.message); }
    finally { btn.disabled = false; }
  });
  form.querySelector(".cancel").addEventListener("click", reset);
  return { load };
}
const schedList = wirePlayerList({
  formId: "sched-form", msgId: "sched-msg", tableId: "sched-table",
  path: "/scheduling-avoidances", del: "/scheduling-avoidances", exportName: "scheduling-avoidances",
  empty: "No scheduling avoidances yet.",
  editFields: { avoid_day: true, avoid_time_range: true },
  columns: [
    { title: "Player", field: "last_name", formatter: _playerCell },
    { title: "USTA #", field: "usta_number" },
    { title: "Avoid day", field: "avoid_day", editor: "input", cssClass: "editable-cell" },
    { title: "Avoid time", field: "avoid_time_range", editor: "input", cssClass: "editable-cell" },
  ],
  exportCols: [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" },
    { header: "last_name", key: "last_name" },
    { header: "avoid_day", key: "avoid_day" },
    { header: "avoid_time_range", key: "avoid_time_range" },
    { header: "source_email_id", key: "source_email_id" },
  ],
});
const divflexList = wirePlayerList({
  formId: "divflex-form", msgId: "divflex-msg", tableId: "divflex-table",
  path: "/division-flex", del: "/division-flex", exportName: "division-flexibility",
  empty: "No division-flexibility entries yet.",
  editFields: { home_division: true, willing_divisions: true },
  columns: [
    { title: "Player", field: "last_name", formatter: _playerCell },
    { title: "USTA #", field: "usta_number" },
    { title: "Home", field: "home_division", editor: "input", cssClass: "editable-cell" },
    { title: "Willing", field: "willing_divisions", editor: "input", cssClass: "editable-cell" },
  ],
  exportCols: [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" },
    { header: "last_name", key: "last_name" },
    { header: "home_division", key: "home_division" },
    { header: "willing_divisions", key: "willing_divisions" },
    { header: "source_email_id", key: "source_email_id" },
  ],
});

const cvbGrid = makeReadGrid("cvb-table", [
  { title: "Hotel", field: "hotel_name" },
  { title: "Stays", field: "stays", hozAlign: "right", width: 110, widthGrow: 0 },
], "cvb-hotel-totals", "No player hotel data yet.", { compact: true });
async function loadCvb() {
  try { cvbGrid.setData(await api("/hotel-analytics")); }
  catch (e) { cvbGrid.setData([]); setMsg("photel-msg", e.message, false); }
}
// Per-tournament hotel summary: players per hotel (selected only, alphabetical).
const hotelSummaryGrid = makeReadGrid("hotel-summary-table", [
  { title: "Hotel", field: "hotel_name" },
  { title: "Players", field: "players", hozAlign: "right", width: 110, widthGrow: 0 },
], "hotel-summary", "No hotels entered for selected players yet.", { compact: true });
async function loadHotelSummary() {
  if (!active) return;
  try { hotelSummaryGrid.setData(await api(`/tournaments/${active.id}/hotel-summary`)); }
  catch (e) { hotelSummaryGrid.setData([]); setMsg("photel-msg", e.message, false); }
}
// Per-tournament lodging-plan summary: players per plan (Hotel/Commuter/…).
const lodgingSummaryGrid = makeReadGrid("lodging-summary-table", [
  { title: "Lodging plan", field: "lodging_plan" },
  { title: "Players", field: "players", hozAlign: "right", width: 110, widthGrow: 0 },
], "lodging-summary", "No lodging plans entered for selected players yet.", { compact: true });
async function loadLodgingSummary() {
  if (!active) return;
  try { lodgingSummaryGrid.setData(await api(`/tournaments/${active.id}/lodging-summary`)); }
  catch (e) { lodgingSummaryGrid.setData([]); setMsg("photel-msg", e.message, false); }
}
const photelList = wirePlayerList({
  formId: "photel-form", msgId: "photel-msg", tableId: "photel-table",
  path: "/player-hotels", del: "/player-hotels", exportName: "player-hotels",
  empty: "No player hotels reported yet.",
  editFields: { hotel_name: true, lodging_plan: true },
  // Three-column layout per requirements: division, player name, hotel name.
  // Hotel cell editor offers existing hotel names as autocomplete suggestions
  // but also accepts a new name (freetext); the backend upserts via the
  // Hotels table so the spelling stays canonical.
  columns: [
    { title: "Division", field: "age_division" },
    { title: "Player", field: "last_name", formatter: _playerCell,
      headerFilterFunc: (t, _v, d) => ([d.last_name, d.first_name, d.usta_number].filter(Boolean).join(" ").toLowerCase().includes(String(t).toLowerCase())) },
    { title: "Hotel", field: "hotel_name", cssClass: "editable-cell",
      editor: "list",
      editorParams: () => ({
        values: Object.values(hotelsById || {}).map((h) => h.name).sort((a, b) => a.localeCompare(b)),
        autocomplete: true, freetext: true, allowEmpty: true, listOnEmpty: true,
      }) },
  ],
  exportCols: [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" },
    { header: "last_name", key: "last_name" },
    { header: "hotel_name", key: "hotel_name" },
    { header: "lodging_plan", key: "lodging_plan" },
    { header: "source_email_id", key: "source_email_id" },
  ],
  after: () => { loadCvb(); loadHotelSummary(); loadLodgingSummary(); },
});

// Confidential per-hotel roster: summary pivot + initials-only detail; opens
// in a new window with a print-ready stylesheet and auto-triggers Print so
// the TD can hand it to ops/CVB/etc. without exposing full player names.
//
// Note on injection: every interpolated value goes through esc() (which
// escapes &<>), so a player/hotel name containing `</style>` becomes
// `&lt;/style&gt;` and cannot break out of the <style> block. The popup is
// also a fresh document with no shared origin state.
async function openHotelConfidentialReport() {
  if (!active) { toast("Select a tournament first", false); return; }
  try {
    const data = await api(`/tournaments/${active.id}/hotel-confidential-report`);
    const win = window.open("", "_blank", "noopener");
    if (!win) { toast("Allow pop-ups for this site to print the report", false); return; }
    const e = esc;
    const summaryRows = data.summary.length
      ? data.summary.map((r) => `<tr><td>${e(r.hotel_name)}</td><td class="num">${r.players}</td><td class="num">${r.officials}</td><td class="num"><strong>${r.total}</strong></td></tr>`).join("")
      : `<tr><td colspan="4" class="empty">No hotel data yet.</td></tr>`;
    const playerRows = data.players.length
      ? data.players.map((p) => `<tr><td>${e(p.name)}</td><td>${e(p.hotel_name)}</td></tr>`).join("")
      : `<tr><td colspan="2" class="empty">No players with a hotel on file.</td></tr>`;
    const officialRows = data.officials.length
      ? data.officials.map((o) => `<tr><td>${e(o.name)}</td><td>${e(o.hotel_name)}</td></tr>`).join("")
      : `<tr><td colspan="2" class="empty">No officials with a hotel assignment.</td></tr>`;
    const t = active.name;
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Hotel report — ${e(t)}</title>
      <style>
        body { font-family: Arial, Helvetica, sans-serif; color: #1f2933; margin: 1.2cm; font-size: 12px; }
        h1 { font-size: 18px; margin: 0 0 0.2rem; }
        h2 { font-size: 14px; margin: 1.4rem 0 0.4rem; border-bottom: 2px solid #2e6f40; padding-bottom: 0.2rem; color: #2e6f40; }
        .meta { color: #556070; font-size: 11px; margin-bottom: 0.4rem; }
        table { border-collapse: collapse; width: 100%; margin: 0.4rem 0 0.8rem; }
        th, td { border: 1px solid #d9e0e6; padding: 5px 8px; text-align: left; font-size: 11px; }
        th { background: #f4f6f8; font-weight: 700; }
        td.num { text-align: right; font-variant-numeric: tabular-nums; }
        td.empty { color: #556070; font-style: italic; text-align: center; }
        tr.totals td { font-weight: 700; background: #e7f1ea; border-top: 2px solid #2e6f40; }
        .pagebreak { page-break-before: always; }
        @media print { @page { margin: 1.2cm; } }
        @media print { .noprint { display: none; } }
        .noprint { margin-top: 1rem; }
        .noprint button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }
      </style></head><body>
      <h1>Confidential hotel report</h1>
      <div class="meta">${e(t)} · ${e(active.play_start_date || "")} → ${e(active.play_end_date || "")} · names shown as first-initial + last name</div>

      <h2>Hotel summary — ${data.totals.hotels} hotel(s), ${data.totals.total} guest(s)</h2>
      <table><thead><tr><th>Hotel</th><th class="num">Players</th><th class="num">Officials</th><th class="num">Total</th></tr></thead>
        <tbody>${summaryRows}
          <tr class="totals"><td>Totals</td><td class="num">${data.totals.players}</td><td class="num">${data.totals.officials}</td><td class="num">${data.totals.total}</td></tr>
        </tbody></table>

      <div class="pagebreak"></div>
      <h2>Players (${data.totals.players})</h2>
      <table><thead><tr><th>Name</th><th>Hotel</th></tr></thead><tbody>${playerRows}</tbody></table>

      <h2>Officials (${data.totals.officials})</h2>
      <table><thead><tr><th>Name</th><th>Hotel</th></tr></thead><tbody>${officialRows}</tbody></table>

      <div class="noprint"><button onclick="window.print()">Print this report</button>
        <button onclick="window.close()">Close</button></div>
      <script>window.addEventListener("load", () => setTimeout(() => window.print(), 250));</script>
    </body></html>`);
    win.document.close();
  } catch (err) { setMsg("photel-msg", err.message, false); }
}
document.getElementById("photel-report-btn").addEventListener("click", openHotelConfidentialReport);

// --- T-shirts (Setup: cumulative cross-tournament list) ---
let tshirtRows = [];
// Shirt constants now imported from ./app/shirts.js (audit M14): single
// source of truth, declared before any reference (no TDZ).
// Map any stored size (full name OR legacy code like "YM") to a canonical code,
// so mixed historical data aggregates into one line; unknowns return as-is.
function shirtCode(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/[^a-z]/g, "");
  let group, rest;
  if (/^(youth|yth|junior|jr)/.test(s) || (s[0] === "y" && s.length <= 4)) {
    group = "Y"; rest = s.replace(/^(youth|yth|junior|jr|y)/, "");
  } else if (/^adult/.test(s) || (s[0] === "a" && s.length <= 4)) {
    group = "A"; rest = s.replace(/^(adult|a)/, "");
  } else { group = "A"; rest = s; }
  const sz = _SIZE_TOKEN[rest];
  const code = sz && group + sz;
  return _SHIRT_CODES.includes(code) ? code : String(v).trim();
}
function _shirtRank(code) { const i = _SHIRT_CODES.indexOf(code); return i < 0 ? 999 : i; }
let tshirtOrderRows = [];  // [["Size","Qty"], ...] smallest→largest, for the vendor CSV
function renderTshirtSummary() {
  // Order quantities = the latest size per player (rows arrive newest-first per
  // player), counted by canonical size. Backend excludes withdrawals/alternates.
  const latest = {};
  for (const r of tshirtRows) if (!(r.player_id in latest)) latest[r.player_id] = r.t_shirt_size;
  const counts = {};
  for (const sz of Object.values(latest)) { const c = shirtCode(sz); counts[c] = (counts[c] || 0) + 1; }
  const keys = Object.keys(counts).sort((a, b) => _shirtRank(a) - _shirtRank(b) || a.localeCompare(b));
  const players = Object.keys(latest).length;
  const label = (c) => _SHIRT_LABEL[c] || c;
  tshirtOrderRows = [["Size", "Quantity"], ...keys.map((c) => [label(c), counts[c]]), ["Total", players]];
  const el = document.getElementById("tshirt-summary");
  el.innerHTML = keys.length
    ? `<span class="muted">Order quantities — latest size per player (${players} player${players === 1 ? "" : "s"}):</span> `
      + keys.map((c) => `<span class="badge badge-info">${esc(label(c))}: ${counts[c]}</span>`).join(" ")
    : "";
}
async function tshirtOrderExport() {
  await loadTshirts();  // ensure the cumulative data + order rows are computed
  if (tshirtOrderRows.length > 1) _csvDownload(tshirtOrderRows, "tshirt-order");
  else toast("No t-shirt sizes recorded yet", false);
}
const tshirtGrid = makeReadGrid("tshirt-table", [
  { title: "Player", field: "last_name", formatter: _playerCell },
  { title: "USTA #", field: "usta_number" },
  { title: "Division", field: "age_division" },
  { title: "Tournament", field: "tournament_name" },
  { title: "Size", field: "t_shirt_size" },
], "tshirts", "No t-shirt sizes recorded yet.");
function tshirtMatches(data) {
  const q = document.getElementById("tshirt-filter").value.trim().toLowerCase();
  if (!q) return true;
  const hay = [data.first_name, data.last_name, data.usta_number,
    data.age_division, data.tournament_name, data.t_shirt_size]
    .filter(Boolean).join(" ").toLowerCase();
  return hay.includes(q);
}
function renderTshirts() {
  renderTshirtSummary();
  tshirtGrid.setData(tshirtRows);
  tshirtGrid.setFilter(tshirtMatches);
}
async function loadTshirts() { tshirtRows = await api("/tshirts"); renderTshirts(); }
document.getElementById("tshirt-filter").addEventListener("input", () => tshirtGrid.setFilter(tshirtMatches));

// --- T-shirt inventory + order tracking (per-tournament) ---
// One row per canonical size (smallest to largest). Each row's On-hand cell is
// an inline number input; Save inventory PUTs all 7 in one call. "Place order"
// freezes today's requested counts as a snapshot so later roster drift is
// visible in the Δ column.
let _tshirtOrderState = null;
function _renderTshirtOrder(data) {
  _tshirtOrderState = data;
  const tbody = document.querySelector("#tshirt-order-table tbody");
  const hasSnapshot = !!data.ordered_at;
  // Toggle the snapshot columns on/off (CSS class show/hide).
  document.querySelectorAll("#tshirt-order-table .order-snapshot")
    .forEach((el) => { el.style.display = hasSnapshot ? "" : "none"; });
  tbody.innerHTML = data.rows.map((r) => {
    const snap = r.snapshot;
    const delta = (snap != null) ? (r.requested - snap) : null;
    const dCls = (delta == null || delta === 0) ? "" : (delta > 0 ? "warn" : "muted");
    const dStr = (delta == null) ? "—" : (delta > 0 ? `+${delta}` : `${delta}`);
    return `<tr>
      <td><strong>${esc(r.size)}</strong> <span class="muted">${esc(r.label)}</span></td>
      <td class="num">${r.requested}</td>
      <td class="num"><input type="number" min="0" step="1" data-size="${esc(r.size)}" value="${r.on_hand}" style="width:5rem;text-align:right" /></td>
      <td class="num">${r.to_order}</td>
      <td class="num order-snapshot" style="${hasSnapshot ? "" : "display:none"}">${snap == null ? "—" : snap}</td>
      <td class="num order-snapshot ${dCls}" style="${hasSnapshot ? "" : "display:none"}">${dStr}</td>
    </tr>`;
  }).join("");
  const t = data.totals;
  document.getElementById("tshirt-order-totals").innerHTML =
    `<th>Totals</th><th class="num">${t.requested}</th><th class="num">${t.on_hand}</th><th class="num">${t.to_order}</th>` +
    `<th class="num order-snapshot" style="${hasSnapshot ? "" : "display:none"}">${t.snapshot == null ? "—" : t.snapshot}</th>` +
    `<th class="num order-snapshot" style="${hasSnapshot ? "" : "display:none"}"></th>`;
  const status = document.getElementById("tshirt-order-status");
  if (data.ordered_at) {
    status.innerHTML = `Order placed <strong>${esc(data.ordered_at)}</strong> — the Snapshot column shows what was requested at that moment.`;
  } else {
    status.innerHTML = `<em>No order placed yet.</em> Set inventory below, then click "Place order" to snapshot today's requested counts.`;
  }
  document.getElementById("tshirt-order-cancel").hidden = !data.ordered_at;
  document.getElementById("tshirt-order-place").textContent = data.ordered_at
    ? "Re-snapshot (replace order date)" : "Place order (snapshot today)";
}
async function loadTshirtOrder() {
  if (!active) return;
  try { _renderTshirtOrder(await api(`/tournaments/${active.id}/tshirt-order`)); }
  catch (e) { setMsg("tshirt-order-msg", e.message, false); }
}
async function saveTshirtInventory() {
  if (!active) return;
  const inputs = document.querySelectorAll("#tshirt-order-table tbody input[data-size]");
  const on_hand = {}; for (const i of inputs) on_hand[i.dataset.size] = Math.max(0, parseInt(i.value, 10) || 0);
  try { _renderTshirtOrder(await api(`/tournaments/${active.id}/tshirt-inventory`, { method: "PUT", body: JSON.stringify({ on_hand }) }));
        setMsg("tshirt-order-msg", "inventory saved", true); }
  catch (e) { setMsg("tshirt-order-msg", e.message, false); }
}
async function placeTshirtOrder() {
  if (!active) return;
  const already = _tshirtOrderState && _tshirtOrderState.ordered_at;
  const msg = already
    ? `Re-snapshot the t-shirt order with today's requested counts? (replaces the existing snapshot from ${already})`
    : "Place the t-shirt order? Today's requested counts will be saved as the order snapshot.";
  if (!(await confirmDialog(msg, already ? "Re-snapshot" : "Place order"))) return;
  try { _renderTshirtOrder(await api(`/tournaments/${active.id}/tshirt-order`, { method: "POST" }));
        setMsg("tshirt-order-msg", "order snapshotted", true); }
  catch (e) { setMsg("tshirt-order-msg", e.message, false); }
}
async function cancelTshirtOrder() {
  if (!active) return;
  if (!(await confirmDialog("Cancel the t-shirt order (clear date + snapshot)? Inventory stays."))) return;
  try {
    await api(`/tournaments/${active.id}/tshirt-order`, { method: "DELETE" });
    // Audit N21: clear the cached snapshot synchronously — otherwise a quick
    // "Cancel" → "Place" sequence within the same RAF reads the stale order.
    _tshirtOrderState = null;
    await loadTshirtOrder();
    setMsg("tshirt-order-msg", "order cancelled", true);
  } catch (e) { setMsg("tshirt-order-msg", e.message, false); }
}
document.getElementById("tshirt-order-save").addEventListener("click", saveTshirtInventory);
document.getElementById("tshirt-order-place").addEventListener("click", placeTshirtOrder);
document.getElementById("tshirt-order-cancel").addEventListener("click", cancelTshirtOrder);

// ---- B1: T-shirts by site (per-tournament) -------------------------------
// Pulls the grouped report from the API, renders one row per (site, division,
// size) with a quantity. Site filter narrows to one site; CSV mirrors the
// visible grid. Players in unassigned divisions show under "Unassigned".
let _tshirtBySiteRows = [];
async function loadTshirtsBySite() {
  if (!active) return;
  const tbody = document.querySelector("#tshirt-by-site-table tbody");
  const totals = document.getElementById("tshirt-by-site-totals");
  const status = document.getElementById("tshirt-by-site-status");
  if (!tbody) return;
  let rows;
  try { rows = await api(`/tournaments/${active.id}/tshirts-by-site`); }
  catch (e) { tbody.innerHTML = `<tr><td colspan="4" class="muted">${esc(e.message)}</td></tr>`; return; }
  _tshirtBySiteRows = rows;
  // Populate the site filter with the actual sites that appear (so the TD
  // doesn't see sites with zero shirts).
  const sel = document.getElementById("tshirt-by-site-filter");
  const sites = [...new Set(rows.map((r) => r.site_name))].sort();
  const prev = sel.value;
  sel.innerHTML = `<option value="">— all sites —</option>` +
    sites.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sel.value = sites.includes(prev) ? prev : "";
  _renderTshirtsBySite();
  status.textContent = rows.length ? `${rows.length} selected players with t-shirts` : "No selected players with a t-shirt size yet.";
}
function _renderTshirtsBySite() {
  const sel = document.getElementById("tshirt-by-site-filter").value;
  const tbody = document.querySelector("#tshirt-by-site-table tbody");
  // Bucket: site → division → size → count
  const counts = new Map();
  for (const r of _tshirtBySiteRows) {
    if (sel && r.site_name !== sel) continue;
    const key = `${r.site_name}\t${r.age_division || ""}\t${r.t_shirt_size}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const entries = [...counts.entries()].sort();  // tab-delimited keys sort by site, then div, then size
  tbody.innerHTML = entries.map(([k, n]) => {
    const [site, div, size] = k.split("\t");
    return `<tr><td>${esc(site)}</td><td>${esc(div)}</td><td>${esc(size)}</td><td class="num">${n}</td></tr>`;
  }).join("") || `<tr><td colspan="4" class="muted">Nothing to show for this site.</td></tr>`;
  const tot = [...counts.values()].reduce((a, b) => a + b, 0);
  document.getElementById("tshirt-by-site-totals").innerHTML =
    `<th colspan="3">Total shirts (filtered)</th><th class="num">${tot}</th>`;
}
document.getElementById("tshirt-by-site-filter").addEventListener("change", _renderTshirtsBySite);
document.getElementById("tshirt-by-site-csv").addEventListener("click", () => {
  const sel = document.getElementById("tshirt-by-site-filter").value;
  const filtered = sel ? _tshirtBySiteRows.filter((r) => r.site_name === sel) : _tshirtBySiteRows;
  const counts = new Map();
  for (const r of filtered) {
    const key = `${r.site_name}\t${r.age_division || ""}\t${r.t_shirt_size}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const matrix = [["Site", "Division", "Size", "Quantity"]];
  for (const [k, n] of [...counts.entries()].sort()) {
    const [site, div, size] = k.split("\t");
    matrix.push([site, div, size, n]);
  }
  _csvDownload(matrix, `tshirts-by-site-${active ? active.id : "t"}${sel ? "-" + sel.replace(/\W+/g, "_") : ""}`);
});

// --- Pairing avoidances (juniors; group of 2+ players) ---
const pairingForm = document.getElementById("pairing-form");
const pairingMembersBox = document.getElementById("pairing-members");
function pairingMemberRow() {
  const div = document.createElement("div"); div.className = "row pmember";
  const lbl = document.createElement("label"); lbl.textContent = "Player ";
  const sel = document.createElement("select"); sel.className = "pm-player player-ref";
  lbl.appendChild(sel); div.appendChild(lbl);
  const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "×";
  del.addEventListener("click", () => { div.remove(); if (!pairingMembersBox.children.length) pairingMemberRow(); });
  div.appendChild(del); pairingMembersBox.appendChild(div);
  fillPlayerRef(sel);     // reference the existing Players list
  enhanceSelect(sel);     // type-in searchable dropdown
}
function pairingReset() { pairingForm.reset(); pairingForm.source_email_id.value = ""; pairingMembersBox.innerHTML = ""; pairingMemberRow(); pairingMemberRow(); }
document.getElementById("pairing-add-member").addEventListener("click", pairingMemberRow);
const pairingGrid = makeListGrid("pairing-table", [
  { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell", editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }) },
  { title: "Relationship", field: "relationship", editor: "list", cssClass: "editable-cell",
    editorParams: { values: ["same_club", "siblings"] } },
  { title: "Players", field: "_players",
    formatter: (c) => esc((c.getData().members || []).map((m) => [m.last_name, m.first_name].filter(Boolean).join(", ") || m.usta_number).join(" & ")) },
], "pairing-avoidances", "No pairing avoidances yet.",
  async (g) => { if (!(await confirmDialog("Delete group?"))) return; try { await api(`/pairing-avoidances/${g.id}`, { method: "DELETE" }); loadPairing(); } catch (e) { setMsg("pairing-msg", e.message, false); } },
  undefined,
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const g = cell.getRow().getData();
    try {
      await api(`/pairing-avoidances/${g.id}`, { method: "PUT", body: JSON.stringify({
        age_division: g.age_division || null, relationship: g.relationship || null,
      }) });
      setMsg("pairing-msg", "saved", true); loadPairing();
    } catch (err) { setMsg("pairing-msg", err.message, false); try { cell.restoreOldValue(); } catch (_) {} loadPairing(); }
  },
  // Fifth-pass #2: wide-format columns matching importer.TYPES["pairing_avoidances"].
  // Emit up to 6 USTA #s + division + relationship so the CSV round-trips.
  [
    { header: "usta_1", key: "_u1", fmt: (r) => (r.members?.[0]?.usta_number) || "" },
    { header: "usta_2", key: "_u2", fmt: (r) => (r.members?.[1]?.usta_number) || "" },
    { header: "usta_3", key: "_u3", fmt: (r) => (r.members?.[2]?.usta_number) || "" },
    { header: "usta_4", key: "_u4", fmt: (r) => (r.members?.[3]?.usta_number) || "" },
    { header: "usta_5", key: "_u5", fmt: (r) => (r.members?.[4]?.usta_number) || "" },
    { header: "usta_6", key: "_u6", fmt: (r) => (r.members?.[5]?.usta_number) || "" },
    { header: "age_division", key: "age_division" },
    { header: "relationship", key: "relationship" },
    { header: "source_email_id", key: "source_email_id" },
  ]);
async function loadPairing() {
  if (!active) return;
  pairingGrid.setData(await api(`/tournaments/${active.id}/pairing-avoidances`));
}
onSubmit(pairingForm, async (e) => {
  if (!active) return;
  const members = [...pairingMembersBox.querySelectorAll(".pmember")].map((r) => {
    const p = playersById[r.querySelector(".pm-player").value];
    return p ? { usta_number: p.usta_number, first_name: p.first_name || null, last_name: p.last_name || null } : null;
  }).filter(Boolean);
  if (members.length < 2) { setMsg("pairing-msg", "select at least two players", false); return; }
  const body = {
    age_division: pairingForm.age_division.value || null,
    relationship: pairingForm.relationship.value,
    members,
    source_email_id: pairingForm.source_email_id.value ? Number(pairingForm.source_email_id.value) : null,
  };
  try { await api(`/tournaments/${active.id}/pairing-avoidances`, { method: "POST", body: JSON.stringify(body) }); setMsg("pairing-msg", "added", true); pairingReset(); loadPairing(); loadInbox(); }
  catch (err) { setMsg("pairing-msg", err.message, false); markInvalid(pairingForm, err.message); }
});
pairingForm.querySelector(".cancel").addEventListener("click", pairingReset);
pairingReset();

// --- Doubles pairing (mutual two-sided verification + random FIFO queue) ---
const doublesForm = document.getElementById("doubles-form");
function doublesSyncRandom() {
  document.getElementById("doubles-partner-wrap").style.display =
    document.getElementById("doubles-random").checked ? "none" : "";
}
document.getElementById("doubles-random").addEventListener("change", doublesSyncRandom);
function doublesReset() { doublesForm.reset(); doublesForm.source_email_id.value = ""; doublesSyncRandom(); }
const doublesReqGrid = makeListGrid("doubles-req-table", [
  { title: "Player", field: "last_name", formatter: _playerCell },
  { title: "USTA #", field: "usta_number" },
  { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell", editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }) },
  { title: "Type", field: "_type", formatter: (c) => chip(c.getData().wants_random ? "random" : "mutual") },
  { title: "Partner status", field: "_info",
    formatter: (c) => {
      const r = c.getData();
      if (r.status === "paired") return "paired";
      if (r.wants_random) return "queued (waiting)";
      // Show the partner's name (looked up by USTA #) instead of the raw code,
      // since the TD reads names, not USTA numbers, when scanning the queue.
      const partner = r.partner_usta ? Object.values(playersById).find((p) => p.usta_number === r.partner_usta) : null;
      const label = partner ? [partner.last_name, partner.first_name].filter(Boolean).join(", ") || partner.usta_number : (r.partner_usta || "?");
      return `→ ${esc(label)} (awaiting partner)`;
    } },
], "doubles-requests", "No doubles requests yet.",
  async (r) => { if (!(await confirmDialog("Delete request?"))) return; try { await api(`/doubles-requests/${r.id}`, { method: "DELETE" }); loadDoubles(); } catch (e) { setMsg("doubles-msg", e.message, false); } },
  undefined,
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const r = cell.getRow().getData();
    try { await api(`/doubles-requests/${r.id}`, { method: "PUT", body: JSON.stringify({ age_division: r.age_division || null }) }); setMsg("doubles-msg", "saved", true); loadDoubles(); }
    catch (e) { setMsg("doubles-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadDoubles(); }
  },
  // Fifth-pass #2: re-importable columns for doubles requests.
  [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" },
    { header: "last_name", key: "last_name" },
    { header: "age_division", key: "age_division" },
    { header: "wants_random", key: "wants_random" },
    { header: "partner_usta", key: "partner_usta" },
    { header: "source_email_id", key: "source_email_id" },
  ]);
const doublesPairGrid = makeListGrid("doubles-pair-table", [
  { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell", editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }) },
  { title: "Type", field: "pairing_type", formatter: (c) => chip(c.getData().pairing_type) },
  { title: "Player 1", field: "player1" },
  { title: "Player 2", field: "player2" },
], "doubles-pairs", "No verified pairs yet.",
  async (d) => { if (!(await confirmDialog("Delete pair?"))) return; try { await api(`/doubles-pairs/${d.id}`, { method: "DELETE" }); loadDoubles(); } catch (e) { setMsg("doubles-msg", e.message, false); } },
  undefined,
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const d = cell.getRow().getData();
    try { await api(`/doubles-pairs/${d.id}`, { method: "PUT", body: JSON.stringify({ age_division: d.age_division || null }) }); setMsg("doubles-msg", "saved", true); loadDoubles(); }
    catch (e) { setMsg("doubles-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadDoubles(); }
  },
  // Fifth-pass #2: pairs are derived (no importer), but emit a snake_case
  // CSV anyway so downstream tooling has stable headers; no source_email_id
  // (pairs aren't filed individually).
  [
    { header: "age_division", key: "age_division" },
    { header: "pairing_type", key: "pairing_type" },
    { header: "player1", key: "player1" },
    { header: "player2", key: "player2" },
    { header: "verified", key: "verified" },
  ]);
async function loadDoubles() {
  if (!active) return;
  const data = await api(`/tournaments/${active.id}/doubles`);
  doublesReqGrid.setData(data.requests);
  doublesPairGrid.setData(data.pairs);
}
onSubmit(doublesForm, async (e) => {
  if (!active) return;
  const me = playersById[doublesForm.player_ref.value];
  if (!me) { setMsg("doubles-msg", "select a player", false); return; }
  const partner = doublesForm.partner_ref.value ? playersById[doublesForm.partner_ref.value] : null;
  const b = {
    usta_number: me.usta_number,
    first_name: me.first_name || null,
    last_name: me.last_name || null,
    age_division: doublesForm.age_division.value.trim() || null,
    wants_random: doublesForm.wants_random.checked,
    partner_usta: partner ? partner.usta_number : null,
    source_email_id: doublesForm.source_email_id.value ? Number(doublesForm.source_email_id.value) : null,
  };
  try {
    const res = await api(`/tournaments/${active.id}/doubles-requests`, { method: "POST", body: JSON.stringify(b) });
    setMsg("doubles-msg", res.paired ? "paired!" : (b.wants_random ? "queued" : "filed — awaiting partner"), true);
    doublesReset(); loadDoubles(); loadInbox();
  } catch (err) { setMsg("doubles-msg", err.message, false); markInvalid(doublesForm, err.message); }
});
doublesForm.querySelector(".cancel").addEventListener("click", doublesReset);

// --- Reports (officials confirmation + pay/mileage) ---
let reportData = null;
function money(n) { return n == null ? "—" : "$" + Number(n).toFixed(2); }
async function loadReports() {
  if (!active) return;
  reportData = await api(`/tournaments/${active.id}/reports/officials`);
  const t = reportData.tournament, totals = reportData.totals;
  const rule = reportData.officials.find((o) => o.rule_version);
  document.getElementById("report-meta").textContent =
    `${t.type} · ${t.play_start_date} → ${t.play_end_date} · ${totals.official_count} official(s)` +
    (rule ? ` · pay rule ${rule.rule_version}` : "");
  // TD "Staffing Plan" layout: flat roster with a weekday X column per play day.
  const cols = _reportColumns(t);
  document.querySelector("#report-table thead").innerHTML =
    "<tr><th>Name</th><th>Position</th><th>Dietary</th><th>Hotel?</th>" +
    "<th>Check-in</th><th>Check-out</th>" +
    cols.map((c) => `<th class="daycol">${esc(c.head)}</th>`).join("") +
    '<th class="num">Pay</th><th class="num">Mileage</th></tr>';
  const tbody = document.querySelector("#report-table tbody");
  tbody.innerHTML = "";
  for (const o of reportData.officials) {
    const worked = new Set(o.days.map((d) => d.work_date));
    const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
    const flags = [
      o.has_conflict ? "double-booked" : "",
      o.missing_distance ? "no distance" : "",
      o.hotel_date_mismatch ? "hotel dates" : "",
      o.work_date_out_of_window ? "off-window day" : "",
    ].filter(Boolean);
    const warn = flags.length ? ` <span class="warn" title="${esc(flags.join(", "))}">⚠</span>` : "";
    const dayCells = cols.map((c) => `<td class="daycol">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${esc(o.official_name)}${warn}</td><td>${esc(roles)}</td>` +
      `<td>${esc(o.dietary_restrictions)}</td><td>${o.hotel_name ? "Yes" : "No"}</td>` +
      `<td>${esc(_fmtMDY(o.check_in))}</td><td>${esc(_fmtMDY(o.check_out))}</td>` +
      dayCells +
      `<td class="num">${money(o.pay)}</td><td class="num">${money(o.mileage)}</td>`;
    tbody.appendChild(tr);
  }
  const lead = 6 + cols.length;  // columns before Pay
  if (reportData.officials.length === 0)
    tbody.innerHTML = `<tr><td class="empty" colspan="${lead + 2}">No officials assigned yet.</td></tr>`;
  const note = (totals.conflict_count ? ` · ${totals.conflict_count} double-booked` : "") +
    (totals.missing_distance_count ? ` · ${totals.missing_distance_count} missing distance` : "") +
    (totals.hotel_mismatch_count ? ` · ${totals.hotel_mismatch_count} hotel-date alert(s)` : "") +
    (totals.out_of_window_count ? ` · ${totals.out_of_window_count} off-window day alert(s)` : "");
  document.getElementById("report-totals").innerHTML =
    `<th colspan="${lead}">Totals${note}</th><th class="num">${money(totals.pay)}</th>` +
    `<th class="num">${money(totals.mileage)}</th>`;

  // Officials needing accommodation: those with a hotel assignment, with the
  // span of days they work (the nights they need a room).
  const lodge = document.querySelector("#lodging-table tbody");
  const housed = reportData.officials.filter((o) => o.hotel_name);
  lodge.innerHTML = housed.length
    ? housed.map((o) => {
        const ds = o.days.map((d) => d.work_date).sort();
        const span = ds.length ? `${fmtDOW(ds[0])} – ${fmtDOW(ds[ds.length - 1])}` : "—";
        return `<tr><td>${esc(o.official_name)}</td><td>${esc(o.hotel_name)}</td><td>${esc(span)}</td></tr>`;
      }).join("")
    : '<tr><td class="empty" colspan="3">No officials have a hotel assignment yet.</td></tr>';

  // Non-official support staff (Site Director, Trainer, …), grouped by role,
  // with the same weekday day-grid the officials roster uses.
  const staff = reportData.staff || [];
  const scols = _reportColumns(reportData.tournament);
  document.querySelector("#report-staff-table thead").innerHTML =
    "<tr><th>Name</th><th>Role</th>" +
    scols.map((c) => `<th class="daycol">${esc(c.head)}</th>`).join("") +
    "<th>Phone</th><th>Notes</th></tr>";
  const staffBody = document.querySelector("#report-staff-table tbody");
  staffBody.innerHTML = staff.length
    ? staff.map((s) => {
        const worked = new Set(s.days || []);
        const dayCells = scols.map((c) => `<td class="daycol">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
        return `<tr><td>${esc(s.name)}</td><td>${esc(STAFF_ROLES[s.role] || s.role)}</td>${dayCells}` +
          `<td>${esc(s.phone || "")}</td><td>${esc(s.notes || "")}</td></tr>`;
      }).join("")
    : `<tr><td class="empty" colspan="${scols.length + 4}">No non-official staff added for this tournament.</td></tr>`;
}
// Weekday columns for the tournament's play window (TD staffing-plan format).
function _reportColumns(t) {
  return _datesInRange(t.play_start_date, t.play_end_date).map((d) => ({ date: d, head: _dowLong(d) }));
}
// _dowLong / _fmtMDY now imported from ./app/util.js (A47).
// Build the staffing-plan rows (header always; data rows when includeData).
function _reportMatrix(includeData) {
  const cols = _reportColumns(reportData.tournament);
  const header = ["Name", "Position", "Dietary", "Hotel?", "Check-in", "Check-out",
    ...cols.map((c) => c.head), "Pay", "Mileage"];
  const rows = [header];
  if (includeData) {
    for (const o of reportData.officials) {
      const worked = new Set(o.days.map((d) => d.work_date));
      const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
      rows.push([
        o.official_name, roles, o.dietary_restrictions || "", o.hotel_name ? "Yes" : "No",
        _fmtMDY(o.check_in), _fmtMDY(o.check_out),
        ...cols.map((c) => (worked.has(c.date) ? "X" : "")),
        o.pay, o.mileage == null ? "" : o.mileage,
      ]);
    }
    const tt = reportData.totals;
    rows.push(["Totals", "", "", "", "", "", ...cols.map(() => ""), tt.pay, tt.mileage]);
  }
  return rows;
}
document.getElementById("report-print").addEventListener("click", () => window.print());
async function reportCsvExport() {
  if (!active) { toast("Select a tournament first", false); return; }
  await loadReports();
  if (reportData) _csvDownload(_reportMatrix(true), `staffing-plan-${(active.name || "").replace(/\s+/g, "_")}`);
}
async function reportTemplateExport() {
  if (!active) { toast("Select a tournament first", false); return; }
  await loadReports();
  if (reportData) _csvDownload(_reportMatrix(false), "staffing-plan-template");
}

// =================== Setup entity configs ===================
// Audit M33: removed the form-detail "Work on this →" button — the per-row
// rowAction button (below) is more discoverable and does the same thing.

const tournamentsCrud = wireEntity({
  path: "/tournaments", singular: "tournament", panelId: "panel-tournaments", formId: "tournament-form", msgId: "tournament-msg",
  columns: [{ key: "id" }, { key: "name", edit: { editor: "input" } },
    { key: "type", edit: { editor: "list", params: { values: ["junior", "adult"] } } }],
  exportCols: [
    { header: "name", key: "name" },
    { header: "type", key: "type" },
    { header: "play_start_date", key: "play_start_date" },
    { header: "play_end_date", key: "play_end_date" },
    { header: "registration_deadline", key: "registration_deadline" },
    { header: "late_entry_deadline", key: "late_entry_deadline" },
  ],
  onLoad: (rows) => {
    for (const k in tournamentsById) delete tournamentsById[k];
    rows.forEach((t) => (tournamentsById[t.id] = t));
    fillActiveSelect(rows);
    if (active && tournamentsById[active.id]) { active = tournamentsById[active.id]; updateActiveUI(); }
  },
  onSelect: (t) => { lastSelectedTournamentId = t.id; },
  onNew: () => { lastSelectedTournamentId = null; },
  // "Open ▸" right on the row: jump straight into the workspace for that tournament.
  rowAction: (t) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn-link"; b.textContent = "Open ▸";
    b.title = "Make this the active tournament and open its workspace";
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setActive(t.id);
      activateGroup("tournament");
      document.querySelector('.tab[data-target="panel-t-sites"]').click();
    });
    return b;
  },
});

const sitesCrud = wireEntity({
  path: "/sites", singular: "site", panelId: "panel-sites", formId: "site-form", msgId: "site-msg",
  columns: [{ key: "id" }, { key: "code", edit: { editor: "input" } },
    { key: "name", edit: { editor: "input" } }, { key: "city", edit: { editor: "input" } }],
  exportCols: [
    { header: "code", key: "code" }, { header: "name", key: "name" },
    { header: "street", key: "street" }, { header: "city", key: "city" },
    { header: "state", key: "state" }, { header: "zip", key: "zip" },
    { header: "lat", key: "lat" }, { header: "lng", key: "lng" },
  ],
  onLoad: (rows) => { for (const k in sitesById) delete sitesById[k]; rows.forEach((s) => (sitesById[s.id] = s)); refreshAllSelects(); if (active) renderTSites(); },
});
let certOfficialId = null;
async function loadCerts(id) {
  certOfficialId = id;
  const box = document.getElementById("official-certs");
  box.hidden = false;
  const chips = document.getElementById("cert-chips");
  const certs = await api(`/officials/${id}/certifications`);
  chips.innerHTML = "";
  if (!certs.length) chips.innerHTML = '<span class="muted">none on file</span>';
  for (const c of certs) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = c.cert_type + " ";
    const x = document.createElement("button");
    x.type = "button"; x.className = "chip-x"; x.textContent = "×";
    x.addEventListener("click", async () => {
      try { await api(`/certifications/${c.id}`, { method: "DELETE" }); loadCerts(id); }
      catch (e) { setMsg("cert-msg", e.message, false); }
    });
    chip.appendChild(x); chips.appendChild(chip);
  }
}
document.getElementById("cert-add-btn").addEventListener("click", async () => {
  if (!certOfficialId) return;
  try {
    await api(`/officials/${certOfficialId}/certifications`, {
      method: "POST", body: JSON.stringify({ cert_type: document.getElementById("cert-type").value }),
    });
    loadCerts(certOfficialId);
  } catch (e) { setMsg("cert-msg", e.message, false); }
});

const officialsCrud = wireEntity({
  path: "/officials", singular: "official", panelId: "panel-officials", formId: "official-form", msgId: "official-msg",
  columns: [{ key: "id" }, { key: "name", fmt: officialLabel }, { key: "loc", fmt: (o) => [o.city, o.state].filter(Boolean).join(", ") }],
  exportCols: [
    { header: "first_name", key: "first_name" }, { header: "last_name", key: "last_name" },
    { header: "street", key: "street" }, { header: "city", key: "city" },
    { header: "state", key: "state" }, { header: "zip", key: "zip" },
    { header: "phone", key: "phone" }, { header: "email", key: "email" },
    { header: "dietary_restrictions", key: "dietary_restrictions" },
    { header: "lat", key: "lat" }, { header: "lng", key: "lng" },
  ],
  onLoad: (rows) => { for (const k in officialsById) delete officialsById[k]; rows.forEach((o) => (officialsById[o.id] = o)); refreshAllSelects(); },
  onSelect: (o) => {
    loadCerts(o.id);
    document.getElementById("official-account").hidden = false;
    document.getElementById("acct-user").value = "";
    document.getElementById("acct-pass").value = "";
  },
  onNew: () => {
    certOfficialId = null;
    document.getElementById("official-certs").hidden = true;
    document.getElementById("official-account").hidden = true;
  },
});
const phHistGrid = makeReadGrid("player-history-table", [
  { title: "When", field: "_when", headerSort: false,
    formatter: (c) => { const h = c.getData(); return esc((h.valid_from || "").slice(0, 10) + " → " + (h.valid_to || "").slice(0, 10)); } },
  { title: "Name", field: "last_name", formatter: _playerCell },
  { title: "USTA #", field: "usta_number" },
  { title: "Change", field: "change_type" },
], null, "No prior versions — this is the original record.", { maxHeight: "30vh" });
async function loadPlayerHistory(id) {
  const box = document.getElementById("player-history");
  box.hidden = false;
  try {
    phHistGrid.setData(await api(`/players/${id}/history`));
  } catch (e) { phHistGrid.setData([]); setMsg("player-msg", e.message, false); }
  // the box was hidden at build time; lay the grid out now that it's visible
  requestAnimationFrame(() => { try { phHistGrid.grid.redraw(true); } catch (_) {} });
}

const playersCrud = wireEntity({
  path: "/players", singular: "player", panelId: "panel-players", formId: "player-form", msgId: "player-msg",
  optimisticConcurrency: true,  // audit M19/M8: send X-If-Updated-At on PUT
  columns: [
    { key: "id" },
    { key: "usta_number", edit: { editor: "input" } },
    { key: "name", fmt: (p) => [p.first_name, p.last_name].filter(Boolean).join(" ") },
    { key: "gender", fmt: (p) => p.gender === "male" ? "Male" : p.gender === "female" ? "Female" : "—",
      edit: { editor: "list", params: { values: [{ label: "Male", value: "male" }, { label: "Female", value: "female" }] } } },
  ],
  exportCols: [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" }, { header: "last_name", key: "last_name" },
    { header: "gender", key: "gender" }, { header: "birthdate", key: "birthdate" },
    { header: "city", key: "city" }, { header: "state", key: "state" },
  ],
  onLoad: (rows) => { for (const k in playersById) delete playersById[k]; rows.forEach((p) => (playersById[p.id] = p)); refreshAllSelects(); },
  onSelect: (p) => loadPlayerHistory(p.id),
  onNew: () => { document.getElementById("player-history").hidden = true; },
});
const ratesCrud = wireEntity({
  path: "/rates", singular: "rate", panelId: "panel-rates", formId: "rate-form", msgId: "rate-msg",
  columns: [{ key: "id" },
    { key: "cert_type", edit: { editor: "list", params: { values: ["roving_official", "chair_umpire", "tournament_referee", "deputy_referee", "referee_in_training"] } } },
    { key: "rate_per_day", hozAlign: "right", fmt: (r) => "$" + Number(r.rate_per_day).toFixed(2), edit: { editor: "number", params: { min: 0, step: 0.01 } } },
    { key: "effective_from", edit: { editor: "date" } }],
  exportCols: [
    { header: "cert_type", key: "cert_type" },
    { header: "rate_per_day", key: "rate_per_day" },
    { header: "effective_from", key: "effective_from" },
  ],
  transform: (o) => { o.rate_per_day = Number(o.rate_per_day); if (o.effective_from == null) delete o.effective_from; return o; },
});
const hotelsCrud = wireEntity({
  path: "/hotels", singular: "hotel", panelId: "panel-hotels", formId: "hotel-form", msgId: "hotel-msg",
  columns: [{ key: "id" }, { key: "name", edit: { editor: "input" } }, { key: "city", edit: { editor: "input" } }],
  exportCols: [
    { header: "name", key: "name" }, { header: "website", key: "website" },
    { header: "street", key: "street" }, { header: "city", key: "city" },
    { header: "state", key: "state" }, { header: "zip", key: "zip" },
    { header: "phone", key: "phone" },
  ],
  onLoad: (rows) => { for (const k in hotelsById) delete hotelsById[k]; rows.forEach((h) => (hotelsById[h.id] = h)); refreshAllSelects(); },
});
const distancesCrud = wireEntity({
  path: "/distances", singular: "distance", panelId: "panel-distances", formId: "distance-form", msgId: "distance-msg",
  columns: [
    { key: "id" },
    { key: "official", fmt: (d) => (officialsById[d.official_id] ? officialLabel(officialsById[d.official_id]) : d.official_id) },
    { key: "site", fmt: (d) => (sitesById[d.site_id] ? siteLabel(sitesById[d.site_id]) : d.site_id) },
    { key: "one_way_miles", hozAlign: "right", width: 110, edit: { editor: "number", params: { min: 0, step: 0.1 } } },
  ],
  // Distances export resolves the FK ids to human labels so the spreadsheet is
  // usable on its own (re-import would need a matching tool to map back).
  exportCols: [
    { header: "official_id", key: "official_id" },
    { header: "official", fmt: (d) => officialsById[d.official_id] ? officialLabel(officialsById[d.official_id]) : "" },
    { header: "site_id", key: "site_id" },
    { header: "site", fmt: (d) => sitesById[d.site_id] ? siteLabel(sitesById[d.site_id]) : "" },
    { header: "one_way_miles", key: "one_way_miles" },
    { header: "source", key: "source" },
  ],
  transform: (o) => { o.official_id = Number(o.official_id); o.site_id = Number(o.site_id); o.one_way_miles = Number(o.one_way_miles); return o; },
});
// Auto-distance: estimate one-way miles from the official's + site's coordinates
// (great-circle × road factor — a key-free fallback, source='geocoded'). It
// upserts the row immediately, so we refresh the list and reset the form; the
// estimate is editable and clearly flagged geocoded for the TD to review.
document.getElementById("dist-estimate").addEventListener("click", async () => {
  const f = document.getElementById("distance-form");
  const oid = f.official_id.value, sid = f.site_id.value;
  if (!oid || !sid) { setMsg("distance-msg", "pick an official and a site first", false); return; }
  try {
    const res = await api("/distances/auto", { method: "POST",
      body: JSON.stringify({ official_id: Number(oid), site_id: Number(sid) }) });
    distancesCrud.refresh();
    f.reset(); if (typeof syncCombos === "function") syncCombos();
    toast(`Estimated ${res.one_way_miles} mi (great-circle — review before it drives pay)`, true);
  } catch (e) { setMsg("distance-msg", e.message, false); }
});

// Setup → Divisions catalog (rows back the form datalists; gender = null means
// the row applies to both genders, e.g. Combo doubles).
const divisionsCrud = wireEntity({
  path: "/divisions", singular: "division", panelId: "panel-divisions", formId: "division-form", msgId: "division-msg",
  columns: [
    { key: "id" },
    { key: "code", edit: { editor: "input" } },
    { key: "label", edit: { editor: "input" } },
    { key: "tournament_type",
      edit: { editor: "list", params: { values: ["junior", "adult"] } } },
    { key: "gender", fmt: (d) => d.gender || "any",
      edit: { editor: "list", params: { values: [{label:"any", value:""}, {label:"male", value:"male"}, {label:"female", value:"female"}] } } },
    { key: "sort_order", hozAlign: "right", width: 80,
      edit: { editor: "number", params: { min: 0, step: 10 } } },
  ],
  exportCols: [
    { header: "code", key: "code" }, { header: "label", key: "label" },
    { header: "tournament_type", key: "tournament_type" },
    { header: "gender", key: "gender" }, { header: "sort_order", key: "sort_order" },
  ],
  transform: (o) => { o.sort_order = Number(o.sort_order) || 0; if (!o.gender) o.gender = null; return o; },
  onLoad: (rows) => { divisionsAll = rows.slice(); refreshDivisionLists(); },
});

// Setup → Events catalog (Singles/Doubles for juniors; Men's/Women's/Mixed
// Singles/Doubles for adults — gender = null means "any").
const eventsCrud = wireEntity({
  path: "/events", singular: "event", panelId: "panel-events", formId: "event-form", msgId: "event-msg",
  columns: [
    { key: "id" },
    { key: "name", edit: { editor: "input" } },
    { key: "tournament_type",
      edit: { editor: "list", params: { values: ["junior", "adult"] } } },
    { key: "gender", fmt: (e) => e.gender || "any",
      edit: { editor: "list", params: { values: [{label:"any", value:""}, {label:"male", value:"male"}, {label:"female", value:"female"}] } } },
    { key: "sort_order", hozAlign: "right", width: 80,
      edit: { editor: "number", params: { min: 0, step: 10 } } },
  ],
  exportCols: [
    { header: "name", key: "name" },
    { header: "tournament_type", key: "tournament_type" },
    { header: "gender", key: "gender" }, { header: "sort_order", key: "sort_order" },
  ],
  transform: (o) => { o.sort_order = Number(o.sort_order) || 0; if (!o.gender) o.gender = null; return o; },
  onLoad: (rows) => { eventsAll = rows.slice(); refreshDivisionLists(); },
});

// =================== Generic CSV export for list tables ===================
// _csvDownload now imported from ./app/util.js (audit A47).
// Visible column headers (skipping the trailing actions/blank column).
function _visibleHeaders(table) {
  const ths = [...table.querySelectorAll("thead th")];
  const keep = ths.map((th) => th.textContent.trim() !== "");
  return { keep, headers: ths.filter((_, i) => keep[i]).map((th) => th.textContent.trim()) };
}
function exportTable(table, name) {
  const { keep, headers } = _visibleHeaders(table);
  const rows = [...table.querySelectorAll("tbody tr")]
    .filter((tr) => !tr.querySelector(".empty"))
    .map((tr) => [...tr.children].filter((_, i) => keep[i]).map((td) => td.textContent.replace(/\s+/g, " ").trim()));
  _csvDownload([headers, ...rows], name);
}
// --- Per-page CSV export for the remaining hand-built tables ---
// Every list/summary is now a Tabulator grid with its own native ⬇ CSV; only the
// Inbox (interactive per-row controls) stays a plain table and scrapes for CSV.
const EXPORTABLE = {
  "inbox-table": "inbox",
};
for (const [id, name] of Object.entries(EXPORTABLE)) {
  const table = document.getElementById(id);
  if (!table) continue;
  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "export-btn no-print"; btn.textContent = "⬇ CSV";
  btn.addEventListener("click", () => exportTable(table, name));
  const anchor = table.closest(".tbl-scroll") || table;  // keep the button outside the scroller
  anchor.parentNode.insertBefore(btn, anchor);
}
// Bespoke per-page exports (data isn't a plain table scrape).
document.getElementById("roster-csv").addEventListener("click", () => rosterGrid.download("csv", "roster.csv"));
document.getElementById("roster-signin-csv").addEventListener("click", rosterSignInExport);
// Import/export #5: wire the previously-orphan template helper.
document.getElementById("roster-signin-template").addEventListener("click", rosterSignInTemplate);
document.getElementById("tshirt-order-csv").addEventListener("click", tshirtOrderExport);
document.getElementById("report-csv").addEventListener("click", reportCsvExport);
// Design-crit pass 6: wire the previously-orphan reportTemplateExport.
document.getElementById("report-template").addEventListener("click", reportTemplateExport);

// =================== Workspace add-forms as modal overlays (grid stays primary) ===================
// Each add-form becomes a centered modal opened by a "＋ Add X" button; the grid
// owns the page. Closing is driven by the form's `reset` event — every submit
// handler resets on success and the Cancel button resets too, so success and
// cancel both close the overlay while a validation error keeps it open.
const FORM_MODALS = {
  "withdrawal-form": "Add withdrawal",
  "sched-form": "Add scheduling avoidance", "divflex-form": "Add division flexibility",
  "pairing-form": "Add pairing group", "doubles-form": "File doubles request",
  "photel-form": "Add player hotel", "late-form": "Add late entry", "trb-form": "Add room block",
  "asg-form": "Assign official", "email-form": "Add email",
};
for (const [id, label] of Object.entries(FORM_MODALS)) {
  const form = document.getElementById(id);
  if (!form || form.closest(".detail-pane")) continue;
  const trigger = document.createElement("button");
  trigger.type = "button"; trigger.className = "new-btn add-trigger"; trigger.textContent = "＋ " + label;
  const modal = document.createElement("div"); modal.className = "detail-pane form-modal";
  const close = document.createElement("button"); close.type = "button"; close.className = "detail-close"; close.textContent = "×"; close.title = "Close";
  const heading = document.createElement("h3"); heading.className = "detail-title"; heading.textContent = label;
  form.parentNode.insertBefore(trigger, form);
  form.parentNode.insertBefore(modal, form);
  modal.append(close, heading, form);
  const openM = () => { modal.classList.add("detail-open"); _detailBackdrop.classList.add("show"); _closeOpenDetail = closeM; scheduleComboSync(); };
  const closeM = () => {
    modal.classList.remove("detail-open"); _detailBackdrop.classList.remove("show"); _closeOpenDetail = null;
    // If this open was a file-from-email flow, return to the Inbox so the user
    // can process the next email without an extra trip back.
    if (form._wasFiling) {
      form._wasFiling = false;
      const inboxTab = document.querySelector('.tab[data-target="panel-t-inbox"]');
      if (inboxTab) inboxTab.click();
    }
  };
  trigger.addEventListener("click", () => { form._wasFiling = false; openM(); });
  close.addEventListener("click", closeM);
  form.addEventListener("reset", closeM);  // success path and Cancel both reset → close
  form._openModal = openM;                  // openForm() (file-from-email) opens it
}

// Promote every detail-pane to a proper ARIA dialog (role + aria-modal +
// aria-labelledby) and watch the `detail-open` class to focus the first input
// on open and restore focus on close. One pass at load — no per-site changes.
// Design-crit pass 7 #2: focus-trap by marking the rest of the document
// `inert` while any .detail-open dialog is visible. `inert` removes focus
// + click + screen-reader access from the subtree.
//
// SUBTLETY: every `.detail-pane` lives inside its `<section class="panel">`,
// which lives inside `<main>`. If we inert `<main>` wholesale, the dialog
// (a child of main) becomes uninteractable too. Solution: at first use,
// hoist every .detail-pane to be a direct child of <body>. They're already
// `position: fixed` so visual layout doesn't shift, but DOM-wise they're
// now siblings of main rather than descendants — main-inert no longer
// inherits into them.
let _detailPanesHoisted = false;
function _hoistDetailPanes() {
  if (_detailPanesHoisted) return;
  for (const dlg of document.querySelectorAll(".detail-pane")) {
    document.body.appendChild(dlg);  // appendChild moves the existing node
  }
  _detailPanesHoisted = true;
}
function _setBackgroundInert(on) {
  if (on) _hoistDetailPanes();
  for (const el of [document.querySelector("header"),
                    document.querySelector("nav.menu-l1"),
                    document.querySelector("nav.menu"),
                    document.querySelector("main")]) {
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

// Confirm modal toggles via `hidden`, not class — observe that too.
new MutationObserver(_refreshBackgroundInert).observe(
  document.getElementById("confirm-modal"),
  { attributes: true, attributeFilter: ["hidden"] },
);

(function _enhanceDetailDialogs() {
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName !== "class") continue;
      const dlg = m.target;
      const opening = dlg.classList.contains("detail-open");
      const wasOpen = m.oldValue && m.oldValue.split(/\s+/).includes("detail-open");
      _refreshBackgroundInert();
      if (opening && !wasOpen) {
        // Audit P44: snapshot both the DOM node and the row id (if any) — when
        // the dialog closes and the grid has been re-rendered, the original
        // node is gone; falling back to a selector by row id lets focus land
        // on the same logical record instead of body.
        const a = document.activeElement;
        const row = a && a.closest && a.closest(".tabulator-row[data-id]");
        dlg._prevFocus = a;
        dlg._prevRowId = row ? row.getAttribute("data-id") : null;
        requestAnimationFrame(() => {
          const f = dlg.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
            || dlg.querySelector('button:not([disabled])');
          if (f) try { f.focus(); } catch (_) {}
        });
      } else if (!opening && wasOpen) {
        const prev = dlg._prevFocus;
        if (prev && prev.isConnected && typeof prev.focus === "function") {
          try { prev.focus(); } catch (_) {}
        } else if (dlg._prevRowId) {
          const restored = document.querySelector(`.tabulator-row[data-id="${dlg._prevRowId}"]`);
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
})();

// Give every workspace list table its own scrollbar (like the Setup lists), so a
// long roster/inbox scrolls within the card instead of the whole page. Runs after
// the export buttons are inserted so they stay outside the scroll container.
for (const table of document.querySelectorAll(".tpanel table.list-table")) {
  if (table.closest(".list-scroll, .tbl-scroll")) continue;
  const wrap = document.createElement("div");
  wrap.className = "tbl-scroll";
  table.parentNode.insertBefore(wrap, table);
  wrap.appendChild(table);
}

// =================== Auth + role-based views ===================
let adminLoaded = false;
async function adminInit() {
  if (adminLoaded) return;
  adminLoaded = true;
  // Audit M28/M29: populate every <select data-enum="…"> from /api/enums so
  // there's one source of truth for cert / gender / status / shirt options.
  // Audit F23: also seed the JS-side cert label map from the same payload so
  // certLabel() never drifts from what the dropdowns show.
  try {
    const enums = await api("/enums");
    _populateEnumSelects(enums);
    if (Array.isArray(enums.cert_type)) {
      CERTS = enums.cert_type.map((c) => [c.value, c.label]);
      CERT_LABEL = Object.fromEntries(CERTS);
    }
  } catch (_) {}
  for (const c of [sitesCrud, officialsCrud, playersCrud, hotelsCrud, ratesCrud, distancesCrud, divisionsCrud, eventsCrud, tournamentsCrud]) {
    try { await c.refresh(); } catch (e) { /* health pill surfaces DB issues */ }
  }
  const saved = localStorage.getItem("activeTid");
  if (saved && tournamentsById[saved]) setActive(saved);
  else updateActiveUI();
}
function _populateEnumSelects(enums) {
  for (const sel of document.querySelectorAll("select[data-enum]")) {
    const key = sel.getAttribute("data-enum");
    const values = enums[key] || [];
    const frag = document.createDocumentFragment();
    for (const v of values) {
      const o = document.createElement("option");
      if (typeof v === "string") { o.value = v; o.textContent = v; }
      else { o.value = v.value; o.textContent = v.label; }
      frag.appendChild(o);
    }
    sel.replaceChildren(frag);
  }
}

let meTournaments = [];
async function officialInit() {
  const me = await api("/me");
  const o = me.official || {};
  for (const el of document.getElementById("me-form").elements) {
    if (el.name) el.value = o[el.name] == null ? "" : o[el.name];
  }
  meTournaments = await api("/me/tournaments");
  const sel = document.getElementById("me-tournament");
  sel.innerHTML = "";
  for (const t of meTournaments) {
    const op = document.createElement("option");
    op.value = t.id; op.textContent = `${t.name} (${t.play_start_date} → ${t.play_end_date})`;
    sel.appendChild(op);
  }
  await loadMyAvailability();
}
async function loadMyAvailability() {
  const sel = document.getElementById("me-tournament");
  const box = document.getElementById("me-dates");
  if (!sel.value) { box.innerHTML = ""; return; }
  const t = meTournaments.find((x) => String(x.id) === sel.value);
  const av = await api(`/me/availability/${sel.value}`);
  document.getElementById("me-hotel").checked = !!av.hotel_needed;
  const checked = new Set(av.dates || []);
  box.innerHTML = "";
  for (const d of _datesInRange(t.play_start_date, t.play_end_date)) {
    const lbl = document.createElement("label"); lbl.className = "chip";
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = d; cb.checked = checked.has(d);
    lbl.append(cb, document.createTextNode(" " + fmtDOW(d)));
    box.appendChild(lbl);
  }
}

// Audit F3: one-shot listener so a stray flood of expired-session 401s
// doesn't trigger a toast storm.
let _authExpiredFired = false;
document.addEventListener("auth-expired", () => {
  if (_authExpiredFired) return;
  _authExpiredFired = true;
  toast("Session expired — please sign in again", false);
  applyAuth(null);
  setTimeout(() => { _authExpiredFired = false; }, 1000);
});

function applyAuth(who) {
  const logged = !!who;
  const isAdmin = logged && who.role === "admin";
  const isOfficial = logged && who.role === "official";
  document.getElementById("login-view").hidden = logged;
  document.getElementById("user-box").hidden = !logged;
  document.getElementById("username-label").textContent = who ? `${who.username} (${who.role})` : "";
  document.getElementById("menu").hidden = !isAdmin;
  document.getElementById("menu-groups").hidden = !isAdmin;
  document.querySelector("main:not(#official-app)").hidden = !isAdmin;
  document.getElementById("context-bar").hidden = !isAdmin;
  // Hide the breadcrumb strip when not signed in as admin; clear stale crumbs
  // on sign-out so a fresh session starts with a clean trail. When the user
  // becomes admin (first login OR session restore), seed the trail with the
  // currently active tab so the strip isn't empty until they click something.
  if (!isAdmin) {
    _navHistory = [];
  } else if (_navHistory.length === 0) {
    const activeTab = document.querySelector(".tab.active");
    const grp = activeTab ? activeTab.closest(".menu-group") : null;
    if (activeTab && grp) {
      _navHistory = [{ group: grp.dataset.group, panel: activeTab.dataset.target }];
    }
  }
  if (typeof _renderCrumbs === "function") _renderCrumbs();
  document.getElementById("official-app").hidden = !isOfficial;
  if (isAdmin) adminInit();
  if (isOfficial) officialInit();
}

onSubmit(document.getElementById("login-form"), async (e) => {
  const f = e.target;
  try {
    const who = await api("/auth/login", { method: "POST", body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
    f.reset();
    applyAuth(who);
  } catch (err) { setMsg("login-msg", err.message, false); }
});
document.getElementById("logout-btn").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
  adminLoaded = false;
  applyAuth(null);
});
// Audit F27: explicit allow-list matches OfficialCreate so a future template
// change can't silently introduce an extra input that breaks the PUT with a
// confusing 422.
const _ME_PROFILE_FIELDS = [
  "first_name", "last_name", "street", "city", "state", "zip",
  "phone", "email", "dietary_restrictions", "lat", "lng",
];
onSubmit(document.getElementById("me-form"), async (e) => {
  const b = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    if (!_ME_PROFILE_FIELDS.includes(el.name)) continue;  // ignore stray inputs
    b[el.name] = el.value === "" ? null : el.value;
  }
  try { await api("/me/profile", { method: "PUT", body: JSON.stringify(b) }); setMsg("me-msg", "saved", true); }
  catch (err) { setMsg("me-msg", err.message, false); }
});
document.getElementById("me-tournament").addEventListener("change", loadMyAvailability);
document.getElementById("me-avail-save").addEventListener("click", async () => {
  const sel = document.getElementById("me-tournament");
  if (!sel.value) return;
  const dates = [...document.querySelectorAll("#me-dates input:checked")].map((c) => c.value);
  try {
    await api(`/me/availability/${sel.value}`, { method: "PUT", body: JSON.stringify({ dates, hotel_needed: document.getElementById("me-hotel").checked }) });
    setMsg("me-avail-msg", "saved", true);
  } catch (err) { setMsg("me-avail-msg", err.message, false); }
});
document.getElementById("acct-save").addEventListener("click", async () => {
  if (!certOfficialId) return;
  try {
    await api(`/officials/${certOfficialId}/account`, { method: "PUT", body: JSON.stringify({ username: document.getElementById("acct-user").value, password: document.getElementById("acct-pass").value }) });
    setMsg("acct-msg", "login set", true);
  } catch (err) { setMsg("acct-msg", err.message, false); }
});

// Mark required fields with a red asterisk inline with the label text (the label
// is a flex column, so the text + star must share one inline element).
function markRequiredFields() {
  document.querySelectorAll("form .row label").forEach((label) => {
    if (!label.querySelector("[required]") || label.querySelector(".req")) return;
    const tn = [...label.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (!tn) return;
    const wrap = document.createElement("span");
    wrap.className = "label-text";
    wrap.textContent = tn.textContent.replace(/\s+$/, "");
    const star = document.createElement("span");
    star.className = "req"; star.textContent = " *"; star.title = "required";
    wrap.appendChild(star);
    tn.replaceWith(wrap);
  });
}

// Consolidate the Inbox panel's top toolbar so "+ Add email", "⬆ Import PDF"
// and "⬇ CSV" sit inline on the same row. The trigger and the CSV button
// are both injected by other init code; this runs after both so it can wrap
// all three into a shared flex container.
function _consolidateInboxToolbar() {
  const trigger = document.querySelector('#panel-t-inbox .add-trigger');
  const importBtn = document.getElementById("inbox-import-pdf-btn");
  const importInput = document.getElementById("inbox-import-pdf-input");
  const importMsg = document.getElementById("inbox-import-pdf-msg");
  const csv = [...document.querySelectorAll('#panel-t-inbox .export-btn')]
    .find((b) => /CSV/.test(b.textContent) && b.id !== "inbox-import-pdf-btn"
      && !b.classList.contains("menu-btn-trigger"));
  if (!trigger || !importBtn) return;
  if (document.getElementById("inbox-toolbar-row")) return;  // idempotent
  const row = document.createElement("div");
  row.id = "inbox-toolbar-row"; row.className = "actions-row mb-half";
  trigger.parentNode.insertBefore(row, trigger);
  // design-crit I-8: a single "⬆ Import ▾" menu replaces the separate
  // "Import PDF" + auto-injected "Import…" buttons. The original PDF button is
  // hidden but kept wired (its hidden file input does the upload); the menu's
  // first item just delegates to that input.
  importBtn.hidden = true;
  const importMenu = makeMenuButton(`<span aria-hidden="true">⬆</span> Import`, [
    { label: "PDF email thread", title: "Upload a printed email-thread PDF directly into this inbox", onClick: () => importInput.click() },
    { label: "Staged import…", title: "Open the Import page to preview + merge", onClick: () => gotoImport("emails_pdf") },
  ], { className: "export-btn no-print" });
  row.append(trigger, importMenu, importBtn);
  if (importInput) row.append(importInput);
  if (importMsg) row.append(importMsg);
  if (csv) row.append(csv);
}

// design-crit R-1: collapse the Roster's three download buttons (CSV /
// Sign-in / Sign-in template) into a single "⬇ Download ▾" menu so the
// toolbar stops truncating with "…". The originals stay in the DOM (hidden)
// so their existing by-id click handlers keep working; the menu delegates.
function _consolidateRosterToolbar() {
  const toolbar = document.querySelector("#panel-t-roster .list-toolbar");
  if (!toolbar || toolbar.querySelector(".roster-download-menu")) return;
  const csv = document.getElementById("roster-csv");
  const signin = document.getElementById("roster-signin-csv");
  const template = document.getElementById("roster-signin-template");
  if (!csv || !signin || !template) return;
  const menu = makeMenuButton(`<span aria-hidden="true">⬇</span> Download`, [
    { label: "Roster CSV", title: "Full roster as CSV", onClick: () => csv.click() },
    { label: "Sign-in sheet", title: "Sign-in sheet (status, events, size, hotel, lodging)", onClick: () => signin.click() },
    { label: "Sign-in template (blank)", title: "Empty sign-in sheet template", onClick: () => template.click() },
  ], { className: "export-btn no-print roster-download-menu" });
  csv.parentNode.insertBefore(menu, csv);
  [csv, signin, template].forEach((b) => { b.hidden = true; });
}

(async function init() {
  enhanceAllSelects();  // turn every <select> into a type-in dropdown
  markRequiredFields();
  _consolidateInboxToolbar();
  _consolidateRosterToolbar();
  await refreshHealth();
  let who = null;
  try { who = await api("/auth/me"); } catch (e) { who = null; }
  applyAuth(who);
  // Reconcile the inbox File-target labels/keys with the backend registry
  // (admin-only endpoint). Fire-and-forget: refines labels + surfaces drift, but
  // the literal FILE_TARGETS already works if this is slow or unavailable.
  if (who && who.role === "admin") verifyEmailTargets();
})();
