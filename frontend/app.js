// Audit A47: imports from sibling ESM module(s). app.js itself is now loaded
// as <script type="module">.
import {
  esc, fmtDOW, fmtMDY as _fmtMDY, dowLong as _dowLong,
  humanizeDetail as _humanizeDetail,
} from "./app/util.js";
import {
  SHIRT_CODES as _SHIRT_CODES, SHIRT_LABEL as _SHIRT_LABEL,
  SHIRT_LABELS, SIZE_TOKEN as _SIZE_TOKEN,
} from "./app/shirts.js";
import { rosterPrefillFromEmail, rosterPrefillFromName, resolveFilePlayerId } from "./app/roster_prefill.js";
import { createGridFactories } from "./app/grids.js";
import { createAuth } from "./app/auth.js";
import { createTournamentState } from "./app/state.js";
import { html, raw, hstr } from "./app/html.js";
import { createPlayerList } from "./app/player_list.js";
import {
  chip, money, makeMenuButton, formObj, onSubmit, fillSelect,
} from "./app/ui.js";
import {
  enhanceSelect, enhanceAllSelects, syncCombos, scheduleComboSync,
} from "./app/combobox.js";
import { createPrintDoc } from "./app/print.js";
import "./app/theme.js";          // installTheme on load
import "./app/shortcuts.js";      // installShortcuts on load
import { createBreadcrumbs } from "./app/breadcrumbs.js";
import { createDivisionCatalog } from "./app/catalog.js";
import { createShell } from "./app/shell.js";
import { createCsvExport } from "./app/export_csv.js";
import { createLayout } from "./app/layout.js";
import {
  officialLabel, siteLabel, playerLabel, createCertCatalog, DEFAULT_CERTS,
} from "./app/labels.js";
import { createSelectRefresh } from "./app/selects.js";
import { labelHeaderFilters as _labelHeaderFilters, reflectAriaSort as _reflectAriaSort } from "./app/grid_a11y.js";
import { createPrereqCallout } from "./app/prereq.js";
import { createNavCounts, NAV_COUNT_TABS } from "./app/nav_counts.js";
import {
  createDetailChrome, installFormModals, enhanceDetailDialogs,
} from "./app/detail_modals.js";
import { createPayrollPanel } from "./app/payroll.js";
import { createAvailabilityPanel } from "./app/availability.js";
import { createDayOfPanel } from "./app/dayof.js";
import { datesInRange as _datesInRange } from "./app/util.js";

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
//   ESM shell: shell (api/toast/confirm), export_csv, theme, shortcuts
//   ESM slices: util, html, ui, combobox, print, catalog, breadcrumbs,
//     grids, auth, state, player_list, shirts, roster_prefill
//   Caches + labels + tabs + two-level menu + sizeLists
//   Active tournament state (setActive / updateActiveUI)
//   GRIDS registry + grid helpers (wireEntity, makeListGrid, makeReadGrid,
//     wirePlayerList)
//   Tournament workspace pages (Sites, Roster, Import, Assignments, …)
//   Setup entity configs (tournamentsCrud … distancesCrud)
//   FORM_MODALS + ARIA detail-pane
//   Auth + role-based views (admin vs official)
// ============================================================================

// D11: API + toast + confirm live in ./app/shell.js
const { api, toast, setMsg, markInvalid, confirmDialog, progress: _progress } = createShell();
let _resetDayOfDate = () => {};  // filled by createDayOfPanel (D11)

// Session user (login /me) — H4.2 reads can_export_pii for bulk CSV gate.
let authUser = null;

// D11: CSV export gate + audit (H4.1/H4.2)
const { csvDownload: _csvDownload } = createCsvExport({
  api, toast, confirmDialog,
  getAuthUser: () => authUser,
  getActive: () => (typeof active !== "undefined" ? active : null),
});

// D11: print scaffold lives in ./app/print.js
const printDoc = createPrintDoc({ toast });



// Open the modal overlay wrapping a workspace add-form (used when filing/editing).
// Stays in app.js because it touches form._openModal / source_email_id filing state.
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

// ---- caches + labels ----
const sitesById = {}, tournamentsById = {}, officialsById = {}, playersById = {}, hotelsById = {};
// Secondary index: roster players keyed by USTA # for O(1) lookups (the
// detection/grid paths match on USTA, not id). Rebuilt with playersById.
const playersByUsta = {};

// D11: division/event catalog (Setup lists + grid editors). Reads active/players via getters.
const _divCatalog = createDivisionCatalog({
  getActive: () => active,
  getPlayersById: () => playersById,
  getPlayersByUsta: () => playersByUsta,
  scheduleComboSync,
});
const refreshDivisionLists = (...a) => _divCatalog.refreshDivisionLists(...a);
const _divisionListParams = (...a) => _divCatalog.divisionListParams(...a);
const _eventListParams = (...a) => _divCatalog.eventListParams(...a);
const _rowGender = (...a) => _divCatalog.rowGender(...a);
const _inferFormGender = (...a) => _divCatalog.inferFormGender(...a);

// D11: display labels + cert catalog (./app/labels.js)
const _certs = createCertCatalog(DEFAULT_CERTS);
const certLabel = (v) => _certs.certLabel(v);
// fmtDOW now imported from ./app/util.js (A47).

// D11: shared select refresh + player-ref helpers
const {
  refreshAllSelects, fillPlayerRef, fillPlayerRefs, expandPlayerRef,
} = createSelectRefresh({
  getOfficialsById: () => officialsById,
  getSitesById: () => sitesById,
  getPlayersById: () => playersById,
  getHotelsById: () => hotelsById,
  getPlayersCrud: () => (typeof playersCrud !== "undefined" ? playersCrud : undefined),
});

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
  if (grp) {
    // Always activate a tab in the group so the main panel matches the L1
    // choice. Prefer an already-active, enabled tab; else the first enabled
    // tab; else the first tab even if it is `.disabled` (needs-active).
    //
    // Previously we only clicked when the group had *no* `.tab.active` and we
    // skipped disabled tabs. For single-tab groups like Day-of that meant:
    // click L1 "Day-of" with no tournament selected → Venue view is disabled →
    // no click → previous group's panel stayed on screen. Same for any
    // needs-active-only group when the context bar has no tournament.
    const tabs = [...grp.querySelectorAll(".tab")];
    const tab =
      tabs.find((t) => t.classList.contains("active") && !t.classList.contains("disabled")) ||
      tabs.find((t) => !t.classList.contains("disabled")) ||
      tabs.find((t) => t.classList.contains("active")) ||
      tabs[0];
    if (tab) tab.click();
  }
  // Entering Inbox or the merged Player-lists group is a natural moment to
  // re-pull the badge counts so they reflect any changes made elsewhere.
  if (key === "playerlists" || key === "inbox") refreshNavCounts();
  sizeLists();
}

// D11: breadcrumb history (needs activateGroup)
const { pushCrumb: _pushCrumb } = createBreadcrumbs({ activateGroup });

// D11: nav badges + prereq callout
const { refreshNavCounts } = createNavCounts({
  api,
  getActive: () => active,
  getGroupsEl: () => _groupsEl,
});
const prereqCallout = createPrereqCallout({ activateGroup });

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
  if (tab.dataset.target === "panel-home") loadDashboard();   // Home (no active needed)
  if (tab.dataset.target === "panel-tshirts") loadTshirts();  // Setup tab (no active needed)
  if (tab.dataset.target === "panel-users") loadUsers();      // Setup tab (admin accounts)
  if (tab.dataset.target === "panel-import") buildImportPage();
  // Opening any counted list (or the Inbox) re-pulls badge counts so a chip
  // can't read stale after the user adds/removes rows on a sibling tab.
  if (active && NAV_COUNT_TABS[tab.dataset.target]) refreshNavCounts();
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

// =================== Active tournament state ===================
let active = null;
let lastSelectedTournamentId = null;
const activeSelect = document.getElementById("active-tournament");
// Active-tournament-changed event (P2 #11c). `active` stays a module-global
// (read by hundreds of guards); this owns only the CHANGE event so the cascade
// of reactions is declared in one subscriber list instead of inline.
const _tstate = createTournamentState();
// The one-place declaration of what reacts to an active-tournament CHANGE.
// (updateActiveUI runs on every refresh; this runs only on a real transition.)
_tstate.onChange(({ active: next, prev }) => {
  // Switching mid-edit would leave a modal open against another tournament's
  // data — close any open detail + reset workspace forms. Toast the transition.
  closeOpenDetail();
  document.querySelectorAll(".tpanel form").forEach((f) => { try { f.reset(); } catch (_) {} });
  // Day-of keeps a sticky calendar date; reset so the next load picks a
  // default inside the new tournament's play window (not yesterday's event).
  _resetDayOfDate();
  if (next) toast(`Switched to ${next.name}`, true);
  else if (prev) toast(`Cleared active tournament (${prev.name})`, true);
  refreshNavCounts();  // repaint the per-tab + Inbox badges for the new tournament
});

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
  // Audit F21: fire the change event on every transition (set/cleared/switched);
  // the subscriber (declared next to _tstate above) owns the reaction cascade.
  if ((prev ? prev.id : null) !== (active ? active.id : null)) {
    _tstate.emit({ active, prev });
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
  // Keep the Home dashboard in sync when the active tournament changes.
  if (document.getElementById("panel-home")?.classList.contains("active")
      && typeof loadDashboard === "function") loadDashboard();
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
    "panel-t-incidents": () => loadIncidents(),
    "panel-t-dayof": () => loadDayOf(),
    "panel-t-payroll": () => loadPayroll(),
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

// D11: list max-height + resize redraw
const { sizeLists } = createLayout({ redrawPanelGrids: _redrawPanelGrids });

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
  const fullName = [d.last_name, d.first_name].filter(Boolean).join(", ");
  // Make the player name a 360 link wherever a player_id is on the row, so the
  // TD can open the full player view from any Part B list (delegated handler).
  if (!d.player_id) return hstr`${fullName}`;
  return hstr`<span class="p360-link" data-pid="${d.player_id}" role="button" tabindex="0" title="View everything about this player (360)">${fullName}</span>`;
};
// One delegated handler opens the Player 360 from any .p360-link (Part B lists,
// inbox, …). openPlayer360 is a hoisted function declaration defined later.
document.addEventListener("click", (e) => {
  const link = e.target.closest && e.target.closest(".p360-link[data-pid]");
  if (!link) return;
  // Capture phase + stop so the click doesn't also fire Tabulator's cell/row
  // handlers underneath the link.
  e.preventDefault(); e.stopPropagation();
  openPlayer360(Number(link.dataset.pid), active ? active.id : null);
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const link = e.target.closest && e.target.closest(".p360-link[data-pid]");
  if (!link) return;
  e.preventDefault();
  openPlayer360(Number(link.dataset.pid), active ? active.id : null);
});
// D11: shared detail backdrop + Escape-to-close
const {
  detailBackdrop: _detailBackdrop,
  closeOpenDetail,
  setCloseOpenDetail,
} = createDetailChrome();

// wireEntity (the Setup master/detail CRUD factory) lives in ./app/grids.js
// (P2 #11a) together with makeListGrid/makeReadGrid; instantiated here with
// the app's helpers so the factory bodies stayed unchanged.
const { wireEntity, makeListGrid, makeReadGrid, makeGrid, _autoHeaderFilters } = createGridFactories({
  api, esc, setMsg, confirmDialog, markInvalid, scheduleComboSync, formObj,
  _csvDownload, _reflectAriaSort, GRIDS, _detailBackdrop,
  setCloseOpenDetail,
});

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
  // Multi-select tint: rows already part of the active tournament get .row-selected.
  // Re-evaluated on every setData()/setFilter() (which redraw) and after toggleSite.
  rowClassRules: { "row-selected": (p) => p.data && tSitesSelected.has(p.data.id) },
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
    tr.innerHTML = hstr`<td>${d.label || d.code}</td><td class="muted">${d.tournament_type}</td><td></td>`;
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", `Site for ${d.label || d.code}`);
    sel.innerHTML = `<option value="">— unassigned —</option>` +
      sites.map((s) => hstr`<option value="${s.id}">${s.name}</option>`).join("");
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
  rosterDetail.classList.add("detail-open"); _detailBackdrop.classList.add("show");
  setCloseOpenDetail(rosterCloseModal);
  scheduleComboSync();
}
function rosterCloseModal() {
  rosterDetail.classList.remove("detail-open"); _detailBackdrop.classList.remove("show");
  setCloseOpenDetail(null); _rosterAddQueue = [];
}
rosterCloseBtn.addEventListener("click", rosterCloseModal);
async function loadRoster() {
  if (!active) return;
  prereqCallout("panel-t-roster", !Object.keys(playersById).length,
    "The players catalog is empty — register players first, then add them to this roster (or use Import).",
    "tab-panel-players");
  rosterRows = await api(`/tournaments/${active.id}/players`);  // kept for the sign-in export
  if (rosterBuilt) await rosterGrid.setData(rosterRows); else rosterPending = rosterRows;
  applyRosterSel();
  _updateRosterCounts();
  _renderRosterCompleteness();
}

// Roster completeness: surface active entries missing data the TD needs before
// the event (division, gender, t-shirt, or an unpaid balance) so they can be
// chased. Clicking a flagged player selects them in the grid for editing.
const _COMPLETE_LABEL = {
  missing_division: "no division", missing_gender: "no gender",
  missing_shirt: "no t-shirt size", outstanding_balance: "balance due",
};
async function _renderRosterCompleteness() {
  const box = document.getElementById("roster-completeness");
  if (!box || !active) return;
  let c;
  try { c = await api(`/tournaments/${active.id}/roster-completeness`); }
  catch (e) { box.innerHTML = ""; return; }
  if (!c.counts.incomplete_entries) {
    box.innerHTML = c.counts.total_active
      ? hstr`<p class="rc-clean">✓ All ${c.counts.total_active} active roster entries are complete.</p>` : "";
    return;
  }
  const k = c.counts;
  const chips = [
    k.missing_division ? `${k.missing_division} no division` : "",
    k.missing_gender ? `${k.missing_gender} no gender` : "",
    k.missing_shirt ? `${k.missing_shirt} no t-shirt` : "",
    k.outstanding_balance ? `${k.outstanding_balance} balance due` : "",
  ].filter(Boolean).join(" · ");
  box.innerHTML = html`<details class="rc-details" open><summary>⚠ ${k.incomplete_entries} of ${k.total_active} active entr${k.incomplete_entries === 1 ? "y is" : "ies are"} incomplete <span class="rc-chips">(${chips})</span></summary><ul class="rc-list">${c.entries.map((e) =>
    html`<li class="rc-row" data-eid="${e.entry_id}"><span class="rc-name">${e.player_name} <span class="muted">#${e.usta_number || "—"}</span></span><span class="rc-issues">${e.issues.map((i) =>
      html`<span class="rc-issue${i === "outstanding_balance" ? " rc-issue-pay" : ""}">${_COMPLETE_LABEL[i] || i}${i === "outstanding_balance" && e.amount_outstanding != null ? ` ${money(e.amount_outstanding)}` : ""}</span>`)}</span></li>`)}</ul></details>`;
  box.querySelectorAll(".rc-row").forEach((row) => row.addEventListener("click", () => {
    const id = Number(row.dataset.eid);
    const r = (rosterRows || []).find((x) => x.id === id);
    if (!r) return;
    rosterSelect(r);          // select + load into the editor
    rosterOpenModal();        // open the edit form so the TD can fill the gap
    try { rosterGrid.scrollToRow(id, "center", false); } catch (_) {}
  }));
}
// R-4: a one-line summary strip above the roster grid.
function _updateRosterCounts() {
  const el = document.getElementById("roster-counts");
  if (!el) return;
  const rows = rosterRows || [];
  const n = (s) => rows.filter((r) => r.selection_status === s).length;
  if (!rows.length) { el.textContent = ""; return; }
  const sel = rows.filter((r) => r.selection_status === "selected");
  const inN = sel.filter((r) => r.signed_in).length;
  el.textContent =
    `${rows.length} on roster · ${n("selected")} selected · ${n("alternate")} alternate · ${n("withdrawn")} withdrawn` +
    (sel.length ? ` · checked in ${inN}/${sel.length}` : "");
}
const rosterName = (e) => [e.last_name, e.first_name].filter(Boolean).join(", ") || e.usta_number;

// Tabulator grid for the roster (master/detail like the Setup entities).
const rosterTableEl = document.getElementById("roster-table");
const rosterMount = rosterTableEl.closest(".list-scroll") || rosterTableEl.parentElement;
rosterMount.classList.remove("list-scroll"); rosterMount.innerHTML = ""; rosterMount.classList.add("grid-mount");
let rosterBuilt = false, rosterPending = null;
rosterMount.style.height = "calc(100vh - 16rem)";
const rosterGrid = makeGrid(rosterMount, {
  index: "id",
  placeholder: "No players on this roster yet.",
  columnDefaults: { tooltip: true },
  editTriggerEvent: "click",  // single click opens the cell editor (discoverable in-place edit)
  // Active-row highlight (replaces the old per-element rowFormatter); re-evaluated
  // by redrawRows() in applyRosterSel().
  rowClassRules: { "row-selected": (p) => p.data && p.data.id === rosterEditId },
  columns: [
    { title: "Player", field: "last_name",
      // design-crit R-1: show just the name (the USTA # was truncating the cell
      // mid-paren); the number is still searchable and shown on hover.
      formatter: (cell) => { const e = cell.getData(); const u = e.usta_number ? ` (USTA ${e.usta_number})` : "";
        return hstr`<span title="${rosterName(e) + u}">${rosterName(e)}</span>`; },
      headerFilter: "input", headerFilterFunc: (term, _v, e) => (rosterName(e) + " " + (e.usta_number || "")).toLowerCase().includes(String(term).toLowerCase()) },
    { title: "Div", field: "age_division", editor: "list", cssClass: "editable-cell",
      editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }),
      headerFilter: "input" },
    // Gender is a primary axis when a TD splits work by Boys'/Girls' draws, but
    // it was only used internally (division scoping) — surface + filter it.
    { title: "Gender", field: "gender", width: 84,
      formatter: (c) => { const g = _rowGender(c.getData());
        return g === "male" ? "M" : g === "female" ? "F" : '<span class="muted">—</span>'; },
      headerFilter: "list",
      headerFilterParams: { values: { "": "All", male: "Boys / M", female: "Girls / F" }, clearable: true },
      headerFilterFunc: (sel, _v, data) => !sel || _rowGender(data) === sel },
    { title: "Status", field: "selection_status", cssClass: "editable-cell",
      editor: "list", editorParams: { values: ["selected", "alternate", "withdrawn"] },
      headerFilter: "list", headerFilterParams: { values: ["selected", "alternate", "withdrawn"], clearable: true },
      formatter: (cell) => chip(cell.getData().selection_status) },
    // Day-of check-in (P4-2): click toggles. The sign-in SHEET exports still
    // exist for the clipboard; this records the result so no-shows are queryable.
    { title: "In", field: "signed_in", width: 56, widthGrow: 0, hozAlign: "center",
      headerTooltip: "Day-of check-in — click to toggle",
      formatter: (cell) => cell.getValue()
        ? '<span class="ok" title="Checked in — click to undo">✓</span>'
        : '<span class="muted" title="Not checked in — click to check in">—</span>',
      headerFilter: "list",
      headerFilterParams: { values: { "": "All", "true": "checked in", "false": "not in" }, clearable: true },
      headerFilterFunc: (term, v) => String(!!v) === String(term),
      cellClick: async (ev, cell) => {
        ev.stopPropagation();
        const e = cell.getData();
        try {
          await api(`/roster/${e.id}/signin`, { method: "PUT", body: JSON.stringify({ signed_in: !e.signed_in }) });
          toast(`${rosterName(e)}: ${e.signed_in ? "check-in undone" : "checked in"}`, true);
          await loadRoster();
        } catch (err) { toast(err.message, false); }
      } },
    { title: "Shirt", field: "t_shirt_size", cssClass: "editable-cell",
      // Audit M28: source from the canonical list defined alongside _SHIRT_LABEL
      // so the roster grid editor and the t-shirt order page can't drift.
      editor: "list", editorParams: () => ({ values: ["", ...SHIRT_LABELS] }),
      formatter: (c) => c.getValue() ? hstr`${c.getValue()}` : `<span class="muted">—</span>`,
      headerFilter: "input" },
    { title: "Dietary", field: "dietary_preference", editor: "input", cssClass: "editable-cell",
      formatter: (c) => c.getValue() ? hstr`${c.getValue()}` : `<span class="muted">—</span>`,
      headerFilter: "input" },
    // B3 lodging — canonical plan from the combined import. Falls back to
    // the raw free-text answer (rendered in muted italic) when the mapper
    // couldn't categorize it. Click-to-edit lets the TD upgrade a raw answer
    // into a canonical bucket without leaving the grid.
    { title: "Lodging", field: "lodging_plan", cssClass: "editable-cell",
      editor: "list", editorParams: { values: ["", "Hotel", "Local / family", "Commuter", "Commuter 1-2 hrs", "Commuter 2+ hrs"] },
      formatter: (cell) => {
        const e = cell.getData();
        if (e.lodging_plan) return hstr`${e.lodging_plan}`;
        if (e.lodging_plan_raw) return hstr`<span class="muted" style="font-style:italic" title="Unmapped — click to set a canonical plan">${e.lodging_plan_raw}</span>`;
        return "";
      },
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) => ((e.lodging_plan || e.lodging_plan_raw || "").toLowerCase().includes(String(term).toLowerCase())) },
    { title: "", field: "_act", headerSort: false, widthGrow: 0, width: 140, cssClass: "grid-actions-cell",
      formatter: (cell) => {
        const e = cell.getData();
        const wrap = document.createElement("div"); wrap.className = "grid-actions";
        // Edit is the primary action; Withdraw + Remove fold into a ⋯ overflow
        // menu (design-crit R-2) so the destructive verbs don't sit on every row.
        const v360 = document.createElement("button"); v360.type = "button"; v360.className = "btn-icon"; v360.textContent = "👤";
        v360.title = "View everything about this player (360)"; v360.setAttribute("aria-label", v360.title);
        v360.addEventListener("click", (ev) => { ev.stopPropagation(); openPlayer360(e.player_id, active ? active.id : null); });
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
        // Promote an alternate to selected (the move when a slot opens up).
        const isAlt = e.selection_status === "alternate";
        const doPromote = async () => {
          try {
            await api(`/roster/${e.id}/promote`, { method: "POST" });
            toast(`Promoted ${rosterName(e)} to selected`, true);
            await loadRoster();
          } catch (err) { toast(err.message, false); }
        };
        const items = [
          ...(isAlt ? [{ label: "↑ Promote to selected",
            title: "Move this alternate into a selected slot", onClick: doPromote }] : []),
          { label: withdrawn ? "Already withdrawn" : "Withdraw…",
            title: withdrawn ? "Player is already withdrawn" : "File a withdrawal for this player",
            onClick: doWithdraw },
          { separator: true },
          { label: "Remove from roster", danger: true, onClick: doDelete },
        ];
        const menu = makeMenuButton("⋯", items, { className: "btn-icon row-more", title: "More actions", anchor: true, noCaret: true });
        wrap.append(v360, ed, menu); return wrap;
      } },
  ],
});
(GRIDS["panel-t-roster"] ||= []).push(rosterGrid);
function _rosterOnBuilt() { rosterBuilt = true; if (rosterPending) { rosterGrid.setData(rosterPending); rosterPending = null; } applyRosterSel(); }
rosterGrid.on("tableBuilt", _rosterOnBuilt);
// AG's facade reports initialized:true synchronously, but applyRosterSel() reads
// module consts (rosterPos/Prev/Next) declared further down — running it inline
// here would hit the temporal dead zone and abort the whole module. Defer to a
// microtask so the rest of the module finishes evaluating first.
if (rosterGrid.initialized) queueMicrotask(_rosterOnBuilt);
// Single click only highlights (keeps double-click free for in-grid editing);
// the Edit button opens the form overlay.
rosterGrid.on("rowClick", (e, row) => { rosterEditId = row.getData().id; applyRosterSel(); });
rosterGrid.on("dataFiltered", applyRosterSel);
rosterGrid.on("dataSorted", () => { applyRosterSel(); });   // AG sets aria-sort natively
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
  rosterGrid.redrawRows();   // re-evaluates rowClassRules { row-selected }
}
function applyRosterSel() { rosterMarkRows(); rosterUpdateNav(); }
function rosterSelect(e) {
  rosterEditId = e.id; _rosterFromEmailId = null;  // editing, not an email-seeded add
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
// When the roster add-form was opened from an inbox email ("Add to roster"),
// this holds that email's id so a successful save can re-run detection and link
// the email to the just-added player. Cleared on any other form open.
let _rosterFromEmailId = null;
// "Add both" (a name-only doubles pair) opens the add-form once per player; the
// second player's prefill waits here and is opened after the first SAVE. Cleared
// if the TD cancels (so a half-finished pair doesn't pop the second form).
let _rosterAddQueue = [];
function rosterShowNew() {
  rosterEditId = null; _rosterFromEmailId = null; rosterForm.reset();
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
const rosterPrev = document.createElement("button"); rosterPrev.type = "button"; rosterPrev.className = "nav-btn nav-btn--icon"; rosterPrev.textContent = "‹"; rosterPrev.title = "Previous record"; rosterPrev.setAttribute("aria-label", "Previous record");
const rosterNext = document.createElement("button"); rosterNext.type = "button"; rosterNext.className = "nav-btn nav-btn--icon"; rosterNext.textContent = "›"; rosterNext.title = "Next record"; rosterNext.setAttribute("aria-label", "Next record");
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
    // If this entry was added from an inbox email, re-run detection on that
    // email so it now links to the player we just put on the roster — no manual
    // "Detect" needed. (Best-effort; the roster save itself already succeeded.)
    const fromEmail = _rosterFromEmailId; _rosterFromEmailId = null;
    if (fromEmail) {
      try {
        const det = await api(`/emails/${fromEmail}/detect-player`, { method: "POST" });
        if (typeof loadInbox === "function") loadInbox();
        if (det && det.detected_player_name) toast(`Linked email to ${det.detected_player_name}`, true);
      } catch (_) { /* detection is a convenience; ignore failures */ }
    }
    await loadRoster();
    // "Add both": grab the queued second player BEFORE the close handlers run
    // (rosterCloseModal clears the queue, so capture it first).
    const _nextAdd = _rosterAddQueue.shift();
    const row = saved && saved.id != null && rosterRows.find((r) => r.id === saved.id);
    if (row) rosterSelect(row); else rosterShowNew();
    rosterCloseModal();
    if (_nextAdd) setTimeout(() => _inboxAddToRoster(_nextAdd.m, _nextAdd.plan), 60);
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
// USTA #/id-shaped columns: digits only when present.
const _IMPORT_ID_COLS = new Set(["usta_number", "partner_usta", "usta_1", "usta_2",
  "usta_3", "usta_4", "usta_5", "usta_6", "official_id", "site_id", "source_email_id"]);
// Money/score columns: must be a number when present.
const _IMPORT_NUM_COLS = new Set(["amount_paid", "amount_refunded", "amount_due",
  "amount_outstanding", "wtn_singles", "wtn_doubles", "suspension_points"]);
// Pattern/enum rules per column (case-insensitive), each with a hint.
const _IMPORT_RULES = {
  gender: { re: /^(m|f|male|female)$/i, msg: "male / female" },
  wants_random: { re: /^(y|n|yes|no|true|false|1|0)$/i, msg: "yes / no" },
  relationship: { re: /^(siblings|same_club)$/i, msg: "siblings / same_club" },
  selection_status: { re: /^(selected|alternate|withdrawn)$/i, msg: "selected / alternate / withdrawn" },
  request_date: { re: /^\d{4}-\d{2}-\d{2}$/, msg: "YYYY-MM-DD" },
  year_of_birth: { re: /^(19|20)\d{2}$/, msg: "4-digit year" },
  age_division: { re: /^[a-z]{0,3}\s?\d{1,2}\b/i, msg: "e.g. B14 / G16" },
};
// Client-side, per-cell validation for the import preview grid — the instant
// first pass (the server's validate() still has the final say: USTA existence,
// reason-required-on-merge, etc.). Returns an error string, or "" when fine.
function _importCellError(col, val, required) {
  const v = (val == null ? "" : String(val)).trim();
  if (required.has(col) && !v) return "required";
  if (!v) return "";
  if (_IMPORT_ID_COLS.has(col) && !/^\d+$/.test(v)) return "digits only";
  if (col === "one_way_miles") return Number(v) >= 0 ? "" : "number ≥ 0";
  if (_IMPORT_NUM_COLS.has(col)) return isNaN(Number(v)) ? "must be a number" : "";
  if (col === "emails") return /@/.test(v) ? "" : "missing @";
  const rule = _IMPORT_RULES[col];
  if (rule && !rule.re.test(v)) return rule.msg;
  return "";
}

// Per-import-type tab metadata: an icon + a short label (the backend labels are
// verbose) so the per-import tabs scan fast. Plus the preferred display order
// (roster variants grouped together).
const _IMPORT_TAB_META = {
  roster: { icon: "📋", short: "Roster (simple)" },
  roster_initial: { icon: "📥", short: "Roster: Initial" },
  roster_correction: { icon: "✏️", short: "Roster: Correction" },
  late_entries: { icon: "⏰", short: "Late entries" },
  withdrawals: { icon: "🚫", short: "Withdrawals" },
  scheduling_avoidances: { icon: "📅", short: "Scheduling" },
  division_flexibility: { icon: "🔀", short: "Division flex" },
  pairing_avoidances: { icon: "⛔", short: "Pairing avoid" },
  doubles_requests: { icon: "👥", short: "Doubles" },
  player_hotels: { icon: "🏨", short: "Player hotels" },
  tshirt_hotel_dietary: { icon: "👕", short: "Shirt + Hotel + Diet" },
  emails_pdf: { icon: "✉️", short: "Emails (PDF)" },
  distances: { icon: "📏", short: "Distances" },
};
const _IMPORT_TAB_ORDER = ["roster", "roster_initial", "roster_correction", "late_entries",
  "withdrawals", "scheduling_avoidances", "division_flexibility", "pairing_avoidances",
  "doubles_requests", "player_hotels", "tshirt_hotel_dietary", "emails_pdf", "distances"];

// Show/clear a "staged rows waiting" badge on an import type's tab, so the TD can
// switch tabs without losing track of an in-progress batch.
function _importTabBadge(key, count) {
  const btn = document.querySelector(`.import-tab[data-key="${key}"]`);
  if (!btn) return;
  let b = btn.querySelector(".import-tab-badge");
  if (!count) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement("span"); b.className = "import-tab-badge"; btn.appendChild(b); }
  b.textContent = String(count);
}

// Import preview: an editable grid of the staged rows. The TD sees exactly what
// the file contained, fixes bad cells in place (each edit PATCHes + re-validates
// server-side), bulk-fixes (delete flagged / set a column for all), then merges
// the ready rows (flagged rows are skipped, not blocked, and stay for fixing).
async function _renderPreviewGrid(el, body, meta) {
  const required = new Set(meta.required || []);
  const cols = meta.columns || [];
  const bid = body.batch_id;
  el.innerHTML = "";

  const head = document.createElement("div"); head.className = "import-preview-head";
  const counts = document.createElement("span"); counts.className = "import-counts";
  // Bulk-set: pick a column, type a value, apply to every row.
  const setWrap = document.createElement("span"); setWrap.className = "import-bulkset";
  const setCol = document.createElement("select"); setCol.title = "Column to set for all rows";
  setCol.innerHTML = '<option value="">Set column…</option>' + cols.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const setVal = document.createElement("input"); setVal.type = "text"; setVal.placeholder = "value"; setVal.className = "import-bulkset-val";
  const setBtn = document.createElement("button"); setBtn.type = "button"; setBtn.className = "export-btn"; setBtn.textContent = "Apply to all";
  setWrap.append(setCol, setVal, setBtn);
  const delFlagged = document.createElement("button");
  delFlagged.type = "button"; delFlagged.className = "export-btn"; delFlagged.textContent = "🗑 Delete flagged";
  const merge = document.createElement("button");
  merge.type = "button"; merge.className = "export-btn primary";
  const disc = document.createElement("button");
  disc.type = "button"; disc.className = "export-btn"; disc.textContent = "Discard";
  head.append(counts, setWrap, delFlagged, merge, disc);
  const mount = document.createElement("div"); mount.className = "import-preview-grid grid-mount";
  const after = document.createElement("div"); after.className = "import-result-after";
  el.append(head, mount, after);

  let grid, dupUstas = new Set();
  // cellErr = the standard rules PLUS the cross-row "duplicate USTA # in file"
  // check (which needs the whole dataset, so it lives here as a closure).
  const cellErr = (col, val) => {
    const base = _importCellError(col, val, required);
    if (base) return base;
    if (col === "usta_number" && val && dupUstas.has(String(val).trim())) return "duplicate USTA # in file";
    return "";
  };
  const _rowClientBad = (d) => cols.some((c) => cellErr(c, d[c]));
  const _rowReady = (d) => d._valid && !_rowClientBad(d);

  const refresh = () => {
    const rows = grid.getData();
    // recompute in-file duplicate USTA #s
    const seen = {}; dupUstas = new Set();
    rows.forEach((d) => { const u = (d.usta_number || "").trim(); if (!u) return; seen[u] = (seen[u] || 0) + 1; if (seen[u] > 1) dupUstas.add(u); });
    grid.getRows().forEach((r) => r.reformat());   // re-tint cells for the new dup set
    const ready = rows.filter(_rowReady).length;
    const flagged = rows.length - ready;
    counts.innerHTML = hstr`Staged ${String(rows.length)}: ${raw(`<strong>${ready} ready</strong>`)}${flagged ? `, ${flagged} to fix` : ""}.`;
    merge.disabled = ready === 0;
    merge.textContent = `Merge ${ready} ready row${ready === 1 ? "" : "s"}`;
    delFlagged.disabled = flagged === 0;
    delFlagged.textContent = `🗑 Delete ${flagged} flagged`;
    _importTabBadge(meta.key, rows.length);
  };

  const mapRow = (r) => ({ _id: r.id, _num: r.row_num, _valid: r.valid, _error: r.error,
    ...Object.fromEntries(cols.map((c) => [c, r.data[c] == null ? "" : r.data[c]])) });
  // (re)load the unmerged staged rows from the server into the grid.
  async function reloadGrid() {
    const b = await api(`/import/batches/${bid}`);
    const unmerged = b.rows.filter((r) => !r.merged).map(mapRow);
    await grid.replaceData(unmerged);
    refresh();
    return unmerged.length;
  }

  let batch;
  try { batch = await api(`/import/batches/${bid}`); }
  catch (e) { el.textContent = e.message; return; }

  const colDefs = [
    { title: "", field: "_status", width: 42, headerSort: false, frozen: true,
      formatter: (c) => { const d = c.getData();
        if (_rowReady(d)) return '<span class="ok" title="ready — will merge">✓</span>';
        const why = d._error || (_rowClientBad(d) ? "check the highlighted cell(s)" : "invalid");
        return `<span class="bad" title="${esc(why)}">⚠</span>`; } },
    { title: "#", field: "_num", width: 46, headerSort: false, frozen: true, cssClass: "muted" },
    ...cols.map((col) => ({
      title: required.has(col) ? col + " *" : col, field: col,
      editor: "input", editableTitle: false, minWidth: 90, widthGrow: 1, cssClass: "editable-cell",
      formatter: (c) => { const err = cellErr(col, c.getValue());
        const v = c.getValue() == null ? "" : String(c.getValue());
        return err ? `<span class="import-cell-bad" title="${esc(err)}">${esc(v) || "—"}</span>` : esc(v); },
    })),
    { title: "", field: "_del", width: 40, headerSort: false,
      formatter: () => '<button type="button" class="btn-icon" title="Remove this row">✕</button>',
      cellClick: async (e, cell) => {
        const d = cell.getData();
        try { await api(`/import/batches/${bid}/rows/${d._id}`, { method: "DELETE" });
          cell.getRow().delete(); refresh(); }
        catch (err) { toast(err.message, false); }
      } },
  ];

  mount.style.height = "52vh";
  grid = makeGrid(mount, {
    index: "_id", editTriggerEvent: "click",
    placeholder: "No rows in this file.", columns: colDefs,
  });
  grid.setData(batch.rows.filter((r) => !r.merged).map(mapRow));
  refresh();
  grid.on("tableBuilt", refresh);

  grid.on("cellEdited", async (cell) => {
    const row = cell.getRow(); const d = row.getData();
    const payload = Object.fromEntries(cols.map((c) => [c, (d[c] ?? "") === "" ? null : d[c]]));
    try {
      const res = await api(`/import/batches/${bid}/rows/${d._id}`,
        { method: "PATCH", body: JSON.stringify({ data: payload }) });
      row.update({ _valid: res.valid, _error: res.error }); row.reformat();
      refresh();
    } catch (err) { toast(err.message, false); }
  });

  setBtn.addEventListener("click", async () => {
    if (!setCol.value) { toast("pick a column to set", false); return; }
    setBtn.disabled = true;
    try {
      await api(`/import/batches/${bid}/bulk-set`, { method: "POST",
        body: JSON.stringify({ column: setCol.value, value: setVal.value }) });
      await reloadGrid();
      toast(`Set ${setCol.value} for all rows`, true);
    } catch (e) { toast(e.message, false); }
    finally { setBtn.disabled = false; }
  });

  delFlagged.addEventListener("click", async () => {
    const ids = grid.getData().filter((d) => !_rowReady(d)).map((d) => d._id);
    if (!ids.length) return;
    if (!(await confirmDialog(`Delete ${ids.length} flagged row(s)? This drops them from the staged batch (the file isn't changed).`, "Delete flagged", "danger"))) return;
    try {
      await api(`/import/batches/${bid}/rows-delete`, { method: "POST", body: JSON.stringify({ ids }) });
      await reloadGrid();
    } catch (e) { toast(e.message, false); }
  });

  const showMerged = (r) => {
    const nConf = (r.conflicts || []).length;
    toast(`Merged ${r.merged}${r.failed ? `, ${r.failed} failed` : ""}${nConf ? `, ${nConf} conflict(s)` : ""}`, !r.failed);
    let html = `<div class="muted">✓ Merged ${r.merged} row(s)${r.failed ? `; ${r.failed} failed` : ""}.</div>`;
    if (nConf) html += `<div class="warn" style="margin-top:.2rem">⚠ ${nConf} conflict(s) — merged anyway:</div>` +
      '<ul class="import-errors" style="color:var(--warn-ink,#8a6d1b)">' +
      r.conflicts.map((c) => hstr`<li>row ${c.row}: ${c.detail}</li>`).join("") + "</ul>";
    if (r.errors && r.errors.length) html += '<ul class="import-errors">' +
      r.errors.map((e) => hstr`<li>row ${e.row}: ${e.error}</li>`).join("") + "</ul>";
    after.innerHTML = html;
  };

  merge.addEventListener("click", async () => {
    const readyIds = grid.getData().filter(_rowReady).map((d) => d._id);
    if (!readyIds.length) return;
    merge.disabled = true;
    try {
      const r = await api(`/import/batches/${bid}/merge`,
        { method: "POST", body: JSON.stringify({ row_ids: readyIds }) });
      // Merged the ready rows; flagged ones stay staged for fixing.
      const remaining = await reloadGrid();
      if (remaining === 0) {
        head.style.display = "none"; mount.style.display = "none";
        showMerged(r); _importTabBadge(meta.key, 0);
      } else {
        toast(`Merged ${r.merged} ready row(s); ${remaining} still need fixing.`, true);
      }
      _importRefresh();
    } catch (e) { toast(e.message, false); merge.disabled = false; }
  });
  disc.addEventListener("click", async () => {
    try { await api(`/import/batches/${bid}`, { method: "DELETE" }); el.innerHTML = ""; _importTabBadge(meta.key, 0); }
    catch (e) { toast(e.message, false); }
  });
}
// Which import types are Setup catalogs (no active tournament needed) vs
// tournament-scoped. Used to split the Import page into two groups and to
// gate the active-tournament needs-note.
const _IMPORT_SETUP_KEYS = new Set(["distances", "divisions", "events", "players", "officials"]);

// Build one import type's section (template downloads + upload + preview grid),
// appended (hidden) to the shared panel. Returns the section element.
function _buildImportSection(t, panelRoot) {
  const sec = document.createElement("section");
  sec.className = "export-section import-section";
  sec.id = "import-" + t.key;     // deep-link target for per-panel ⬆ Import buttons
  sec.hidden = true;
  const needsT = !_IMPORT_SETUP_KEYS.has(t.key)
    ? '<span class="import-scope-chip" title="Imports into the active tournament">tournament</span>'
    : '<span class="import-scope-chip setup" title="Global Setup catalog — no active tournament needed">Setup catalog</span>';
  // a11y 9th-pass: tabindex="-1" makes the heading programmatically focusable so
  // gotoImport() can land focus here after switching tabs.
  sec.innerHTML = hstr`<h4 tabindex="-1">${t.label} ${raw(needsT)}</h4><p class="muted">${t.desc} <span class="muted">Columns: ${t.columns.join(", ")}${t.required.length ? ` (required: ${t.required.join(", ")})` : ""}.</span></p>`;
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
      _renderPreviewGrid(result, body, t);
    } catch (e) { msg.textContent = e.message; msg.className = "msg bad"; }
    finally { up.disabled = false; }
  });
  panelRoot.appendChild(sec);
  return sec;
}

async function buildImportPage() {
  const tabsRoot = document.getElementById("import-tabs");
  const panelRoot = document.getElementById("import-panel");
  const note = document.getElementById("import-needs-active");
  if (!tabsRoot || !panelRoot) return;
  // Toggle the needs-active hint based on current selection.
  if (note) note.hidden = !!active;
  if (tabsRoot.dataset.built) return;
  // Set the guard BEFORE the await so a second concurrent call (e.g. the tab
  // click handler + gotoImport both firing) doesn't race past this check.
  tabsRoot.dataset.built = "1";
  let types;
  try { types = await api("/import/types"); }
  catch (e) { panelRoot.textContent = e.message; tabsRoot.dataset.built = ""; return; }

  const sections = {};   // key -> section element
  const tabBtns = {};    // key -> tab button
  const activate = (key) => {
    if (!sections[key]) return;
    Object.entries(sections).forEach(([k, sec]) => { sec.hidden = k !== key; });
    Object.entries(tabBtns).forEach(([k, btn]) => {
      const on = k === key; btn.classList.toggle("active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false"); btn.tabIndex = on ? 0 : -1;
    });
  };
  buildImportPage._activate = activate;   // gotoImport() drives this

  // Each import type gets its own tab. Tournament-data importers first, then the
  // global Setup catalogs (which don't need an active tournament). Within a
  // group, order by _IMPORT_TAB_ORDER (roster variants grouped together).
  const _ord = (t) => { const i = _IMPORT_TAB_ORDER.indexOf(t.key); return i < 0 ? 99 : i; };
  const groups = [
    { label: "Tournament data", keys: types.filter((t) => !_IMPORT_SETUP_KEYS.has(t.key)).sort((a, b) => _ord(a) - _ord(b)) },
    { label: "Setup catalogs", keys: types.filter((t) => _IMPORT_SETUP_KEYS.has(t.key)).sort((a, b) => _ord(a) - _ord(b)) },
  ];
  for (const g of groups) {
    if (!g.keys.length) continue;
    const lbl = document.createElement("div"); lbl.className = "import-tabgroup-label"; lbl.textContent = g.label;
    tabsRoot.appendChild(lbl);
    for (const t of g.keys) {
      const tm = _IMPORT_TAB_META[t.key] || {};
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "import-tab"; btn.dataset.key = t.key;
      btn.setAttribute("role", "tab"); btn.tabIndex = -1; btn.title = t.label;   // full label on hover
      btn.innerHTML = `<span class="import-tab-ico" aria-hidden="true">${tm.icon || "•"}</span><span class="import-tab-lbl">${esc(tm.short || t.label)}</span>`;
      btn.addEventListener("click", () => activate(t.key));
      tabsRoot.appendChild(btn); tabBtns[t.key] = btn;
      sections[t.key] = _buildImportSection(t, panelRoot);
    }
  }
  const first = (groups.find((g) => g.keys.length) || { keys: [] }).keys[0];
  if (first) activate(first.key);
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
  // 2. Build the page if it hasn't been built yet, then SELECT that type's tab.
  await buildImportPage();
  if (typeof buildImportPage._activate === "function") buildImportPage._activate(typeKey);
  const target = document.getElementById("import-" + typeKey);
  if (target) {
    target.classList.add("import-section-flash");
    setTimeout(() => target.classList.remove("import-section-flash"), 1400);
    // a11y 9th-pass: focus the now-visible section's heading so keyboard users
    // land at the right place. The activation cascade (group → tab → import-tab
    // clicks → buildImportPage → redraws) keeps resetting focus during the
    // ~200 ms it takes to settle, so re-apply a few times. Cheap + idempotent.
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
// Response-status filter chips (re-render from memory, no refetch).
document.querySelectorAll("#asg-respbar .chip-toggle").forEach((btn) => {
  btn.addEventListener("click", () => { _asgRespFilter = btn.dataset.resp; _renderAsgList(); });
});
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
  prereqCallout("panel-t-assignments", !Object.keys(officialsById).length,
    "No officials in the catalog yet — add them (with certifications) before assigning.",
    "tab-panel-officials");
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
  // Reset the response-status filter when the active tournament changes, so a
  // 'declined' filter from tournament A doesn't strand tournament B's list
  // behind a now-empty, disabled-but-on chip. Persists across same-tournament
  // reloads (e.g. after an accept/decline) so an in-progress filter survives.
  if (_asgFilterTid !== active.id) { _asgRespFilter = "all"; _asgFilterTid = active.id; }
  // Unassigned-availability nudge: officials who declared availability but have
  // no assigned working day yet — surfaced HERE (where staffing happens) with a
  // jump to the Availability tab. Mirrors the Availability tab's gap callout.
  const assignedWithDays = new Set(list.filter((a) => a.days && a.days.length).map((a) => a.official_id));
  const availableUnassigned = Object.keys(availByOfficial)
    .map(Number)
    .filter((oid) => !assignedWithDays.has(oid));
  const nudge = document.getElementById("asg-avail-nudge");
  if (availableUnassigned.length) {
    const names = availableUnassigned
      .map((oid) => (officialsById[oid] ? officialLabel(officialsById[oid]) : `#${oid}`))
      .sort();
    nudge.hidden = false;
    nudge.innerHTML = `⚠ ${availableUnassigned.length} available official(s) not yet assigned: ` +
      `<strong>${names.map(esc).join("; ")}</strong>. ` +
      `<a href="#" id="asg-nudge-link">Open Availability →</a>`;
    const link = document.getElementById("asg-nudge-link");
    if (link) link.addEventListener("click", (e) => {
      e.preventDefault();
      const t = document.querySelector('[data-group="tournament"]');
      if (t) t.click();
      const tab = document.querySelector('[data-target="panel-t-availability"]');
      if (tab) tab.click();
    });
  } else { nudge.hidden = true; nudge.textContent = ""; }

  const box = document.getElementById("asg-list");
  box.innerHTML = "";
  // Audit P42: match the Tabulator placeholder styling so empty states across
  // the app look the same (✦ icon + centered muted text).
  if (list.length === 0) {
    document.getElementById("asg-respbar").hidden = true;
    box.innerHTML = '<div class="grid-empty"><span class="grid-empty-icon" aria-hidden="true">✦</span> No officials assigned yet — click <strong>+ Assign official</strong> above to start.</div>';
    return;
  }
  // Stash the list + availability so the response-status filter can re-render
  // without re-fetching, and so the TD can jump straight to declines to re-staff.
  _asgState = { list, availByOfficial };
  _renderBulkInvite(new Set(list.map((a) => a.official_id)), availByOfficial);
  _renderAsgList();
  _renderNoLogin();
}

// Assigned officials with no self-service login can't accept/decline, so their
// assignments sit pending forever — flag them with a jump to Officials setup
// (where the TD creates the login).
async function _renderNoLogin() {
  const box = document.getElementById("asg-nologin");
  if (!box || !active) return;
  let d;
  try { d = await api(`/tournaments/${active.id}/officials-without-login`); }
  catch (_) { box.hidden = true; return; }
  if (!d.count) { box.hidden = true; box.innerHTML = ""; return; }
  const names = d.officials.map((o) =>
    hstr`${o.official_name}${o.has_email ? "" : raw(' <span class="muted">(no email)</span>')}`).join("; ");
  box.hidden = false;
  box.innerHTML = html`<span class="asg-nologin-text">🔑 ${d.count} assigned official${d.count === 1 ? "" : "s"} can't accept/decline — no login: <strong>${raw(names)}</strong>.</span> <button type="button" id="asg-nologin-go" class="btn-small">Set up logins →</button>`;
  document.getElementById("asg-nologin-go")?.addEventListener("click", () =>
    _dashGo("setup", "panel-officials"));
}

// Bulk invite: pick several not-yet-assigned officials and create a pending
// assignment for each in one call (POST .../assignments/bulk), then offer a
// single mailto to everyone who was just invited. Officials already on the
// tournament are excluded from the picker (they're already in the response loop).
function _renderBulkInvite(assignedIds, availByOfficial) {
  const box = document.getElementById("asg-bulk-list");
  if (!box) return;
  const candidates = Object.values(officialsById)
    .filter((o) => !assignedIds.has(o.id))
    .sort((a, b) => officialLabel(a).localeCompare(officialLabel(b)));
  const summary = document.querySelector("#asg-bulk > summary");
  if (summary) summary.textContent = `＋ Invite several officials at once (${candidates.length} available)`;
  if (!candidates.length) {
    box.innerHTML = '<p class="muted">Every official is already assigned to this tournament.</p>';
  } else {
    box.innerHTML = candidates.map((o) => {
      const n = (availByOfficial[o.id] || []).length;
      const avail = n ? `${n} avail day(s)` : "no availability";
      return hstr`<label class="bulk-row"><input type="checkbox" class="bulk-cb" value="${o.id}" data-label="${officialLabel(o).toLowerCase()}" /><span class="bulk-name">${officialLabel(o)}</span><span class="bulk-meta">${avail}</span></label>`;
    }).join("");
  }
  _bulkSyncCount();
}

function _bulkSyncCount() {
  const sel = document.querySelectorAll("#asg-bulk-list .bulk-cb:checked").length;
  const el = document.getElementById("asg-bulk-count");
  if (el) el.textContent = `${sel} selected`;
  const go = document.getElementById("asg-bulk-go");
  if (go) go.disabled = sel === 0;
}

// "✉ Invite all": fetch a personalised invite for every assigned official, copy
// the combined document to the clipboard, and (when emails are on file) offer a
// BCC-all mailto for the whole panel.
document.getElementById("asg-invite-all")?.addEventListener("click", async () => {
  if (!active) return;
  let d;
  try { d = await api(`/tournaments/${active.id}/invite-texts`); }
  catch (e) { toast(e.message, false); return; }
  if (!d.count) { toast("No officials assigned yet", false); return; }
  const combined = d.invites.map((i) =>
    `=== ${i.official_name}${i.official_email ? ` <${i.official_email}>` : " (no email on file)"} ===\n` +
    `Subject: ${i.subject}\n\n${i.body}`).join("\n\n----------------------------------------\n\n");
  try { await navigator.clipboard.writeText(combined); } catch (_) {}
  const action = d.emails.length ? {
    label: `BCC ${d.emails.length} →`,
    onClick: () => {
      const subj = encodeURIComponent(`Officiating assignment — ${active.name}`);
      window.open(`mailto:?bcc=${encodeURIComponent(d.emails.join(","))}&subject=${subj}`, "_blank");
    },
  } : null;
  toast(`Copied ${d.count} personalised invite${d.count === 1 ? "" : "s"} to the clipboard` +
    (d.emails.length ? "" : " (no emails on file)"), true, action);
});

// --- Bulk-invite controls (wired once; list is repopulated per loadAssignments) ---
(() => {
  const list = document.getElementById("asg-bulk-list");
  const filter = document.getElementById("asg-bulk-filter");
  if (!list) return;
  list.addEventListener("change", (e) => { if (e.target.classList.contains("bulk-cb")) _bulkSyncCount(); });
  if (filter) filter.addEventListener("input", () => {
    const q = filter.value.trim().toLowerCase();
    list.querySelectorAll(".bulk-row").forEach((r) => {
      const cb = r.querySelector(".bulk-cb");
      r.hidden = q.length > 0 && !cb.dataset.label.includes(q);
    });
  });
  document.getElementById("asg-bulk-all")?.addEventListener("click", () => {
    list.querySelectorAll(".bulk-row:not([hidden]) .bulk-cb").forEach((cb) => { cb.checked = true; });
    _bulkSyncCount();
  });
  document.getElementById("asg-bulk-none")?.addEventListener("click", () => {
    list.querySelectorAll(".bulk-cb").forEach((cb) => { cb.checked = false; });
    _bulkSyncCount();
  });
  document.getElementById("asg-bulk-go")?.addEventListener("click", async () => {
    if (!active) return;
    const ids = [...list.querySelectorAll(".bulk-cb:checked")].map((cb) => Number(cb.value));
    if (!ids.length) return;
    const go = document.getElementById("asg-bulk-go");
    go.disabled = true;
    try {
      const r = await api(`/tournaments/${active.id}/assignments/bulk`, {
        method: "POST", body: JSON.stringify({ official_ids: ids }),
      });
      let msg = `Invited ${r.created_count} official${r.created_count === 1 ? "" : "s"}`;
      if (r.skipped_existing.length) msg += ` · ${r.skipped_existing.length} already assigned`;
      // Offer a single mailto to everyone who was just invited and has an email.
      if (r.invite_emails.length) {
        const subj = encodeURIComponent(`Officiating assignment — ${active.name}`);
        const bodyTxt = encodeURIComponent(`You've been assigned to ${active.name}. Please confirm (accept or decline) via your CourtOps self-service "My assignments" page. Thank you.`);
        const href = `mailto:?bcc=${encodeURIComponent(r.invite_emails.join(","))}&subject=${subj}&body=${bodyTxt}`;
        toast(msg, true, { label: `✉ Email ${r.invite_emails.length} invited`, onClick: () => window.open(href, "_blank") });
      } else {
        toast(msg, true);
      }
      document.getElementById("asg-bulk").open = false;
      if (filter) filter.value = "";
      loadAssignments();
    } catch (e) {
      setMsg("asg-bulk-msg", e.message, false);
      go.disabled = false;
    }
  });
})();

// Response-status filter ('all' | 'pending' | 'accepted' | 'declined') + the
// fetched assignment list, kept module-level so toggling a filter re-renders
// from memory (no refetch). Declines sort first within the active filter so the
// TD sees what needs re-staffing without scrolling.
let _asgRespFilter = "all";
let _asgFilterTid = null;  // tournament the current filter applies to
let _asgState = null;
const _RESP_ORDER = { declined: 0, pending: 1, accepted: 2 };
function _renderAsgList() {
  if (!_asgState) return;
  const { list, availByOfficial } = _asgState;
  const counts = { all: list.length, pending: 0, accepted: 0, declined: 0 };
  for (const a of list) counts[a.response_status] = (counts[a.response_status] || 0) + 1;
  // Summary line — declines highlighted as the actionable number. When there are
  // pending responders with an email on file, offer a one-click "chase" mailto
  // that BCCs all of them so the TD can nudge non-responders before the event.
  const pendingEmails = [...new Set(list
    .filter((a) => a.response_status === "pending" && a.official_email)
    .map((a) => a.official_email))];
  let chase = "";
  if (pendingEmails.length) {
    const subj = encodeURIComponent(`Assignment confirmation needed — ${active.name}`);
    const bodyTxt = encodeURIComponent(`Please confirm (accept or decline) your assignment for ${active.name} via your CourtOps self-service "My assignments" page. Thank you.`);
    const href = `mailto:?bcc=${encodeURIComponent(pendingEmails.join(","))}&subject=${subj}&body=${bodyTxt}`;
    chase = ` · <a href="${href}" class="chase-link">✉ Email ${pendingEmails.length} pending</a>`;
  }
  const sum = document.getElementById("asg-resp-summary");
  sum.innerHTML = `${counts.all} assigned · <span class="resp-ok">${counts.accepted} accepted</span> · ` +
    `${counts.pending} pending · <span class="${counts.declined ? "resp-bad" : ""}">${counts.declined} declined</span>` +
    (counts.declined ? " — needs re-staffing" : "") + chase;
  document.getElementById("asg-respbar").hidden = false;
  // Reflect counts on the filter chips + active state.
  document.querySelectorAll("#asg-respbar .chip-toggle").forEach((btn) => {
    const k = btn.dataset.resp;
    btn.classList.toggle("is-on", k === _asgRespFilter);
    const n = counts[k] ?? 0;
    btn.disabled = k !== "all" && n === 0;
  });
  const box = document.getElementById("asg-list");
  box.innerHTML = "";
  const shown = list
    .filter((a) => _asgRespFilter === "all" || a.response_status === _asgRespFilter)
    .sort((x, y) => (_RESP_ORDER[x.response_status] ?? 3) - (_RESP_ORDER[y.response_status] ?? 3));
  if (!shown.length) {
    box.innerHTML = hstr`<div class="grid-empty"><span class="grid-empty-icon" aria-hidden="true">✦</span> No ${_asgRespFilter} assignments.</div>`;
    return;
  }
  for (const a of shown) box.appendChild(renderAssignment(a, (availByOfficial[a.official_id] || []).sort()));
}
// Official accept/decline status → a colored chip (TD card + self-service).
const _RESP_META = { pending: ["muted", "⏳ pending"], accepted: ["ok", "✓ accepted"], declined: ["bad", "✗ declined"] };
function _respChip(status) {
  const [cls, label] = _RESP_META[status] || ["muted", status || ""];
  return hstr`<span class="badge badge-${cls}" title="official's accept/decline">${label}</span>`;
}
function renderAssignment(a, availDates) {
  const card = document.createElement("div");
  card.className = "asg";
  // Structured header: name + actions on top; venue/hotel meta line; then
  // pay/mileage/total badges and any flags as colored chips (no run-on line).
  // Mileage = $0 with a distance ON FILE is legitimate (the first 50 round-trip
  // miles are free), but reads like a broken/missing calc — distinguish it from
  // the genuine "no distance" state with a hint (E2E finding F1).
  const mileage = a.missing_distance ? '<span class="warn">no distance</span>'
    : (a.mileage == null ? "—"
       : (a.mileage === 0 && a.one_way_miles != null
          ? hstr`$0.00 <span class="muted" title="${"Within the first 50 free round-trip miles (" + a.one_way_miles + " mi one-way) — no mileage owed."}">(free band)</span>`
          : "$" + a.mileage.toFixed(2)));
  // Cross-tournament double-booking (a warning, not a block — audit §3.4). A
  // different-site clash is impossible (badge-bad); same/no site is a soft
  // heads-up (badge-warn). Tooltip lists where else the official is booked.
  const conflictTitle = "Also booked the same day — " + (a.conflicts || []).map(
    (c) => `${c.work_date}${c.other_site ? ` @ ${c.other_site}` : ""} (${c.other_tournament})`
  ).join("; ");
  const flagChips = [
    a.has_conflict ? hstr`<span class="badge badge-${a.has_hard_conflict ? "bad" : "warn"}" title="${conflictTitle}">⚠ double-booked</span>` : "",
    a.hotel_date_mismatch ? '<span class="badge badge-warn">⚠ hotel dates</span>' : "",
    a.work_date_out_of_window ? '<span class="badge badge-warn">⚠ off-window day</span>' : "",
    (a.days_outside_availability && a.days_outside_availability.length)
      ? hstr`<span class="badge badge-warn" title="${"Worked on day(s) the official did not declare available: " + a.days_outside_availability.join(", ")}">⚠ not available</span>` : "",
    (a.uncertified_days && a.uncertified_days.length)
      ? hstr`<span class="badge badge-bad" title="${"Assigned a role the official isn't certified for: " + a.uncertified_days.map((u) => certLabel(u.working_as) + " on " + u.work_date).join("; ")}">⚠ not certified</span>` : "",
    a.missing_distance ? '<span class="badge badge-muted">no distance</span>' : "",
    // Day-of truth (P4-1): pay already excludes these days; the badge says why.
    a.no_show_days ? `<span class="badge badge-bad" title="No-show day(s) are excluded from pay">✗ ${a.no_show_days} no-show</span>` : "",
  ].filter(Boolean).join(" ");
  // Money audit (§5.3): a tooltip on the total badge showing the FROZEN calc
  // inputs (miles + rule constants) so the TD can see how a figure was reached.
  const pa = a.pay_audit;
  // Plain (unescaped) string; the title attribute is escaped where it's built
  // (hstr fragment in the head template below).
  const auditTip = pa
    ? `Frozen audit — ${pa.rule_version || ""} · ` +
      `miles ${pa.one_way_miles ?? "—"} · rate $${pa.constants?.mileage_rate}/mi · ` +
      `first ${pa.constants?.free_miles}mi free · cap $${pa.constants?.mileage_cap} · ` +
      `pay $${pa.pay} + mileage $${pa.mileage ?? 0} = $${pa.total}`
    : "";
  const head = document.createElement("div"); head.className = "asg-head";
  // Contact line — shown for pending responders so the TD can chase directly
  // (mailto/tel). Hidden once accepted/declined to keep the card uncluttered.
  let contact = "";
  if (a.response_status === "pending" && (a.official_email || a.official_phone)) {
    const parts = [];
    if (a.official_email) parts.push(hstr`<a href="mailto:${a.official_email}?subject=${encodeURIComponent("Assignment confirmation — " + (active ? active.name : ""))}">${a.official_email}</a>`);
    if (a.official_phone) parts.push(hstr`<a href="tel:${a.official_phone}">${a.official_phone}</a>`);
    contact = `<div class="asg-contact">awaiting response · ${parts.join(" · ")}</div>`;
  }
  // Built with the auto-escaping html`` helper (P2 #12): plain ${text} is
  // HTML-escaped, raw(...) marks already-trusted markup (badges, the contact
  // line, the pre-escaped audit-title attribute fragment, mileage's free-band
  // span). site_label/hotel_name fall back with `|| "—"` BEFORE interpolation
  // so the em-dash isn't escaped away.
  head.innerHTML = html`
    <div class="asg-name"><strong>${a.official_name}</strong></div>
    <div class="asg-meta">site: ${a.site_label || "—"} · hotel: ${a.hotel_name || "—"}${a.dietary_restrictions ? html` · diet: ${a.dietary_restrictions}` : ""}</div>
    ${raw(contact)}
    <div class="asg-badges">
      <span class="badge badge-info">pay $${a.pay.toFixed(2)}</span>
      <span class="badge badge-info">mileage ${raw(mileage)}</span>
      <span class="badge badge-ok"${auditTip ? raw(hstr` title="${auditTip}"`) : ""}>total $${a.total.toFixed(2)}${pa ? " ⓘ" : ""}</span>
      ${raw(_respChip(a.response_status))}${flagChips ? raw(" " + flagChips) : ""}
    </div>`;
  const actions = document.createElement("span"); actions.className = "asg-actions";
  const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
  ed.addEventListener("click", () => {
    asgEditId = a.id; _reassignDays = null;   // editing is not a reassign
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
  // Reassign: only offered when the official DECLINED. Pre-fills the add-form
  // with the same site/hotel (NOT the official — that's the point) and stashes
  // the declined days so they copy onto the replacement on save. The declined
  // assignment is left in place as an audit trail (TD deletes it if desired).
  let ra = null;
  if (a.response_status === "declined") {
    ra = document.createElement("button"); ra.type = "button"; ra.className = "btn-link"; ra.textContent = "Reassign";
    ra.addEventListener("click", () => {
      asgReset();                                   // ensure create mode (clears edit id)
      _reassignDays = a.days.map((d) => ({ work_date: d.work_date, working_as: d.working_as }));
      asgForm.official_id.value = "";               // TD picks the replacement
      asgForm.site_id.value = a.site_id || "";
      asgForm.room_block_id.value = a.room_block_id || "";
      openForm(asgForm);
      if (typeof syncCombos === "function") syncCombos();
      asgForm.scrollIntoView({ block: "nearest" });
      const dn = _reassignDays.length;
      setMsg("asg-msg", `reassigning ${a.official_name}'s declined slot — pick a new official; ${dn} day(s) will be copied`, true);
      asgForm.official_id.focus();
    });
  }
  // ✉ Invite: compose a personalised assignment email (this official's days,
  // role, site, pay) — copy it to the clipboard and, if an email is on file,
  // offer to open a pre-filled message.
  const inv = document.createElement("button");
  inv.type = "button"; inv.className = "btn-link"; inv.textContent = "✉ Invite";
  inv.title = "Copy a ready-to-paste assignment email for this official";
  inv.addEventListener("click", async () => {
    let t;
    try { t = await api(`/assignments/${a.id}/invite-text`); }
    catch (e) { toast(e.message, false); return; }
    const full = `Subject: ${t.subject}\n\n${t.body}`;
    try { await navigator.clipboard.writeText(full); } catch (_) {}
    const action = t.official_email ? {
      label: "Open email →",
      onClick: () => window.open(
        `mailto:${encodeURIComponent(t.official_email)}?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(t.body)}`,
        "_blank"),
    } : null;
    toast(`Invite for ${a.official_name} copied to clipboard${t.official_email ? "" : " (no email on file)"}`, true, action);
  });
  // 📅 .ics: download this official's full schedule (all tournaments) as an
  // iCalendar file the TD can forward — same feed the official sees in the portal.
  const ics = document.createElement("a");
  ics.className = "btn-link"; ics.textContent = "📅 .ics";
  ics.href = `/api/officials/${a.official_id}/schedule.ics`;
  ics.setAttribute("download", "");
  ics.title = "Download this official's assignment days as an iCalendar (.ics) file";
  // P4-5: who/when/what trail for this assignment (audit table).
  const hist = document.createElement("button");
  hist.type = "button"; hist.className = "btn-link"; hist.textContent = "History";
  hist.title = "Change history: who did what, when";
  hist.addEventListener("click", () => showAssignmentHistory(a));
  actions.append(ed, inv, ...(ra ? [ra] : []), ics, hist, dl); head.appendChild(actions); card.appendChild(head);

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
    // Day-of truth (P4-1): the chip wears the actual status — no_show struck
    // through (and excluded from pay server-side), worked green, early dashed.
    const st = d.actual_status || "planned";
    if (st !== "planned") chip.classList.add("st-" + st);
    const oow = _outOfWindow(d.work_date);
    chip.innerHTML = html`${oow ? raw('<span class="warn" title="outside the play window">⚠ </span>') : ""}${
      d.conflict ? raw('<span class="warn" title="double-booked: this official is assigned elsewhere this day">⚠ </span>') : ""}${
      d.outside_availability ? raw('<span class="warn" title="official did not declare this day available">⚠ </span>') : ""}${
      d.uncertified ? raw('<span class="warn" title="official is not certified for this role">⚠ </span>') : ""}${fmtDOW(d.work_date)} · ${certLabel(d.working_as)} $${d.rate_applied.toFixed(2)} `;
    const setSt = async (status) => {
      try {
        await api(`/assignment-days/${d.id}/status`, { method: "PUT", body: JSON.stringify({ actual_status: status }) });
        toast(`${fmtDOW(d.work_date)}: ${status.replace("_", " ")}`, true);
        loadAssignments();
      } catch (e) { setMsg("asg-msg", e.message, false); }
    };
    const stGlyph = { planned: "○", worked: "✓", no_show: "✗", early_departure: "◔" }[st];
    const stMenu = makeMenuButton(stGlyph, [
      { label: "Worked ✓", title: "Showed and worked the day", onClick: () => setSt("worked") },
      { label: "Early departure ◔", title: "Worked part of the day", onClick: () => setSt("early_departure") },
      { label: "No-show ✗ (drops from pay)", danger: true, onClick: () => setSt("no_show") },
      { separator: true },
      { label: "Reset to planned ○", onClick: () => setSt("planned") },
    ], { className: "btn-icon chip-status", title: `Day-of status: ${st.replace("_", " ")}`, anchor: true, noCaret: true });
    chip.appendChild(stMenu);
    const x = document.createElement("button"); x.type = "button"; x.className = "chip-x"; x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${fmtDOW(d.work_date)}`);
    x.addEventListener("click", async () => { try { await api(`/assignment-days/${d.id}`, { method: "DELETE" }); loadAssignments(); } catch (e) { setMsg("asg-msg", e.message, false); } });
    chip.appendChild(x); days.appendChild(chip);
  }
  if (!a.days.length) days.innerHTML = '<span class="muted">No days assigned yet.</span>';
  card.appendChild(days);

  // Add days: a labelled certification dropdown + the official's available days
  // (select all / individual), falling back to a manual date if no availability
  // is on file.
  const addRow = document.createElement("div"); addRow.className = "add-day";
  const addLbl = document.createElement("span"); addLbl.className = "add-day-label";
  addLbl.textContent = "Add day(s) as";
  addRow.appendChild(addLbl);
  const certSel = document.createElement("select");
  certSel.setAttribute("aria-label", "Role for the added day(s)");
  _certs.pairs.forEach(([v, lbl]) => { const o = document.createElement("option"); o.value = v; o.textContent = lbl; certSel.appendChild(o); });
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
    manualIn.setAttribute("aria-label", "Work date to add");
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
    // Certification pre-check: the backend hard-blocks adding a role the official
    // doesn't hold (409). Stop early with a friendly message + a pointer to fix
    // it, instead of letting the POST fail mid-loop.
    const held = a.held_certs || [];
    if (!held.includes(certSel.value)) {
      setMsg("asg-msg", `${a.official_name} is not certified for ${certLabel(certSel.value)} — add the certification on the Official record first, or pick a role they hold.`, false);
      return;
    }
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
// Days stashed by a "Reassign" click, copied onto the replacement assignment on
// the next create. Cleared on reset so a normal add never inherits them.
let _reassignDays = null;
function asgReset() {
  asgEditId = null; _reassignDays = null;
  asgForm.reset(); asgForm.querySelector('button[type="submit"]').textContent = "Add official";
}
onSubmit(asgForm, async (e) => {
  const b = formObj(asgForm);
  b.official_id = Number(b.official_id);
  b.site_id = b.site_id ? Number(b.site_id) : null;
  b.room_block_id = b.room_block_id ? Number(b.room_block_id) : null;
  try {
    if (asgEditId) {
      await api(`/assignments/${asgEditId}`, { method: "PUT", body: JSON.stringify(b) });
    } else {
      const created = await api(`/tournaments/${active.id}/assignments`, { method: "POST", body: JSON.stringify(b) });
      // Reassign-from-declined: copy the declined slot's days onto the new
      // official's assignment so the TD doesn't re-enter them by hand.
      if (_reassignDays && _reassignDays.length && created && created.id) {
        for (const d of _reassignDays) {
          try { await api(`/assignments/${created.id}/days`, { method: "POST", body: JSON.stringify(d) }); }
          catch (de) { toast(`couldn't copy ${d.work_date}: ${de.message}`, false); }
        }
      }
    }
    setMsg("asg-msg", asgEditId ? "saved" : "added", true); asgReset(); loadAssignments();
  } catch (err) { setMsg("asg-msg", err.message, false); markInvalid(asgForm, err.message); }
});
asgForm.querySelector(".cancel").addEventListener("click", asgReset);

// --- Room blocks (tournament-scoped) ---
const trbForm = document.getElementById("trb-form");
let trbEditId = null;
const trbGrid = makeListGrid("trb-table", [
  { title: "ID", field: "id", width: 64 },
  { title: "Hotel", field: "hotel_id", formatter: (c) => { const b = c.getData(); return hstr`${hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : b.hotel_id}`; },
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
  prereqCallout("panel-t-roomblocks", !Object.keys(hotelsById).length,
    "No hotels in the catalog yet — add them before creating room blocks.",
    "tab-panel-hotels");
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
    formatter: (c) => hstr`${STAFF_ROLES[c.getValue()] || c.getValue()}`,
    editor: "list", editorParams: { values: STAFF_ROLES } },
  { title: "Days", field: "days", headerSort: false,
    formatter: (c) => hstr`${(c.getValue() || []).map(fmtDOW).join(", ")}` },
  { title: "Rate/day", field: "daily_rate", hozAlign: "right", width: 90,
    formatter: (c) => (c.getValue() != null ? money(c.getValue()) : "") },
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
    staffForm.daily_rate.value = s.daily_rate != null ? s.daily_rate : "";
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
// =================== Assignment change history (P4-5) ===================
const _AUDIT_LABEL = {
  created: "Assignment created", updated: "Assignment updated",
  deleted: "Assignment deleted", day_added: "Day added",
  day_removed: "Day removed", day_status: "Day-of status set",
  response: "Official responded",
};
function _auditDetail(row) {
  const d = row.detail || {};
  const bits = [];
  if (d.work_date) bits.push(fmtDOW(d.work_date));
  if (d.working_as) bits.push(certLabel(d.working_as));
  if (d.actual_status) bits.push(d.actual_status.replace("_", " "));
  if (d.status) bits.push(d.status);
  if (d.via) bits.push(`via ${d.via}`);
  if (row.action === "updated") {
    if (d.site_id != null) bits.push(`site #${d.site_id}`);
    if (d.room_block_id != null) bits.push(`room block #${d.room_block_id}`);
  }
  return bits.join(" · ");
}
async function showAssignmentHistory(a) {
  let rows;
  try { rows = await api(`/assignments/${a.id}/audit`); }
  catch (e) { toast(e.message, false); return; }
  let m = document.getElementById("asg-history-modal");
  if (!m) {
    m = document.createElement("div"); m.id = "asg-history-modal"; m.className = "modal"; m.hidden = true;
    m.innerHTML = '<div class="modal-box modal-box--wide" role="dialog" aria-modal="true" aria-labelledby="asg-hist-title">' +
      '<h3 id="asg-hist-title" class="detail-title"></h3>' +
      '<div id="asg-hist-body" style="max-height:60vh;overflow:auto"></div>' +
      '<div class="modal-actions"><button type="button" id="asg-hist-close">Close</button></div></div>';
    document.body.appendChild(m);
    m.querySelector("#asg-hist-close").addEventListener("click", () => { m.hidden = true; });
    m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !m.hidden) m.hidden = true; });
  }
  m.querySelector("#asg-hist-title").textContent = `History — ${a.official_name}`;
  const body = m.querySelector("#asg-hist-body");
  if (!rows.length) {
    body.innerHTML = '<p class="muted">No recorded changes yet (the trail starts with migration 0044 — earlier edits predate it).</p>';
  } else {
    body.innerHTML = html`<table class="list-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${
      rows.map((r) => html`<tr><td>${new Date(r.changed_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>${r.changed_by}</td><td>${_AUDIT_LABEL[r.action] || r.action}</td><td class="muted">${_auditDetail(r)}</td></tr>`)
    }</tbody></table>`;
  }
  m.hidden = false;
}

// =================== Incidents (P4-3 day-of log) ===================
const incidentForm = document.getElementById("incident-form");
let incEditId = null, incEditRow = null;
function incReset() {
  incEditId = null; incEditRow = null; incidentForm.reset();
  incidentForm.querySelector('button[type="submit"]').textContent = "Log incident";
  scheduleComboSync();
}
const INC_CATS = { weather: "Weather", injury: "Injury", dispute: "Dispute",
                   facility: "Facility", conduct: "Conduct", other: "Other" };
const incidentsGrid = makeListGrid("incidents-table", [
  { title: "When", field: "occurred_at", width: 150,
    formatter: (c) => hstr`${new Date(c.getValue()).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` },
  { title: "Category", field: "category", width: 110,
    formatter: (c) => hstr`${INC_CATS[c.getValue()] || c.getValue()}`,
    headerFilter: "list", headerFilterParams: { values: INC_CATS, clearable: true } },
  { title: "Sev", field: "severity", width: 80,
    formatter: (c) => c.getValue() === "major"
      ? '<span class="badge badge-bad">major</span>'
      : c.getValue() === "minor" ? '<span class="badge badge-warn">minor</span>' : '<span class="muted">info</span>' },
  { title: "Site", field: "site_label", width: 90,
    formatter: (c) => c.getValue() ? hstr`${c.getValue()}` : '<span class="muted">—</span>' },
  { title: "What happened", field: "description", widthGrow: 2, headerFilter: "input",
    formatter: (c) => c.getRow().getData().resolved
      ? hstr`<span class="muted">${c.getValue()}</span>` : hstr`${c.getValue()}` },
  // Day-of flow: type the outcome straight into the Resolution cell — saving a
  // non-empty resolution marks the incident resolved (and clearing it reopens).
  { title: "Resolution", field: "resolution", widthGrow: 1, editor: "input", cssClass: "editable-cell",
    formatter: (c) => c.getValue()
      ? hstr`<span class="ok">✓</span> ${c.getValue()}`
      : '<span class="muted" title="Click to type a resolution — saving resolves the incident">open…</span>' },
], "incidents", "No incidents logged — that's a good day.",
  async (i) => { if (!(await confirmDialog("Delete this incident?"))) return;
    try { await api(`/incidents/${i.id}`, { method: "DELETE" }); loadIncidents(); }
    catch (e) { setMsg("incident-msg", e.message, false); } },
  (i) => {
    incEditId = i.id; incEditRow = i;
    incidentForm.category.value = i.category;
    incidentForm.severity.value = i.severity;
    incidentForm.site_id.value = i.site_id || "";
    incidentForm.description.value = i.description;
    incidentForm.querySelector('button[type="submit"]').textContent = "Update incident";
    openForm(incidentForm);
    scheduleComboSync();
  },
  async (cell) => {
    if (cell.getValue() === cell.getOldValue()) return;
    const i = cell.getRow().getData();
    const resolution = (i.resolution || "").trim() || null;
    try {
      await api(`/incidents/${i.id}`, { method: "PUT", body: JSON.stringify({
        site_id: i.site_id, occurred_at: i.occurred_at, category: i.category,
        severity: i.severity, description: i.description,
        resolved: !!resolution, resolution }) });
      setMsg("incident-msg", resolution ? "resolved" : "reopened", true);
      loadIncidents();
    } catch (e) { setMsg("incident-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadIncidents(); }
  });
// D11: day-of venue panel (./app/dayof.js)
const { loadDayOf, resetStickyDate: _dayOfReset } = createDayOfPanel({
  api, toast, setMsg, html, hstr, raw, fmtMDY: _fmtMDY, certLabel, respChip: _respChip,
  getActive: () => active, getCertPairs: () => _certs.pairs,
});
_resetDayOfDate = _dayOfReset;

async function loadIncidents() {
  if (!active) return;
  fillSelect(document.getElementById("inc-site"), Object.values(sitesById), siteLabel, true);
  incidentsGrid.setData(await api(`/tournaments/${active.id}/incidents`));
}
onSubmit(incidentForm, async () => {
  if (!active) return;
  const body = {
    category: incidentForm.category.value,
    severity: incidentForm.severity.value,
    site_id: incidentForm.site_id.value ? Number(incidentForm.site_id.value) : null,
    description: incidentForm.description.value.trim(),
  };
  try {
    if (incEditId != null) {
      const cur = incEditRow || {};
      await api(`/incidents/${incEditId}`, { method: "PUT", body: JSON.stringify({
        ...body, occurred_at: cur.occurred_at,
        resolved: !!cur.resolved, resolution: cur.resolution || null }) });
      setMsg("incident-msg", "updated", true);
    } else {
      await api(`/tournaments/${active.id}/incidents`, { method: "POST", body: JSON.stringify(body) });
      setMsg("incident-msg", "logged", true);
    }
    incReset(); loadIncidents();
  } catch (e) { setMsg("incident-msg", e.message, false); markInvalid(incidentForm, e.message); }
});
incidentForm.querySelector(".cancel").addEventListener("click", incReset);

// D11: payroll panel lives in ./app/payroll.js (pairs with backend payroll router)
const { loadPayroll } = createPayrollPanel({
  api, setMsg, confirmDialog, markInvalid, money, html, hstr, raw,
  makeReadGrid, printDoc, fmtMDY: _fmtMDY, getActive: () => active,
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
  b.daily_rate = b.daily_rate ? Number(b.daily_rate) : null;
  try {
    if (staffEditId) await api(`/staff/${staffEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/tournaments/${active.id}/staff`, { method: "POST", body: JSON.stringify(b) });
    setMsg("staff-msg", staffEditId ? "saved" : "added", true); staffReset(); loadStaff();
  } catch (err) { setMsg("staff-msg", err.message, false); markInvalid(staffForm, err.message); }
});
staffForm.querySelector(".cancel").addEventListener("click", staffReset);

// D11: availability panel (./app/availability.js)
const { loadAvailability } = createAvailabilityPanel({
  api, setMsg, toast, html, hstr, raw, fmtDOW, fillSelect, officialLabel, certLabel,
  makeReadGrid, getActive: () => active, getOfficialsById: () => officialsById,
  getCertPairs: () => _certs.pairs,
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
  if (!meta) return v ? hstr`<span class="badge badge-muted">${v}</span>` : "";
  return hstr`<span class="badge badge-${meta.color}">${meta.label}</span>`;
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
  fuzzy_name:        { dot: "◐", cls: "warn", label: "Name matched after normalizing (inversion / middle name / accent) — medium confidence" },
  lastname_subject:  { dot: "○", cls: "warn", label: "Surname only (subject) — please verify" },
  lastname:          { dot: "○", cls: "warn", label: "Surname only — please verify" },
  firstname:         { dot: "○", cls: "warn", label: "First name only (unique on the roster) — please verify" },
  usta_offroster:    { dot: "◑", cls: "warn", label: "Matched by USTA # — but this player is NOT on this tournament's roster; add them" },
  manual:            { dot: "✎", cls: "info", label: "Set manually" },
};
// Per-email detection CONFIDENCE for the inbox grid, derived from how the
// player was identified. High = a USTA # / full name in the subject (or a manual
// pick); Medium = full name in the body / a fuzzy or off-roster match; Low = a
// surname/first-name-only guess, or a name parsed from the text but not yet
// matched to the roster. Returns null when nothing was identified.
const _CONF_TIER = {
  usta: 3, withdraw_template: 3, usta_subject: 3, fullname_subject: 3, manual: 3,
  fullname_body: 2, fuzzy_name: 2, usta_offroster: 2,
  lastname_subject: 1, lastname: 1, firstname: 1,
};
const _CONF_LABEL = { 3: ["High", "ok"], 2: ["Medium", "warn"], 1: ["Low", "bad"] };
function _inboxConfidence(m) {
  if (m.detected_player_id != null) {
    const [label, cls] = _CONF_LABEL[_CONF_TIER[m.detected_match_kind] || 2];
    return { label, cls, title: (MATCH_KIND_META[m.detected_match_kind] || {}).label || "Matched to a roster player" };
  }
  // not matched, but the email named someone / carried a USTA # → low (a lead to confirm)
  if ((m.detected_name_pairs || []).length || m.detected_usta_text) {
    return { label: "Low", cls: "bad",
             title: "Parsed from the email but not matched to the roster — confirm or add the player" };
  }
  return null;
}
function matchHint(kind) {
  const m = MATCH_KIND_META[kind];
  if (!m) return "";
  return hstr` <span class="match-hint match-${m.cls}" title="${m.label}" aria-label="${m.label}">${m.dot}</span>`;
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
async function _inboxPut(m, patch = {}) {
  // Full-body PUT: the endpoint overwrites detected_player_id/partner with
  // whatever we send, so every call carries the row's current links and the
  // caller overrides just the field it changed — omitting one would silently
  // unlink that player.
  await api(`/emails/${m.id}`, { method: "PUT", body: JSON.stringify({
    // Preserve the email's OWN tournament — the inbox is cross-tournament, so
    // forcing active.id here silently re-homed an email belonging to another
    // tournament whenever its classification was changed/suggested. Only fall
    // back to the active workspace for an as-yet-unassigned email.
    tournament_id: m.tournament_id ?? (active && active.id) ?? null,
    classification: m.classification, status: m.status,
    detected_player_id: m.detected_player_id ?? null,
    detected_partner_id: m.detected_partner_id ?? null,
    ...patch,
  }) });
}
async function _inboxPutClass(m, classification) { await _inboxPut(m, { classification }); }

// What the two "Player N" column groups display for a row, resolved in priority
// order per slot: roster-matched player (auto-detected OR manually assigned) →
// (name, USTA#) parsed straight from the email text (✉, not rostered yet) →
// a bare email-text USTA #. Pairing-avoidance groups put the primary in slot 0
// and the rest of the group in slot 1.
function _inboxSlots(m) {
  const slots = [{}, {}];
  const pairs = m.detected_name_pairs || [];
  const matched = [m.detected_usta, m.detected_partner_usta].filter(Boolean);
  const text = (m.detected_usta_text || "").split(",").map((s) => s.trim())
    .filter((n) => n && !matched.includes(n));
  if (m.detected_player_name) {
    slots[0] = { id: m.detected_player_id, name: m.detected_player_name,
                 usta: m.detected_usta, matched: true, kind: m.detected_match_kind };
  } else if (pairs[0]) slots[0] = { name: pairs[0].name, usta: pairs[0].usta || text[0] };
  else if (text[0]) slots[0] = { usta: text[0] };
  if (m.detected_partner_name) {
    slots[1] = { id: m.detected_partner_id, name: m.detected_partner_name,
                 usta: m.detected_partner_usta, matched: true };
  } else if ((m.detected_member_names || []).length > 1) {
    slots[1] = { ids: (m.detected_member_ids || []).slice(1),
                 names: m.detected_member_names.slice(1), matched: true, group: true };
  } else if (pairs[1]) {
    slots[1] = { name: pairs[1].name,
                 usta: pairs[1].usta || (text[1] !== slots[0].usta ? text[1] : undefined) };
  } else if (text[1] && text[1] !== slots[0].usta) slots[1] = { usta: text[1] };
  return slots;
}
const _MAIL_MARK = ' <span class="muted" title="parsed from the email; not matched to the roster yet">✉</span>';
const _p360 = (pid, name) => pid
  ? hstr`<span class="p360-link" data-pid="${pid}" role="button" tabindex="0" title="View everything about this player (360)">${name}</span>`
  : hstr`${name}`;
// Roster dropdown for the manual player/partner pickers (typeahead list).
// Memoized: the sorted list is identical between roster reloads, but the editor
// opens (and rebuilt it) on every cell-edit; invalidated by _invalidatePickCache
// when playersById is rebuilt.
let _pickCache = null;
const _invalidatePickCache = () => { _pickCache = null; };
const _playerPickValues = () => (_pickCache ||= Object.values(playersById)
  .sort((a, b) => playerLabel(a).localeCompare(playerLabel(b)))
  .map((p) => ({ label: playerLabel(p), value: String(p.id) })));
const _PLAYER_EDITOR = {
  editor: "list", editorAutocomplete: true, cssClass: "editable-cell",
  editorParams: () => ({ values: _playerPickValues(), autocomplete: true,
    clearable: true, listOnEmpty: true, placeholderEmpty: "no roster match" }),
};
const _USTA_EDITOR = { editor: "input", cssClass: "editable-cell" };
// Small inline affordance button for the player cells (✎ edit / × clear / ＋ add).
// stopPropagation so the click does its own thing instead of opening the cell
// editor (the grid edits on a single click — see `editable: "click"` below).
function _iconBtn(glyph, title, onClick, extraClass) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn-icon inbox-affordance" + (extraClass ? " " + extraClass : "");
  b.textContent = glyph; b.title = title; b.setAttribute("aria-label", title);
  b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(ev); });
  return b;
}
// Unassign a slot. Clearing Player 1 clears Player 2 too (the partner is tied to
// a primary — the server enforces the same).
async function _inboxClearSlot(m, slot) {
  try {
    await _inboxPut(m, slot === 0
      ? { detected_player_id: null, detected_partner_id: null }
      : { detected_partner_id: null });
    await loadInbox();
  } catch (e) { toast(e.message, false); }
}
// Open the roster form pre-filled from this email (USTA #, name, division) —
// the same plan the ⋯ menu uses, surfaced directly on a parsed-but-unrostered
// (✉) player cell. rosterPrefillFromEmail is pure + unit-tested.
function _inboxAddToRoster(m, plan) {
  plan = plan || rosterPrefillFromEmail(m);
  document.querySelector('.tab[data-target="panel-t-roster"]')?.click();
  rosterShowNew();
  _rosterFromEmailId = m.id;   // re-detect this email after the save links it
  rosterSetMode(plan.mode);
  if (plan.mode === "pick") {
    const picker = rosterForm.elements.player_id;
    if (picker) { picker.value = plan.player_id; if (typeof picker._comboSync === "function") picker._comboSync(); }
    refreshDivisionLists(_inferFormGender(rosterForm));
  } else {
    if (plan.gender && rosterForm.elements.gender) rosterForm.elements.gender.value = plan.gender;
    refreshDivisionLists(plan.gender || _inferFormGender(rosterForm));
    rosterForm.elements.usta_number.value = plan.usta_number;
    if (plan.first_name) rosterForm.elements.first_name.value = plan.first_name;
    if (plan.last_name) rosterForm.elements.last_name.value = plan.last_name;
    const g = rosterForm.elements.gender;
    if (g && typeof g._comboSync === "function") g._comboSync();
  }
  const div = rosterForm.elements.age_division;
  if (div && plan.age_division && [...div.options].some((o) => o.value === plan.age_division)) {
    div.value = plan.age_division;
    if (typeof div._comboSync === "function") div._comboSync();
  }
  rosterOpenModal();
  scheduleComboSync();
  const who = [plan.first_name, plan.last_name].filter(Boolean).join(" ");
  toast(plan.offRoster
    ? `${m.detected_player_name} is in the system — pick a division and Save to add them to this roster`
    : `Pre-filled ${who || "from the email"} — ${plan.usta_number ? "confirm gender/division" : "add the USTA #, gender/division"}, then Save`, true);
}
// "Add both" for a name-only doubles pair: open the add-form for the first
// player now, queue the second so it opens after the first SAVE. Each player
// still gets a confirm step (the TD supplies the USTA # the email lacked).
function _inboxAddBothToRoster(m, plan0, plan1) {
  _rosterAddQueue = [{ m, plan: plan1 }];
  _inboxAddToRoster(m, plan0);
  const who1 = [plan1.first_name, plan1.last_name].filter(Boolean).join(" ");
  toast(`Adding both — confirm this player, then ${who1 || "the partner"} opens next`, true);
}
// Run player detection for one email and fold the result back into the row.
async function _inboxDetectInto(m, row) {
  try {
    const det = await api(`/emails/${m.id}/detect-player`, { method: "POST" });
    row.update({
      detected_player_id: det.detected_player_id, detected_usta: det.detected_usta,
      detected_player_name: det.detected_player_name, detected_match_kind: det.match_kind,
      detected_partner_id: det.detected_partner_id, detected_partner_name: det.detected_partner_name,
      detected_member_ids: det.detected_member_ids, detected_member_names: det.detected_member_names,
    });
    row.reformat();
    const who = (det.detected_member_names && det.detected_member_names.length > 1)
      ? det.detected_member_names.join(" + ")
      : det.detected_player_name
        ? det.detected_player_name + (det.detected_partner_name ? ` + ${det.detected_partner_name}` : "")
        : null;
    toast(who ? `Detected: ${who}` : "No player match", !!who);
  } catch (e) { toast(e.message, false); }
}
// Builds a "Player N" cell: matched roster player (360 link + ✎ change + × clear),
// a parsed-but-unrostered name (✉ + ✎ pick + ＋ add to roster), a pairing-group
// list, or an empty cell (Detect + ✎ pick for slot 0; ✎ for slot 1).
function _inboxNameCell(cell, slotIdx) {
  const m = cell.getData(); const row = cell.getRow();
  const all = _inboxSlots(m);  // computed once; reused for the "add both" peek below
  const s = all[slotIdx];
  const wrap = document.createElement("span");
  wrap.className = "inbox-name-cell";
  const editBtn = (title) => _iconBtn("✎", title || "Change — pick a roster player", () => cell.edit(true));

  if (s.group) {           // pairing-avoidance: the rest of the group (slot 1)
    wrap.innerHTML = s.names.map((n, i) => _p360(s.ids[i], n)).join(" + ");
    return wrap;
  }
  if (s.matched) {
    const nameSpan = document.createElement("span");
    nameSpan.innerHTML = _p360(s.id, s.name) + (slotIdx === 0 ? matchHint(s.kind) : "");
    wrap.append(nameSpan, editBtn(),
      _iconBtn("×", "Remove this player", () => _inboxClearSlot(m, slotIdx), "danger"));
    return wrap;
  }
  if (s.name) {            // parsed from the email text, not on the roster yet
    const nameSpan = document.createElement("span");
    nameSpan.innerHTML = hstr`${s.name}${raw(_MAIL_MARK)}`;
    wrap.append(nameSpan, editBtn());
    // Pre-fill the roster add-form from THIS cell's name (+ USTA # if present).
    const plan = rosterPrefillFromName(s.name, s.usta, m.detected_division);
    // When BOTH players of a name-only pair are unrostered, collapse the two
    // per-cell ＋ into a single "Add both" on the primary cell (it opens each
    // player's form in turn); otherwise just this cell's ＋.
    const other = all[slotIdx === 0 ? 1 : 0];
    const otherPlan = other && other.name && !other.matched
      ? rosterPrefillFromName(other.name, other.usta, m.detected_division) : { canAdd: false };
    if (plan.canAdd && otherPlan.canAdd) {
      if (slotIdx === 0) {
        wrap.append(_iconBtn("＋ both", "Add BOTH players to the roster (pre-filled; confirm each in turn)",
          () => _inboxAddBothToRoster(m, plan, otherPlan), "addboth"));
      }   // slot 1: covered by the "＋both" on the primary cell — no button here
    } else if (plan.canAdd) {
      wrap.append(_iconBtn("＋", "Add this player to the roster (pre-filled from the email)",
        () => _inboxAddToRoster(m, plan)));
    }
    return wrap;
  }
  if (slotIdx === 0) {     // empty primary — offer Detect + pick
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn-link inline-detect"; btn.textContent = "Detect";
    btn.title = "Detect the player this email is about";
    btn.addEventListener("click", (ev) => { ev.stopPropagation(); _inboxDetectInto(m, row); });
    wrap.append(btn, editBtn("Pick a roster player"));
    return wrap;
  }
  // empty partner slot
  const dash = document.createElement("span"); dash.className = "muted"; dash.textContent = "—";
  wrap.append(dash, editBtn("Add a second player"));
  return wrap;
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
  { title: "Received", field: "received_at", width: 110, formatter: (c) => hstr`${(c.getData().received_at || "").slice(0, 10)}` },
  // Which tournament this email is filed under. The inbox shows every
  // tournament's mail; this column (+ its header filter) is how the TD scopes
  // or reassigns. Header-filtered to the active tournament by default.
  { title: "Tournament", field: "tournament_name", width: 150,
    formatter: (c) => c.getValue() ? hstr`${c.getValue()}` : `<span class="muted">— unassigned —</span>`,
    headerFilter: "input" },
  { title: "From", field: "from_address" },
  { title: "Subject", field: "subject", formatter: (c) => {
      const m = c.getData();
      const corr = m.amends_email_id ? ' <span class="badge badge-info" title="corrects an earlier email">↻ correction</span>' : "";
      const sup = m.superseded ? ' <span class="badge badge-warn" title="a later email corrects this — revisit its filed row">⤺ superseded</span>' : "";
      return hstr`${m.subject || ""}${raw(corr)}${raw(sup)}`;
    } },
  // Two player-related column GROUPS — Player/USTA # and Player 2/USTA #2.
  // Each cell is double-click editable so the TD can manually assign a player
  // when detection can't: pick from the roster dropdown (name cell) or type a
  // USTA # (number cell). Display priority per slot: matched roster player →
  // (name, USTA#) parsed from the email text (✉) → bare email-text number.
  { title: "Player 1", columns: [
    { title: "Player", field: "detected_player_name", width: 165, ..._PLAYER_EDITOR,
      formatter: (cell) => _inboxNameCell(cell, 0),
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) =>
        ((e.detected_player_name || "") + " " + (e.detected_usta || ""))
          .toLowerCase().includes(String(term).toLowerCase()) },
    { title: "USTA #", field: "detected_usta", width: 115, ..._USTA_EDITOR,
      formatter: (c) => {
        const s = _inboxSlots(c.getData())[0];
        if (!s.usta) return '<span class="muted">—</span>';
        return hstr`${s.usta}${s.matched ? "" : raw(_MAIL_MARK)}`;
      },
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) =>
        ((e.detected_usta || "") + " " + (e.detected_usta_text || ""))
          .includes(String(term).trim()) },
  ] },
  { title: "Player 2", columns: [
    { title: "Player", field: "detected_partner_name", width: 165, ..._PLAYER_EDITOR,
      formatter: (cell) => _inboxNameCell(cell, 1),
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) =>
        ((e.detected_partner_name || "") + " " + ((e.detected_member_names || []).slice(1).join(" ")) + " " +
         (e.detected_partner_usta || "")).toLowerCase().includes(String(term).toLowerCase()) },
    { title: "USTA #", field: "detected_partner_usta", width: 115, ..._USTA_EDITOR,
      formatter: (c) => {
        const s = _inboxSlots(c.getData())[1];
        if (!s.usta) return '<span class="muted">—</span>';
        return hstr`${s.usta}${s.matched ? "" : raw(_MAIL_MARK)}`;
      },
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) => (e.detected_partner_usta || "").includes(String(term).trim()) },
  ] },
  { title: "Classification", field: "classification", width: 150, cssClass: "editable-cell",
    formatter: (c) => classChip(c.getValue()),
    editor: "list", editorParams: { values: EMAIL_CLASS_VALUES },
    headerFilter: "list", headerFilterParams: { values: EMAIL_CLASS_VALUES, clearable: true } },
  // How confident the auto-detection of the player is (see _inboxConfidence).
  { title: "Confidence", field: "_conf", width: 110, headerSort: false, hozAlign: "center",
    formatter: (c) => {
      const k = _inboxConfidence(c.getData());
      return k ? hstr`<span class="badge badge-${k.cls}" title="${k.title}">${k.label}</span>`
               : '<span class="muted" title="No player identified yet">—</span>';
    } },
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
            detected_partner_id: det.detected_partner_id,
            detected_partner_name: det.detected_partner_name,
            detected_member_ids: det.detected_member_ids,
            detected_member_names: det.detected_member_names,
          });
          row.reformat();
          const clsLabel = (EMAIL_CLASS_META[res.classification] || {}).label || res.classification;
          const who = (det.detected_member_names && det.detected_member_names.length > 1)
            ? ` · players: ${det.detected_member_names.join(" + ")}`
            : det.detected_player_name
              ? ` · player: ${det.detected_player_name}` +
                (det.detected_partner_name ? ` + ${det.detected_partner_name}` : "")
              : " · no player match";
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
        // Resolve the player to pre-select: the linked player, or — when none was
        // linked but the email carries a USTA # — the player with that USTA #
        // (precise even when surnames collide). The picker lists all players, so
        // an off-roster match still displays.
        const _fillPid = resolveFilePlayerId(m, Object.values(playersById));
        if (t.form.player_ref && _fillPid) {
          t.form.player_ref.value = String(_fillPid);
          // Sync the combobox display SYNCHRONOUSLY (not the rAF-debounced
          // scheduleComboSync): this same menu click bubbles to the document
          // click handler that closes open comboboxes, and close() resets the
          // select to blank when the combo's text input is still empty. Filling
          // the display now means the input is non-empty by the time that fires.
          if (typeof t.form.player_ref._comboSync === "function") t.form.player_ref._comboSync();
        }
        // Doubles names TWO players — carry the detected partner into the
        // partner picker the same way (still editable before saving).
        if (m.classification === "doubles" && t.form.partner_ref && m.detected_partner_id
            && playersById[m.detected_partner_id]) {
          t.form.partner_ref.value = String(m.detected_partner_id);
          if (typeof t.form.partner_ref._comboSync === "function") t.form.partner_ref._comboSync();
        }
        // Pairing-avoidance names a GROUP — build one member row per detected
        // player (still editable; the TD can add/remove rows before saving).
        if (m.classification === "pairing_avoidance"
            && (m.detected_member_ids || []).length >= 2 && t.form.id === "pairing-form") {
          pairingMembersBox.innerHTML = "";
          for (const pid of m.detected_member_ids) {
            pairingMemberRow();
            const sel = pairingMembersBox.lastElementChild.querySelector(".pm-player");
            if (sel && playersById[pid]) {
              sel.value = String(pid);
              if (typeof sel._comboSync === "function") sel._comboSync();
            }
          }
          while (pairingMembersBox.children.length < 2) pairingMemberRow();
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
      // Correction auto-rewrite: when this email amends an earlier one, update
      // that earlier email's filed row in place instead of filing a duplicate.
      const doApplyCorrection = async () => {
        try {
          const res = await api(`/emails/${m.id}/apply-correction`, { method: "POST" });
          toast(`Correction applied to the ${res.list} row`, true);
          loadInbox();
        } catch (e) { toast(e.message, false); }
      };
      // "Add to roster" — what to pre-fill is decided by the pure, unit-tested
      // rosterPrefillFromEmail(m) (see app/roster_prefill.js + its node test);
      // _inboxAddToRoster (module scope) APPLIES that plan and is also wired to
      // the ＋ affordance on a parsed-but-unrostered player cell.
      const _rosterPlan = rosterPrefillFromEmail(m);
      const offRoster = _rosterPlan.offRoster;
      const canAddToRoster = _rosterPlan.canAdd;
      // One-click "File pair": both doubles players matched (with USTA #s) →
      // record the confirmed pair directly, no manual partner-USTA entry.
      const canFilePair = m.classification === "doubles" && m.detected_player_id
        && m.detected_partner_id && m.detected_usta && m.detected_partner_usta;
      const doFilePair = async () => {
        try {
          if (m.tournament_id && (!active || m.tournament_id !== active.id)) setActive(String(m.tournament_id));
          const r = await api(`/tournaments/${m.tournament_id || active.id}/doubles-pairs`, {
            method: "POST",
            body: JSON.stringify({ usta_number: m.detected_usta, partner_usta: m.detected_partner_usta,
              age_division: m.detected_division || null, source_email_id: m.id }),
          });
          toast(r.already_existed
            ? `${m.detected_player_name} + ${m.detected_partner_name} are already paired`
            : `Filed pair: ${m.detected_player_name} + ${m.detected_partner_name}`, true);
          loadInbox();
        } catch (e) { toast(e.message, false); }
      };
      // Per-row status parity with the bulk toolbar: lets the TD clear a single
      // info-only email (hotel note, ack) — or flag one for follow-up — straight
      // from its row, without bulk-selecting. Reuses /emails/bulk/status.
      const doSetStatus = (status, verb) => async () => {
        try {
          await api("/emails/bulk/status", { method: "POST", body: JSON.stringify({ email_ids: [m.id], status }) });
          toast(verb, true); loadInbox();
        } catch (e) { toast(e.message, false); }
      };
      const statusItems = [
        ...(m.status !== "filed" ? [{ label: "Mark filed (handled)",
          title: "Clear this email out of the unfiled queue without creating a list row", onClick: doSetStatus("filed", "Marked filed") }] : []),
        ...(m.status !== "needs_followup" ? [{ label: "Flag for follow-up",
          title: "Mark this email as needing follow-up", onClick: doSetStatus("needs_followup", "Flagged for follow-up") }] : []),
        ...(m.status !== "new" ? [{ label: "Reopen (back to unfiled)",
          title: "Return this email to the unfiled queue", onClick: doSetStatus("new", "Reopened") }] : []),
      ];
      const items = [
        { label: "Suggest classification + player", title: "Run the local classifier and player detector", onClick: doSuggest },
        ...(canFilePair ? [{ label: "File pair (both players)",
          title: "Record the confirmed doubles pair for both detected players", onClick: doFilePair }] : []),
        { label: fileable ? `File as ${FILE_TARGETS[m.classification].label}` : "File (set a classification first)",
          title: fileable ? "" : "Pick a fileable classification first", onClick: () => { if (fileable) doFile(); } },
        ...(canAddToRoster ? [{ label: offRoster ? "Add to roster (player exists)" : "Add player to roster",
          title: offRoster ? "Add this existing player to the tournament roster" : "Open the roster form pre-filled with this email's USTA # + division", onClick: () => _inboxAddToRoster(m) }] : []),
        ...(m.amends_email_id ? [{ label: "Apply correction → update filed row",
          title: "Re-point the amended email's filed row to this one and re-apply the parsed fields", onClick: doApplyCorrection }] : []),
        { separator: true },
        ...statusItems,
        { separator: true },
        { label: "Delete email", danger: true, onClick: doDelete },
      ];
      const menu = makeMenuButton("⋯", items, { className: "btn-icon row-more", title: "More actions", anchor: true, noCaret: true });
      wrap.append(rvBtn, menu); return wrap;
    } },
], "inbox", "Inbox empty — add a forwarded email above.", { index: "id", editable: "click", persist: false, responsive: false });
// Persist inline edits (single click a cell): classification, manual player /
// partner picks (the list editor's value is a player id), and typed USTA #s
// (resolved against the roster cache; unknown numbers revert with a toast).
// The 360 link, Detect, and the ✎/×/＋ affordances stopPropagation so they act
// instead of opening the editor.
inboxGrid.grid.on("cellEdited", async (cell) => {
  const f = cell.getField(); const m = cell.getData();
  if (cell.getValue() === cell.getOldValue()) return;
  const revert = () => { try { cell.restoreOldValue(); } catch (_) {} };
  try {
    if (f === "classification") {
      await _inboxPutClass(m, cell.getValue()); cell.getRow().reformat(); return;
    }
    if (f === "detected_player_name" || f === "detected_partner_name") {
      const v = cell.getValue();
      const pid = (v === "" || v == null) ? null : Number(v);
      if (pid != null && !playersById[pid]) { revert(); return; }
      if (f === "detected_partner_name") {
        // the backend ties the partner to a primary — there's no partner-only row
        if (pid != null && !m.detected_player_id) { toast("Pick Player 1 first", false); revert(); return; }
        await _inboxPut(m, { detected_partner_id: pid });
      } else {
        // clearing the primary clears the partner too (server does the same)
        await _inboxPut(m, { detected_player_id: pid, ...(pid == null ? { detected_partner_id: null } : {}) });
      }
      await loadInbox(); return;
    }
    if (f === "detected_usta" || f === "detected_partner_usta") {
      const typed = String(cell.getValue() || "").replace(/\D/g, "");
      if (!typed) { revert(); return; }
      const hit = Object.values(playersById).find((p) => String(p.usta_number || "") === typed);
      if (!hit) { toast(`No player with USTA # ${typed} — add them via Players first`, false); revert(); return; }
      if (f === "detected_partner_usta") {
        if (!m.detected_player_id) { toast("Pick Player 1 first", false); revert(); return; }
        await _inboxPut(m, { detected_partner_id: hit.id });
      } else {
        await _inboxPut(m, { detected_player_id: hit.id });
      }
      toast(`Assigned ${playerLabel(hit)}`, true);
      await loadInbox(); return;
    }
  } catch (e) { setMsg("email-msg", e.message, false); revert(); }
});

// Detail pane: clicking a row opens it below the grid. Lets the TD read the
// full email body and override the classification or status.
let _inboxDetailId = null;
let _inboxDetailTid = null;  // the open email's own tournament_id (preserved on save)
let _inboxDetailPartnerId = null;  // detected partner — preserved on save (the pane has no partner picker)
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
  _inboxDetailPartnerId = m.detected_partner_id ?? null;
  const box = document.getElementById("inbox-detail");
  box.hidden = false;
  document.getElementById("inbox-detail-subject").textContent = m.subject || "(no subject)";
  document.getElementById("inbox-detail-from").textContent = m.from_address || "(no sender)";
  document.getElementById("inbox-detail-to").textContent = m.to_address || "—";
  document.getElementById("inbox-detail-received").textContent = (m.received_at || "").slice(0, 16).replace("T", " ");
  document.getElementById("inbox-detail-source").textContent = m.ingest_source || "manual";
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
  // Amendment picker: the earlier email this one corrects + the superseded flag.
  _populateInboxAmendsSelect(m);
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
// Fill the "corrects earlier email" picker with the other emails in this
// email's tournament, select the current link, and show the superseded flag.
async function _populateInboxAmendsSelect(m) {
  const sel = document.getElementById("inbox-detail-amends");
  if (!sel) return;
  sel.innerHTML = '<option value="">— not a correction —</option>';
  if (m.tournament_id) {
    let emails = [];
    try { emails = await api(`/emails?tournament_id=${m.tournament_id}`); } catch (_) {}
    for (const e of emails) {
      if (e.id === m.id) continue;
      const o = document.createElement("option");
      o.value = e.id;
      o.textContent = `#${e.id} ${(e.subject || "(no subject)").slice(0, 60)}`;
      sel.appendChild(o);
    }
  }
  sel.value = m.amends_email_id || "";
  document.getElementById("inbox-detail-superseded").hidden = !m.superseded;
}
document.getElementById("inbox-detail-amends")?.addEventListener("change", async (e) => {
  if (_inboxDetailId == null) return;
  try {
    await api(`/emails/${_inboxDetailId}/amends`, { method: "POST",
      body: JSON.stringify({ amends_email_id: e.target.value ? Number(e.target.value) : null }) });
    setMsg("inbox-detail-msg", e.target.value ? "marked as a correction" : "correction link cleared", true);
    await loadInbox();
  } catch (err) { setMsg("inbox-detail-msg", err.message, false); }
});
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
        // keep the detected partner unless the primary was cleared (the pane
        // has no partner picker; the inbox grid's Player 2 column does)
        detected_partner_id: detected_player_id == null ? null : _inboxDetailPartnerId,
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
document.getElementById("inbox-bulk-classify").addEventListener("click", async (ev) => {
  if (!_inboxSelected.size) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const res = await api("/emails/bulk/classify", {
      method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected] }),
    });
    if (!res.classified) {
      setMsg("inbox-bulk-msg", "Nothing to classify (already classified, or no rule matched).", false);
    } else {
      const parts = Object.entries(res.counts)
        .map(([k, n]) => `${n} ${(EMAIL_CLASS_META[k] && EMAIL_CLASS_META[k].label) || k}`).join(", ");
      setMsg("inbox-bulk-msg", `classified ${res.classified}: ${parts}`, true);
      toast(`Auto-classified ${res.classified} email${res.classified === 1 ? "" : "s"} — review, then Detect players → Populate.`, true);
    }
    await loadInbox();
    _inboxBulkRefreshUi();
  } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
  finally { btn.disabled = false; }
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
// "Unmatched only" drilldown: a SERVER-SIDE filter (unmatched=true) so it's
// accurate across the whole inbox, not just the loaded page — the TD works
// through every detection gap. Reloads on toggle; persists across reloads.
let _inboxUnmatchedOnly = false;
document.getElementById("inbox-unmatched-only")?.addEventListener("change", (e) => {
  _inboxUnmatchedOnly = e.target.checked;
  loadInbox();
});
// One-click "Detect players" over the whole inbox: runs the detector on every
// loaded email that has no matched player yet (and an assigned tournament — the
// detector needs a roster). No row selection required.
document.getElementById("inbox-detect-all").addEventListener("click", async () => {
  const ids = inboxGrid.grid.getData()
    .filter((m) => !m.detected_player_id && m.tournament_id)
    .map((m) => m.id);
  if (!ids.length) { setMsg("inbox-import-pdf-msg", "every inbox email already has a matched player", true); return; }
  setMsg("inbox-import-pdf-msg", `detecting players for ${ids.length} email(s)…`, true);
  try {
    const res = await api("/emails/bulk/detect-players", {
      method: "POST", body: JSON.stringify({ email_ids: ids }),
    });
    const hits = res.filter((r) => r.detected_player_id).length;
    setMsg("inbox-import-pdf-msg", `matched ${hits} of ${ids.length} unmatched email(s)`, true);
    await loadInbox();
  } catch (e) { setMsg("inbox-import-pdf-msg", e.message, false); }
});
// Retention sweep (PII hardening H3 / COPPA §312.10): redact body/subject/sender
// of FILED emails past the threshold via POST /api/emails/purge. The provenance
// row survives (classification, player link, status) so the audit trail holds;
// 'new' (unprocessed) mail is never touched. UI for the existing endpoint.
{
  const purge = (days) => async () => {
    if (!(await confirmDialog(
      `Redact the text (body / subject / sender) of all FILED emails older than ${days} days, across all tournaments?\n` +
      "The rows stay (classification, matched player, status) — only the free-text PII is erased. This cannot be undone.",
      "Purge", "danger"))) return;
    try {
      const res = await api(`/emails/purge?older_than_days=${days}`, { method: "POST" });
      toast(`Retention sweep: ${res.purged} filed email(s) redacted`, true);
      await loadInbox();
    } catch (e) { toast(e.message, false); }
  };
  const menu = makeMenuButton(`<span aria-hidden="true">🗑</span> Retention`, [
    { label: "Purge filed older than 30 days…", onClick: purge(30), danger: true },
    { label: "Purge filed older than 90 days…", onClick: purge(90), danger: true },
    { label: "Purge filed older than 1 year…", onClick: purge(365), danger: true },
  ], { className: "export-btn no-print", title: "PII retention: redact the free text of old FILED emails (rows + audit trail survive)" });
  const anchor = document.getElementById("inbox-detect-all");
  anchor.parentNode.insertBefore(menu, anchor.nextSibling);
}
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
// Bulk status: clear the info-only emails (hotel notes, acks) that don't
// populate a list but should still leave the 'unfiled' queue. Mirrors the other
// bulk actions: POST /emails/bulk/status → toast + reload + refresh summary.
const _inboxBulkStatus = (status, verb) => async (ev) => {
  if (!_inboxSelected.size) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    const res = await api("/emails/bulk/status", {
      method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected], status }),
    });
    const n = res.updated;
    setMsg("inbox-bulk-msg", `${verb} ${n} email${n === 1 ? "" : "s"}`, true);
    toast(`${verb} ${n} email${n === 1 ? "" : "s"}`, true);
    _inboxSelected.clear();
    await loadInbox();
    _inboxBulkRefreshUi();
  } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
  finally { btn.disabled = false; }
};
document.getElementById("inbox-bulk-filed")
  .addEventListener("click", _inboxBulkStatus("filed", "Marked filed"));
document.getElementById("inbox-bulk-followup")
  .addEventListener("click", _inboxBulkStatus("needs_followup", "Flagged for follow-up"));
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
// One-click triage: classify → detect players → populate, in a single request.
document.getElementById("inbox-bulk-triage").addEventListener("click", async (ev) => {
  if (!_inboxSelected.size) return;
  const btn = ev.currentTarget;
  if (!(await confirmDialog(
    `Triage ${_inboxSelected.size} selected email(s)?\n\nThis will, in one pass:\n` +
    `  1. auto-classify the unclassified ones (local rules)\n` +
    `  2. detect the player each is about\n` +
    `  3. file the fileable ones into their lists\n\n` +
    `Doubles / pairing emails and any without a detected player are left for manual filing.`,
    "Triage all", "primary"))) return;
  btn.disabled = true;
  try {
    const res = await api("/emails/bulk/triage", {
      method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected] }),
    });
    const skippedMsg = res.skipped.length
      ? ` · ${res.skipped.length} left for manual filing`
      : "";
    const summary = `Triaged: classified ${res.classified}, matched ${res.detected}, filed ${res.filed}${skippedMsg}`;
    setMsg("inbox-bulk-msg", summary, res.skipped.length === 0);
    toast(summary, res.skipped.length === 0);
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
const _INBOX_PAGE = 200;  // server-side cap; search to reach older mail
async function loadInbox() {
  if (!active) return;
  // Scope to the active tournament so search, paging, and unmatched counts
  // agree with the status summary (and q hits the right rows). Server-side
  // `q` matches subject/sender/classification/division/player/USTA text —
  // body is encrypted, so it's metadata search only (D9).
  const q = (document.getElementById("inbox-search")?.value || "").trim();
  const params = new URLSearchParams({
    limit: String(_INBOX_PAGE),
    tournament_id: String(active.id),
  });
  if (q) params.set("q", q);
  if (_inboxUnmatchedOnly) params.set("unmatched", "true");
  // Need X-Total-Count for the "showing N of M" note — fetch directly.
  _progress(1);
  let rows = [], total = null;
  try {
    const res = await fetch("/api/emails?" + params.toString());
    if (res.status === 401) {
      document.dispatchEvent(new CustomEvent("auth-expired"));
      throw new Error("not authenticated");
    }
    if (!res.ok) {
      let detail = res.statusText;
      try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch (_) {}
      throw new Error(_humanizeDetail(detail, `${res.status}`));
    }
    total = res.headers.get("X-Total-Count");
    if (total != null) total = parseInt(total, 10);
    rows = await res.json();
  } finally {
    _progress(-1);
  }
  inboxGrid.setData(rows);
  const note = document.getElementById("inbox-search-note");
  if (note) {
    const n = rows.length;
    const tot = Number.isFinite(total) ? total : null;
    if (tot != null && tot > n) {
      note.textContent = q
        ? `showing ${n} of ${tot} match(es) — refine search to narrow`
        : `showing ${n} of ${tot} — refine search to reach older mail`;
    } else if (q) {
      note.textContent = `${n} match(es)`;
    } else if (tot != null) {
      note.textContent = tot ? `${tot} in this tournament` : "";
    } else {
      note.textContent = "";
    }
  }
  // Default status filter "new" once; tournament is already server-scoped.
  if (!_inboxFilterInit) {
    _inboxFilterInit = true;
    try { inboxGrid.grid.setHeaderFilterValue("status", "new"); } catch (_) {}
  }
  _loadInboxStatusSummary();
}
// Inbox progress summary: counts of unfiled (new) / filed / need-follow-up for
// the active tournament, so the TD sees what's left to process at a glance.
// "unfiled" is the actionable number and clicking it filters the grid to new.
async function _loadInboxStatusSummary() {
  const el = document.getElementById("inbox-status-summary");
  if (!el || !active) return;
  let c;
  try { c = await api(`/emails/status-counts?tournament_id=${active.id}`); }
  catch (_) { el.hidden = true; return; }
  if (!c.total) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML =
    `<a href="#" id="inbox-sum-new" class="${c.new ? "inbox-sum-todo" : ""}">${c.new} unfiled</a>` +
    ` · <span class="resp-ok">${c.filed} filed</span>` +
    (c.needs_followup ? ` · <span class="warn">${c.needs_followup} need follow-up</span>` : "") +
    (c.unmatched ? ` · <a href="#" id="inbox-sum-unmatched" class="warn">${c.unmatched} unmatched</a>` : "") +
    ` · ${c.total} total`;
  const link = document.getElementById("inbox-sum-new");
  if (link) link.addEventListener("click", (e) => {
    e.preventDefault();
    try { inboxGrid.grid.setHeaderFilterValue("status", "new"); } catch (_) {}
  });
  // "N unmatched" → flip on the server-side unmatched-only drilldown (and sync
  // the checkbox so the two controls agree).
  const um = document.getElementById("inbox-sum-unmatched");
  if (um) um.addEventListener("click", (e) => {
    e.preventDefault();
    const cb = document.getElementById("inbox-unmatched-only");
    if (cb && !cb.checked) { cb.checked = true; }
    _inboxUnmatchedOnly = true;
    loadInbox();
  });
  _renderInboxAging();
}

// Oldest unfiled emails first, with days-waiting — so nothing languishes. Shown
// only when the oldest has waited a while; clicking an item searches for it.
async function _renderInboxAging() {
  const box = document.getElementById("inbox-aging");
  if (!box || !active) return;
  let d;
  try { d = await api(`/emails/aging?tournament_id=${active.id}&limit=5`); }
  catch (_) { box.hidden = true; return; }
  // Only surface when there's a backlog worth nudging (oldest ≥ 2 days).
  if (!d.count || d.oldest_age_days < 2) { box.hidden = true; box.innerHTML = ""; return; }
  const age = (n) => html`<span class="ia-age${n >= 7 ? " ia-old" : ""}">${n}d</span>`;
  box.hidden = false;
  box.innerHTML = html`<div class="ia-head">⏳ Oldest unfiled — ${d.oldest_age_days} day(s) waiting</div><ul class="ia-list">${d.items.map((i) =>
    html`<li class="ia-item" data-subj="${i.subject || ""}">${age(i.age_days)} <span class="ia-subj">${i.subject || "(no subject)"}</span> <span class="muted">${i.from_address || ""}</span></li>`)}</ul>`;
  box.querySelectorAll(".ia-item").forEach((li) => li.addEventListener("click", () => {
    const search = document.getElementById("inbox-search");
    if (search) { search.value = li.dataset.subj; loadInbox(); }
  }));
}
// Debounced server-side inbox search (re-queries; no per-keystroke round-trip).
let _inboxSearchTimer = null;
document.getElementById("inbox-search")?.addEventListener("input", () => {
  clearTimeout(_inboxSearchTimer);
  _inboxSearchTimer = setTimeout(() => { if (active) loadInbox(); }, 300);
});
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
// makeListGrid / makeReadGrid / _autoHeaderFilters live in ./app/grids.js (P2 #11a).
// Origin cell: did this list row come from a filed email (✉, tooltip = the
// email's subject) or was it entered manually? Read-only badge.
function _originCell(c) {
  const r = c.getData();
  if (r.source_email_id) {
    const subj = r.source_subject || `email #${r.source_email_id}`;
    return hstr`<span class="origin-email" title="${"Filed from email: " + subj}">✉ email</span>`;
  }
  return '<span class="muted">manual</span>';
}
const _ORIGIN_COL = { title: "Origin", field: "source_email_id", headerSort: false,
  width: 100, formatter: _originCell };
const lateGrid = makeListGrid("late-table", [
  { title: "Date", field: "request_date", editor: "date", cssClass: "editable-cell",
    formatter: (c) => { const e = c.getData(); return hstr`${e.request_date}${e.past_deadline ? raw(' <span class="warn" title="Past the late-entry deadline">⚠</span>') : ""}`; } },
  { title: "Time", field: "request_time", editor: "input", cssClass: "editable-cell" },
  { title: "Player", field: "last_name", formatter: _playerCell },
  { title: "USTA #", field: "usta_number" },
  { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell",
    editorParams: (cell) => _divisionListParams({ gender: _rowGender(cell.getData()) }) },
  { title: "Events", field: "events", editor: "list", cssClass: "editable-cell",
    editorParams: (cell) => _eventListParams({ multiple: true, gender: _rowGender(cell.getData()) }) },
  _ORIGIN_COL,
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
  _ORIGIN_COL,
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
    const wd = await api(`/tournaments/${active.id}/withdrawals`, { method: "POST", body: JSON.stringify(b) });
    setMsg("withdrawal-msg", "added", true); wdReset(); loadWithdrawals(); loadInbox();
    await loadRoster();
    // A slot just opened — auto-suggest the best-matching alternate(s) inline.
    await _suggestAlternates(wd);
  } catch (err) { setMsg("withdrawal-msg", err.message, false); markInvalid(wdForm, err.message); }
});
wdForm.querySelector(".cancel").addEventListener("click", () => { wdReset(); _hideWdSuggest(); });

function _hideWdSuggest() {
  const box = document.getElementById("wd-suggest");
  if (box) { box.hidden = true; box.innerHTML = ""; }
}

// After a withdrawal, surface alternates to promote — same division first (the
// best match), then any other waiting alternates — each with one-click promote.
async function _suggestAlternates(wd) {
  const box = document.getElementById("wd-suggest");
  if (!box || !active) return;
  const div = wd && wd.age_division;
  let sameDiv = [], others = [];
  try {
    if (div) sameDiv = await api(`/tournaments/${active.id}/alternates?age_division=${encodeURIComponent(div)}`);
    const all = await api(`/tournaments/${active.id}/alternates`);
    const sameIds = new Set(sameDiv.map((a) => a.id));
    others = all.filter((a) => !sameIds.has(a.id));
  } catch (_) { _hideWdSuggest(); return; }
  if (!sameDiv.length && !others.length) {
    box.hidden = false;
    box.innerHTML = html`<p class="wd-suggest-empty">No alternates waiting${div ? html` in <strong>${div}</strong> or any other division` : ""} — nothing to promote.</p>`;
    return;
  }
  const who = wd ? html`${wd.last_name}, ${wd.first_name}` : "a player";
  // per-row html`` (auto-escapes names); joined to a string + raw()'d into the
  // list so the outer html`` doesn't re-escape (see helper double-escape note).
  const row = (a, best) =>
    html`<li class="wd-alt${best ? " is-best" : ""}"><span class="wd-alt-name">${a.last_name}, ${a.first_name}${a.player_id ? raw(` <span class="p360-link" data-pid="${a.player_id}" title="Open player 360">👤</span>`) : ""}</span><span class="wd-alt-div">${a.age_division || "—"}${best ? raw(' <span class="wd-best-tag">best match</span>') : ""}</span><button type="button" class="wd-promote" data-eid="${a.id}" data-name="${a.last_name}, ${a.first_name}">↑ Promote to selected</button></li>`;
  box.hidden = false;
  box.innerHTML = html`<div class="wd-suggest-head"><strong>${who}</strong> withdrew${div ? html` from <strong>${div}</strong>` : ""} — promote an alternate to fill the slot:</div><ul class="wd-alt-list">${raw(sameDiv.map((a) => row(a, true)).join(""))}${
    others.length ? html`<li class="wd-alt-sep">Other divisions</li>${raw(others.map((a) => row(a, false)).join(""))}` : ""
  }</ul>`;
  box.querySelectorAll(".wd-promote").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api(`/roster/${btn.dataset.eid}/promote`, { method: "POST" });
      toast(`Promoted ${btn.dataset.name} to selected`, true);
      btn.closest(".wd-alt").classList.add("wd-alt-done");
      btn.replaceWith(Object.assign(document.createElement("span"), { className: "wd-alt-promoted", textContent: "✓ promoted" }));
      await loadRoster();
    } catch (e) { toast(e.message, false); btn.disabled = false; }
  }));
}

// Generic player-keyed Part B list (form + table + delete + file-from-email).
// Body extracted to app/player_list.js (P2 #11d); created here — at the point of
// use — so `active`/expandPlayerRef/loadInbox are all defined. `active` is read
// via a getter since it's a reassigned module global.
const wirePlayerList = createPlayerList({
  api, setMsg, confirmDialog, markInvalid, formObj, _csvDownload,
  _autoHeaderFilters, GRIDS, expandPlayerRef, loadInbox, makeGrid,
  getActive: () => active,
});
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
    _ORIGIN_COL,
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
    _ORIGIN_COL,
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
    _ORIGIN_COL,
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
async function openHotelConfidentialReport() {
  if (!active) { toast("Select a tournament first", false); return; }
  try {
    const data = await api(`/tournaments/${active.id}/hotel-confidential-report`);
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
    printDoc({
      title: `Hotel report — ${t}`,
      printLabel: "Print this report",
      popupMsg: "Allow pop-ups for this site to print the report",
      styleExtra: `
      body { margin: 1.2cm; }
      h2 { font-size: 14px; margin: 1.4rem 0 0.4rem; border-bottom-width: 2px; }
      .meta { margin-bottom: 0.4rem; }
      .pagebreak { page-break-before: always; }`,
      body: `
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
      <table><thead><tr><th>Name</th><th>Hotel</th></tr></thead><tbody>${officialRows}</tbody></table>`,
    });
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
      + keys.map((c) => hstr`<span class="badge badge-info">${label(c)}: ${counts[c]}</span>`).join(" ")
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
    return html`<tr>
      <td><strong>${r.size}</strong> <span class="muted">${r.label}</span></td>
      <td class="num">${r.requested}</td>
      <td class="num"><input type="number" min="0" step="1" data-size="${r.size}" value="${r.on_hand}" style="width:5rem;text-align:right" /></td>
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
    status.innerHTML = hstr`Order placed <strong>${data.ordered_at}</strong> — the Snapshot column shows what was requested at that moment.`;
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
  catch (e) { tbody.innerHTML = hstr`<tr><td colspan="4" class="muted">${e.message}</td></tr>`; return; }
  _tshirtBySiteRows = rows;
  // Populate the site filter with the actual sites that appear (so the TD
  // doesn't see sites with zero shirts).
  const sel = document.getElementById("tshirt-by-site-filter");
  const sites = [...new Set(rows.map((r) => r.site_name))].sort();
  const prev = sel.value;
  sel.innerHTML = `<option value="">— all sites —</option>` +
    sites.map((s) => hstr`<option value="${s}">${s}</option>`).join("");
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
    return hstr`<tr><td>${site}</td><td>${div}</td><td>${size}</td><td class="num">${n}</td></tr>`;
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
    formatter: (c) => hstr`${(c.getData().members || []).map((m) => [m.last_name, m.first_name].filter(Boolean).join(", ") || m.usta_number).join(" & ")}` },
  _ORIGIN_COL,
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
      return hstr`→ ${label} (awaiting partner)`;
    } },
  _ORIGIN_COL,
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

// --- Home / "Today" dashboard ---
// Cross-tournament overview (always) + a status board for the active tournament,
// aggregating the numbers that otherwise live behind Inbox/Assignments/Reports.
function _daysUntil(iso) {
  if (!iso) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((new Date(iso + "T00:00:00") - today) / 86400000);
}
function _deadlineCell(iso) {
  const n = _daysUntil(iso);
  if (n === null) return '<span class="muted">—</span>';
  if (n < 0) return hstr`${_fmtMDY(iso)} <span class="muted">(passed)</span>`;
  if (n === 0) return hstr`${_fmtMDY(iso)} <span class="warn">(today)</span>`;
  return hstr`${_fmtMDY(iso)} <span class="${n <= 7 ? "warn" : "muted"}">(in ${n}d)</span>`;
}
function _dashGo(group, tab) {
  activateGroup(group);
  const el = document.querySelector(`.tab[data-target="${tab}"]`);
  if (el) el.click();
}
const _DEADLINE_LABEL = { registration: "Registration deadline", late_entry: "Late-entry deadline", play_start: "Play starts" };
async function _renderDeadlines() {
  const el = document.getElementById("dash-deadlines");
  if (!el) return;
  let data;
  try { data = await api("/dashboard/deadlines"); } catch (_) { el.hidden = true; return; }
  const items = data.deadlines || [];
  if (!items.length) { el.hidden = true; el.innerHTML = ""; return; }
  const urgency = (n) => n < 0 ? html`<span class="resp-bad">${Math.abs(n)}d ago</span>`
    : (n === 0 ? html`<span class="resp-bad">today</span>`
      : html`<span class="${n <= 7 ? "warn" : "muted"}">in ${n}d</span>`);
  el.hidden = false;
  el.innerHTML = html`<div class="dash-dl-head">⏰ ${items.length} deadline${items.length === 1 ? "" : "s"} in the next ${data.within_days} days</div><ul class="dash-dl-list">${items.map((x) =>
    html`<li class="dash-dl-item" data-tid="${x.tournament_id}" tabindex="0" role="button"><strong>${x.tournament_name}</strong> — ${_DEADLINE_LABEL[x.kind] || x.kind} ${_fmtMDY(x.date)} · ${urgency(x.days_until)}</li>`)}</ul>`;
  el.querySelectorAll(".dash-dl-item").forEach((li) => {
    const go = () => setActive(Number(li.dataset.tid));
    li.addEventListener("click", go);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
// Cross-tournament digest: every active event's open-task tally + soonest key
// date, most-urgent first, so the TD triages across all tournaments at once.
const _DIGEST_TASKS = [
  ["unfiled_inbox", "unfiled", ["inbox", "panel-t-inbox"]],
  ["officials_pending", "pending", ["staffing", "panel-t-assignments"]],
  ["officials_declined", "declined", ["staffing", "panel-t-assignments"]],
  ["uncovered_days", "uncovered days", ["staffing", "panel-t-reports"]],
  ["conflicts", "conflicts", ["staffing", "panel-t-reports"]],
  ["roster_incomplete", "roster gaps", ["tournament", "panel-t-roster"]],
];
async function _renderDigest() {
  const el = document.getElementById("dash-digest");
  if (!el) return;
  let dg;
  try { dg = await api("/dashboard/digest"); } catch (_) { el.hidden = true; return; }
  const rows = dg.tournaments || [];
  if (!rows.length) { el.hidden = true; el.innerHTML = ""; return; }
  const due = (nd) => {
    if (!nd) return "";
    const n = nd.days_until;
    const when = n < 0 ? `${Math.abs(n)}d ago` : (n === 0 ? "today" : `in ${n}d`);
    const cls = n <= 0 ? "resp-bad" : (n <= 7 ? "warn" : "muted");
    return html` · <span class="${cls}">${_DEADLINE_LABEL[nd.kind] || nd.kind} ${when}</span>`;
  };
  const t = dg.totals;
  el.hidden = false;
  el.innerHTML = html`<div class="dash-dg-head">📋 ${t.open_tasks} open task${t.open_tasks === 1 ? "" : "s"} across ${t.active_tournaments} active tournament${t.active_tournaments === 1 ? "" : "s"}</div><ul class="dash-dg-list">${rows.map((r) => {
      const chips = _DIGEST_TASKS.filter(([k]) => r.tasks[k] > 0).map(([k, label, go]) =>
        html`<button type="button" class="dash-dg-chip" data-go-group="${go[0]}" data-go-tab="${go[1]}" data-tid="${r.tournament_id}">${r.tasks[k]} ${label}</button>`);
      const clean = r.open_tasks === 0 ? html`<span class="dash-dg-clean">✓ all clear</span>` : "";
      return html`<li class="dash-dg-row"><span class="dash-dg-name" data-tid="${r.tournament_id}" tabindex="0" role="button"><strong>${r.tournament_name}</strong>${due(r.next_deadline)}</span><span class="dash-dg-chips">${chips}${clean}</span></li>`;
    })}</ul>`;
  // chip → set that tournament active AND jump to the relevant tab.
  el.querySelectorAll(".dash-dg-chip").forEach((b) => b.addEventListener("click", () => {
    setActive(Number(b.dataset.tid));
    _dashGo(b.dataset.goGroup, b.dataset.goTab);
  }));
  el.querySelectorAll(".dash-dg-name").forEach((n) => {
    const go = () => setActive(Number(n.dataset.tid));
    n.addEventListener("click", go);
    n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
// Official workload (cross-tournament): days/assignments per official, busiest
// first, with zero-load officials flagged — so the TD balances staffing. Links to
// each official's 360. No active tournament needed.
async function _renderWorkload() {
  const box = document.getElementById("dash-workload");
  if (!box) return;
  let w;
  try { w = await api("/officials/workload"); } catch (_) { box.innerHTML = ""; return; }
  if (!w.officials.length) { box.innerHTML = '<p class="muted">No officials yet.</p>'; return; }
  const t = w.totals;
  const maxDays = Math.max(1, ...w.officials.map((o) => o.days));
  const rows = w.officials.map((o) => {
    const cls = o.assignments === 0 ? "wl-zero" : "";
    const bar = `<span class="wl-bar" style="width:${Math.round((o.days / maxDays) * 100)}%"></span>`;
    const mix = o.assignments
      ? `<span class="muted">${o.accepted}✓ ${o.pending}⏳ ${o.declined}✗</span>` : "";
    return html`<tr class="${cls}"><td><span class="wl-off-link" data-oid="${o.official_id}">${o.official_name}</span></td><td class="num">${o.days}</td><td class="num">${o.assignments}</td><td class="num">${o.tournaments}</td><td class="wl-barcell">${raw(bar)}</td><td>${raw(mix)}</td></tr>`;
  });
  box.innerHTML = html`<p class="muted wl-sub">${t.assigned} of ${t.officials} official(s) staffed · ${t.days} day(s) across ${t.assignments} assignment(s)${t.unused ? html` · <span class="warn">${t.unused} unused</span>` : ""}.</p><table class="list-table wl-table"><thead><tr><th>Official</th><th class="num">Days</th><th class="num">Assigns</th><th class="num">Events</th><th>Load</th><th>Responses</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll(".wl-off-link[data-oid]").forEach((el) =>
    el.addEventListener("click", () => openOfficial360(Number(el.dataset.oid))));
}

async function loadDashboard() {
  _renderDeadlines();  // cross-tournament approaching-deadline banner
  _renderDigest();     // cross-tournament open-task digest
  _renderWorkload();   // cross-tournament official workload balance
  // Cross-tournament overview table.
  let tournaments = [];
  try { tournaments = await api("/tournaments"); } catch (_) {}
  const body = document.querySelector("#dash-overview-table tbody");
  body.innerHTML = tournaments.length
    ? html`${tournaments.slice().sort((a, b) => String(a.play_start_date).localeCompare(String(b.play_start_date)))
        .map((t) => {
          const su = _daysUntil(t.play_start_date);
          const startsIn = su === null ? "" : (su < 0 ? html`<span class="muted">started / past</span>`
            : (su === 0 ? html`<span class="warn">today</span>` : html`in ${su}d`));
          const isActive = active && active.id === t.id;
          return html`<tr class="dash-trow${isActive ? " is-active" : ""}" data-tid="${t.id}" tabindex="0" role="button"><td>${t.name}${isActive ? raw(' <span class="badge badge-ok">active</span>') : ""}</td><td>${t.type}</td><td>${_fmtMDY(t.play_start_date)} – ${_fmtMDY(t.play_end_date)}</td><td>${startsIn}</td><td>${raw(_deadlineCell(t.registration_deadline))}</td><td>${raw(_deadlineCell(t.late_entry_deadline))}</td></tr>`;
        })}`
    : `<tr><td class="empty" colspan="6">No tournaments yet — add one in Setup → Tournaments.</td></tr>`;
  body.querySelectorAll(".dash-trow").forEach((tr) => {
    const pick = () => setActive(Number(tr.dataset.tid));
    tr.addEventListener("click", pick);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
  });

  // Active-tournament status board (tiles).
  const tiles = document.getElementById("dash-tiles");
  const sub = document.getElementById("dash-sub");
  if (!active) {
    tiles.hidden = true; tiles.innerHTML = "";
    sub.textContent = "Pick a tournament below (or in the bar above) to see its status board.";
    return;
  }
  sub.textContent = `Status board — ${active.name}`;
  let d;
  try { d = await api(`/tournaments/${active.id}/dashboard`); }
  catch (_) { tiles.hidden = true; return; }
  const tile = (label, n, opts = {}) => {
    const alert = opts.alert && n > 0;
    return hstr`<button type="button" class="dash-tile${alert ? " alert" : ""}" data-go-group="${opts.go[0]}" data-go-tab="${opts.go[1]}"><span class="dash-num">${n}</span><span class="dash-label">${label}</span></button>`;
  };
  tiles.hidden = false;
  tiles.innerHTML =
    tile(`unfiled email${d.inbox.new === 1 ? "" : "s"}`, d.inbox.new, { alert: true, go: ["inbox", "panel-t-inbox"] }) +
    tile("officials awaiting reply", d.officials.pending, { alert: true, go: ["staffing", "panel-t-assignments"] }) +
    tile("declined — re-staff", d.officials.declined, { alert: true, go: ["staffing", "panel-t-assignments"] }) +
    tile("uncovered day(s)", d.coverage.uncovered_days_count, { alert: true, go: ["staffing", "panel-t-reports"] }) +
    tile("staffing conflict(s)", d.conflicts ?? 0, { alert: true, go: ["staffing", "panel-t-reports"] }) +
    tile("rooms unused", d.rooms.unused, { alert: true, go: ["staffing", "panel-t-reports"] }) +
    tile("on roster", d.roster.selected, { go: ["tournament", "panel-t-roster"] }) +
    tile("alternates", d.roster.alternate, { go: ["tournament", "panel-t-roster"] }) +
    tile("withdrawn", d.roster.withdrawn, { go: ["playerlists", "panel-t-withdrawals"] });
  tiles.querySelectorAll("[data-go-group]").forEach((b) =>
    b.addEventListener("click", () => _dashGo(b.dataset.goGroup, b.dataset.goTab)));
  _renderDeclinedAlert(d.officials.declined);
  _renderPendingNudges(d.officials.pending);
  _renderRosterIncomplete();
  _renderCoverageGap(d.coverage);
  _renderReadiness();
}

// Coverage-gap nudge: which play days have NO official assigned. The tile shows
// the count; this names the actual dates (from the dashboard payload, no extra
// fetch) so the TD knows exactly which days to staff. Deep-links to the coverage
// report (same target as the uncovered-days tile).
function _renderCoverageGap(cov) {
  const box = document.getElementById("dash-coverage");
  if (!box || !active) return;
  const days = cov?.uncovered_days || [];
  if (!days.length) { box.hidden = true; box.innerHTML = ""; return; }
  const item = (iso) => html`<li class="dash-pend-item"><span class="dash-pend-name">${fmtDOW(iso)}</span></li>`;
  box.hidden = false;
  box.innerHTML = html`<div class="dash-pend-head">📅 ${String(days.length)} play day${days.length === 1 ? raw("") : raw("s")} with no official</div><ul class="dash-pend-list">${days.map(item)}</ul><button type="button" id="dash-cov-go" class="btn-small">View coverage on Reports →</button>`;
  document.getElementById("dash-cov-go")?.addEventListener("click", () => _dashGo("staffing", "panel-t-reports"));
}

// Pre-tournament readiness scorecard: one pass/warn/fail row per area, with an
// overall "ready / N blockers" headline. Each row deep-links to where it's fixed.
const _READY_GO = {
  coverage: ["staffing", "panel-t-reports"], conflicts: ["staffing", "panel-t-reports"],
  declined: ["staffing", "panel-t-assignments"], responses: ["staffing", "panel-t-assignments"],
  roster: ["tournament", "panel-t-roster"], rooms: ["staffing", "panel-t-reports"],
  inbox: ["inbox", "panel-t-inbox"],
};
const _READY_ICON = { pass: "✓", warn: "▲", fail: "✗" };
async function _renderReadiness() {
  const box = document.getElementById("dash-readiness");
  if (!box || !active) return;
  let r;
  try { r = await api(`/tournaments/${active.id}/readiness`); }
  catch (_) { box.hidden = true; return; }
  const s = r.summary;
  const headClass = s.fail ? "rdy-fail" : (s.warn ? "rdy-warn" : "rdy-pass");
  const headText = s.fail
    ? `✗ Not ready — ${s.fail} blocker${s.fail === 1 ? "" : "s"}${s.warn ? `, ${s.warn} warning${s.warn === 1 ? "" : "s"}` : ""}`
    : (s.warn ? `▲ Ready with ${s.warn} warning${s.warn === 1 ? "" : "s"}` : "✓ Ready — all checks pass");
  box.hidden = false;
  box.innerHTML = html`<div class="rdy-head ${headClass}">${headText}</div><ul class="rdy-list">${r.checks.map((c) =>
    html`<li class="rdy-row rdy-${c.status}" data-key="${c.key}" tabindex="0" role="button"><span class="rdy-icon">${_READY_ICON[c.status]}</span><span class="rdy-label">${c.label}</span><span class="rdy-detail">${c.detail}</span></li>`)}</ul>`;
  box.querySelectorAll(".rdy-row").forEach((row) => {
    const go = _READY_GO[row.dataset.key];
    if (!go) return;
    const jump = () => _dashGo(go[0], go[1]);
    row.addEventListener("click", jump);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); } });
  });
}

// Named declined-assignment alert: when officials have declined, show WHO (+ the
// slot they vacated) right on the dashboard, each with a one-click jump to the
// Assignments tab filtered to declined for re-staffing. (The tile shows only the
// count; this is the actionable list.)
async function _renderDeclinedAlert(declinedCount) {
  const box = document.getElementById("dash-declined");
  if (!box || !active) return;
  if (!declinedCount) { box.hidden = true; box.innerHTML = ""; return; }
  let d;
  try { d = await api(`/tournaments/${active.id}/declined`); }
  catch (_) { box.hidden = true; return; }
  if (!d.count) { box.hidden = true; return; }
  const item = (r) => {
    const slot = [r.site_label, r.day_count ? `${r.day_count} day${r.day_count === 1 ? "" : "s"}` : ""]
      .filter(Boolean).join(" · ");
    return html`<li class="dash-dec-item"><span class="dash-dec-name">${r.official_name}</span>${slot ? html` <span class="dash-dec-slot">${slot}</span>` : ""}</li>`;
  };
  box.hidden = false;
  box.innerHTML = html`<div class="dash-dec-head">✗ ${d.count} declined — needs re-staffing</div><ul class="dash-dec-list">${d.declined.map(item)}</ul><button type="button" id="dash-dec-go" class="btn-small">Re-staff on Assignments →</button>`;
  document.getElementById("dash-dec-go")?.addEventListener("click", () => {
    _dashGo("staffing", "panel-t-assignments");
    // pre-filter the assignments list to declined so the TD lands on the work.
    setTimeout(() => { try { _asgRespFilter = "declined"; _renderAsgList(); } catch (_) {} }, 300);
  });
}

// Pending-response nudges: officials assigned but not yet accept/declined. Lists
// each with a ✉ mailto nudge (pre-filled confirmation ask) — fits the app's
// mailto-only model (no send infra). Parallel to the declined alert above.
async function _renderPendingNudges(pendingCount) {
  const box = document.getElementById("dash-pending");
  if (!box || !active) return;
  if (!pendingCount) { box.hidden = true; box.innerHTML = ""; return; }
  let d;
  try { d = await api(`/tournaments/${active.id}/pending`); }
  catch (_) { box.hidden = true; return; }
  if (!d.count) { box.hidden = true; return; }
  const tName = active.name || "the tournament";
  // Outreach memory: "nudged today / Nd ago" so a fresh gap reads differently
  // from a chased-but-silent one.
  const ago = (iso) => {
    if (!iso) return "";
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return days <= 0 ? "nudged today" : days === 1 ? "nudged 1d ago" : `nudged ${days}d ago`;
  };
  const item = (r) => {
    const slot = r.day_count ? `${r.day_count} day${r.day_count === 1 ? "" : "s"}` : "";
    // a pre-filled mailto so the TD can chase a confirmation in one click; only
    // shown when an email is on file (else just the name).
    let nudge = "";
    if (r.official_email) {
      const subj = encodeURIComponent(`Assignment confirmation — ${tName}`);
      const body = encodeURIComponent(
        `Hi ${r.first_name || ""},\n\nPlease confirm (accept or decline) your officiating ` +
        `assignment for ${tName}${slot ? ` (${slot})` : ""}.\n\nThanks!`);
      nudge = html` <a class="dash-pend-nudge" data-aid="${String(r.assignment_id)}" href="mailto:${r.official_email}?subject=${raw(subj)}&body=${raw(body)}">✉ Nudge</a>`;
    }
    const lastNudged = r.last_nudged_at ? html` <span class="dash-pend-ago" title="last contacted">· ${ago(r.last_nudged_at)}</span>` : "";
    return html`<li class="dash-pend-item"><span class="dash-pend-name">${r.official_name}</span>${
      slot ? html` <span class="dash-pend-slot">${slot}</span>` : ""}${nudge}${lastNudged}</li>`;
  };
  box.hidden = false;
  const emails = d.pending.map((p) => p.official_email).filter(Boolean);
  // "Nudge all" only when ≥2 have an email — for one, the per-row ✉ is enough.
  const bulk = emails.length >= 2
    ? html`<button type="button" id="dash-pend-all" class="btn-small">✉ Nudge all (${String(emails.length)})</button>`
    : "";
  box.innerHTML = html`<div class="dash-pend-head">⏳ ${d.count} awaiting accept/decline</div><ul class="dash-pend-list">${d.pending.map(item)}</ul><button type="button" id="dash-pend-go" class="btn-small">Chase on Assignments →</button>${bulk}`;
  document.getElementById("dash-pend-go")?.addEventListener("click", () => {
    _dashGo("staffing", "panel-t-assignments");
    setTimeout(() => { try { _asgRespFilter = "pending"; _renderAsgList(); } catch (_) {} }, 300);
  });
  // Per-row ✉: the mailto opens the mail client; we ALSO record the outreach so
  // the row shows "nudged today" next time (best-effort — never block the mailto).
  box.querySelectorAll(".dash-pend-nudge[data-aid]").forEach((a) => {
    a.addEventListener("click", () => {
      api(`/assignments/${a.dataset.aid}/nudged`, { method: "POST" })
        .then(() => _renderPendingNudges(d.count)).catch(() => {});
    });
  });
  document.getElementById("dash-pend-all")?.addEventListener("click", async () => {
    // one bcc mailto to the whole pending group (same pattern as bulk invite).
    const subj = encodeURIComponent(`Assignment confirmation — ${tName}`);
    const body = encodeURIComponent(
      `Hi,\n\nOur records show your officiating assignment for ${tName} is still ` +
      `unconfirmed. Please reply to accept or decline.\n\nThanks!`);
    window.open(`mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${subj}&body=${body}`, "_blank");
    // record the bulk outreach, then refresh so every row shows "nudged today".
    try { await api(`/tournaments/${active.id}/pending/nudged`, { method: "POST" }); _renderPendingNudges(d.count); } catch (_) {}
  });
}

// Roster-completeness nudge: selected/alternate entries missing required data.
// Reuses the existing /roster-completeness endpoint (one row per incomplete
// entry + per-issue `issues`), naming each player + which fields are missing,
// with a deep-link to the Roster tab. Self-fetches (the dashboard payload
// doesn't carry the count).
const _ROSTER_ISSUE_LABEL = {
  missing_division: "division", missing_gender: "gender",
  missing_shirt: "shirt size", outstanding_balance: "balance due",
};
async function _renderRosterIncomplete() {
  const box = document.getElementById("dash-roster-incomplete");
  if (!box || !active) return;
  let c;
  try { c = await api(`/tournaments/${active.id}/roster-completeness`); }
  catch (_) { box.hidden = true; return; }
  const n = c.counts?.incomplete_entries || 0;
  if (!n) { box.hidden = true; box.innerHTML = ""; return; }
  const item = (e) => html`<li class="dash-pend-item"><span class="dash-pend-name">${e.player_name}</span> <span class="dash-pend-slot">missing: ${
    e.issues.map((i) => _ROSTER_ISSUE_LABEL[i] || i).join(", ")}</span></li>`;
  box.hidden = false;
  box.innerHTML = html`<div class="dash-pend-head">📋 ${String(n)} incomplete roster entr${n === 1 ? raw("y") : raw("ies")}</div><ul class="dash-pend-list">${c.entries.map(item)}</ul><button type="button" id="dash-ri-go" class="btn-small">Fix on Roster →</button>`;
  document.getElementById("dash-ri-go")?.addEventListener("click", () => _dashGo("tournament", "panel-t-roster"));
}

// --- Player 360 drawer: everything about one player, unified by USTA # ---
const _p360Modal = document.getElementById("player360-modal");
function _closePlayer360() { if (_p360Modal) _p360Modal.hidden = true; }
document.getElementById("player360-close")?.addEventListener("click", _closePlayer360);
_p360Modal?.addEventListener("click", (e) => { if (e.target.id === "player360-modal") _closePlayer360(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _p360Modal && !_p360Modal.hidden) _closePlayer360(); });
async function openPlayer360(playerId, tournamentId) {
  const body = document.getElementById("player360-body");
  document.getElementById("player360-title").textContent = "Player";
  body.innerHTML = '<p class="muted">Loading…</p>';
  _p360Modal.hidden = false;
  let d;
  try {
    const q = tournamentId ? `?tournament_id=${tournamentId}` : "";
    d = await api(`/players/${playerId}/overview${q}`);
  } catch (e) { body.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
  const p = d.player;
  document.getElementById("player360-title").textContent = `${p.last_name}, ${p.first_name}`;
  const loc = [p.city, p.state].filter(Boolean).join(", ");
  // html`` auto-escapes the cell/field values; per-row templates are joined to a
  // string and the pre-built pieces are raw()'d into the final body (one html``
  // template + html`` would double-escape — see the helper's docs).
  const entriesHtml = d.entries.length
    ? `<table class="list-table p360-table"><thead><tr><th>Tournament</th><th>Status</th><th>Div</th><th>T-shirt</th><th>Lodging</th></tr></thead><tbody>` +
      d.entries.map((e) => html`<tr><td>${e.tournament_name}</td><td>${raw(chip(e.selection_status))}</td><td>${e.age_division || ""}</td><td>${e.t_shirt_size || ""}</td><td>${e.lodging_plan || ""}</td></tr>`).join("") +
      `</tbody></table>`
    : '<p class="muted">Not on any roster.</p>';
  const r = d.requests;
  const sec = (title, rows, fmt) => rows.length
    ? html`<div class="p360-sec"><h4>${title} (${rows.length})</h4><ul>${rows.map((x) => html`<li>${fmt(x)}</li>`)}</ul></div>` : "";
  const reqHtml =
    sec("Late entries", r.late_entries, (x) => html`${x.age_division || ""} ${x.events || ""}${x.request_date ? html` · ${x.request_date}` : ""}`) +
    sec("Withdrawals", r.withdrawals, (x) => html`${x.events || ""} — ${x.reason || "(alternate, no reason)"}${x.was_alternate ? " · was alternate" : ""}`) +
    sec("Scheduling avoidances", r.scheduling, (x) => html`avoid ${x.avoid_day || ""} ${x.avoid_time_range || ""}`) +
    sec("Division flexibility", r.division_flex, (x) => html`${x.home_division || ""} → ${x.willing_divisions || ""}`) +
    sec("Player hotels", r.hotels, (x) => html`${x.hotel_name || ""} ${x.lodging_plan || ""}`) +
    sec("Doubles", r.doubles, (x) => html`${x.age_division || ""} · ${x.wants_random ? "random" : "partner " + (x.partner_usta || "?")} · ${x.status || ""}`) +
    sec("Pairing avoidances", r.pairing, (x) => html`${x.age_division || ""} ${x.relationship || ""}`);
  body.innerHTML = html`<p class="p360-id">USTA #${p.usta_number || "—"}${p.gender ? html` · ${p.gender}` : ""}${loc ? html` · ${loc}` : ""}</p><h4>Tournament entries</h4>${raw(entriesHtml)}${
    reqHtml
      ? html`<h4 class="p360-reqhead">Requests${d.tournament_id ? " (this tournament)" : ""}</h4>${raw(reqHtml)}`
      : raw(`<p class="muted">No filed requests${d.tournament_id ? " for this tournament" : ""}.</p>`)
  }`;
  _p360Export = { title: `${p.last_name}, ${p.first_name}`, subtitle: "Player profile", html: body.innerHTML };
}

// Official 360 — reuses the player drawer modal to show an official's certs +
// season assignments/pay (the search lands here for an official result).
async function openOfficial360(officialId) {
  const body = document.getElementById("player360-body");
  document.getElementById("player360-title").textContent = "Official";
  body.innerHTML = '<p class="muted">Loading…</p>';
  _p360Modal.hidden = false;
  let d;
  try { d = await api(`/officials/${officialId}/overview`); }
  catch (e) { body.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
  const o = d.official;
  document.getElementById("player360-title").textContent = `${o.last_name}, ${o.first_name} · official`;
  const loc = [o.city, o.state].filter(Boolean).join(", ");
  const certs = d.certs.length
    ? d.certs.map((c) => hstr`<span class="badge badge-info">${certLabel(c)}</span>`).join(" ")
    : '<span class="muted">no certifications on file</span>';
  const tt = d.pay.totals;
  const asg = d.pay.tournaments.length
    ? html`<table class="list-table p360-table"><thead><tr><th>Tournament</th><th>Days</th><th class="num">Pay</th><th class="num">Mileage</th><th class="num">Total</th><th>Response</th></tr></thead><tbody>${
        d.pay.tournaments.map((t) => html`<tr><td>${t.tournament_name}</td><td>${t.days}</td><td class="num">${money(t.pay)}</td><td class="num">${money(t.mileage)}</td><td class="num">${money(t.total)}</td><td>${raw(_respChip(t.response_status))}</td></tr>`)
      }<tr class="totals"><td>Season totals (${tt.assignments} assignment${tt.assignments === 1 ? "" : "s"})</td><td>${tt.days}</td><td class="num">${money(tt.pay)}</td><td class="num">${money(tt.mileage)}</td><td class="num">${money(tt.total)}</td><td></td></tr></tbody></table>`
    : raw('<p class="muted">No assignments yet.</p>');
  const payBtn = tt.assignments
    ? html`<p><button type="button" id="off-pay-statement" class="btn-small" data-oid="${officialId}" data-name="${o.last_name}, ${o.first_name}">⬇ Pay statement (PDF)</button></p>`
    : "";
  body.innerHTML = html`<p class="p360-id">Official${loc ? html` · ${loc}` : ""}</p><h4>Certifications</h4><p>${raw(certs)}</p><h4>Assignments &amp; pay</h4>${asg}${payBtn}`;
  _p360Export = { title: `${o.last_name}, ${o.first_name}`, subtitle: "Official profile", html: body.innerHTML };
  document.getElementById("off-pay-statement")?.addEventListener("click", (e) =>
    exportPayStatement(Number(e.currentTarget.dataset.oid)));
}

// Reimbursement pay statement → print window (day-level rates + mileage), reusing
// the report print-window pattern. No PDF lib.
async function exportPayStatement(officialId) {
  let d;
  try { d = await api(`/officials/${officialId}/pay-statement`); }
  catch (e) { toast(e.message, false); return; }
  const e = esc, off = d.official, tt = d.totals;
  const sections = d.assignments.length ? d.assignments.map((a) => {
    const dayRows = a.days.map((x) =>
      `<tr><td>${e(_fmtMDY(x.work_date))}</td><td>${e(certLabel(x.working_as))}</td>` +
      `<td class="num">${money(x.rate_applied)}</td></tr>`).join("") ||
      `<tr><td colspan="3" class="muted">No worked days.</td></tr>`;
    const mileage = a.missing_distance ? "—  (no distance on file)"
      : `${money(a.mileage)}${a.one_way_miles != null ? `  (${a.one_way_miles} mi one-way${a.mileage === 0 ? ", within free 50 mi" : ""})` : ""}`;
    return `<h2>${e(a.tournament_name)}${a.site_label ? ` · ${e(a.site_label)}` : ""}</h2>` +
      `<table><thead><tr><th>Date</th><th>Role</th><th class="num">Rate</th></tr></thead>` +
      `<tbody>${dayRows}</tbody></table>` +
      `<p class="line">Pay: <strong>${money(a.pay)}</strong> · Mileage: <strong>${mileage}</strong>` +
      ` · Assignment total: <strong>${money(a.total)}</strong></p>`;
  }).join("") : `<p class="muted">No assignments on file.</p>`;
  printDoc({
    title: `Pay statement — ${off.name}`,
    styleExtra: `
      .grand { margin-top: 1rem; padding: 0.5rem 0.7rem; background: #e7f1ea; border: 1px solid #2e6f40; border-radius: 6px; font-size: 13px; }`,
    body: `
    <h1>Officiating pay statement</h1>
    <div class="sub">${e(off.name)}${off.location ? ` · ${e(off.location)}` : ""}` +
      `${off.email ? ` · ${e(off.email)}` : ""}${off.phone ? ` · ${e(off.phone)}` : ""}` +
      ` · generated ${e(_fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
    ${sections}
    <div class="grand"><strong>Grand total: ${money(tt.total)}</strong> ` +
      `(pay ${money(tt.pay)} + mileage ${money(tt.mileage)}) · ${tt.days} day(s) across ${tt.assignments} assignment(s)</div>`,
  });
}

// Print/PDF the currently-open 360 drawer (player or official) — reuses the
// staffing-report print-window pattern: a clean, self-contained doc that
// auto-prints so the TD saves it as a one-page PDF. No PDF lib.
let _p360Export = null;
function exportP360() {
  if (!_p360Export) { toast("Open a profile first", false); return; }
  const { title, subtitle, html } = _p360Export;
  printDoc({
    title: `${subtitle} — ${title}`,
    styleExtra: `
      h4 { font-size: 13px; margin: 1rem 0 0.3rem; border-bottom: 1.5px solid #2e6f40; padding-bottom: 0.15rem; color: #2e6f40; }
      .p360-id { color: #556070; font-size: 12px; }
      ul { margin: 0.2rem 0 0.6rem; padding-left: 1.2rem; }
      .badge { display: inline-block; padding: 1px 6px; border: 1px solid #ccd; border-radius: 5px; font-size: 10px; }
      .p360-link { display: none; }  /* the 👤 affordance has no meaning on paper */`,
    body: `
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(subtitle)} · generated ${esc(_fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
    ${html}`,
  });
}
document.getElementById("player360-print")?.addEventListener("click", exportP360);

// --- Global search (top bar → players AND officials) ---
(() => {
  const input = document.getElementById("player-search");
  const box = document.getElementById("player-search-results");
  if (!input || !box) return;
  let timer = null;
  const close = () => { box.hidden = true; box.innerHTML = ""; input.setAttribute("aria-expanded", "false"); };
  const render = (rows, q) => {
    if (!rows.length) {
      box.innerHTML = hstr`<div class="ps-empty">No players or officials match “${q}”.</div>`;
    } else {
      box.innerHTML = rows.map((r) =>
        hstr`<button type="button" class="ps-item" role="option" data-type="${r.type}" data-id="${r.id}"><span class="ps-name">${r.name} <span class="ps-tag ps-tag-${r.type}">${r.type === "official" ? "Official" : "Player"}</span></span><span class="ps-meta">${r.meta}</span></button>`).join("");
      box.querySelectorAll(".ps-item").forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.type === "official") openOfficial360(Number(b.dataset.id));
        else openPlayer360(Number(b.dataset.id), active ? active.id : null);
        input.value = ""; close();
      }));
    }
    box.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      try {
        const [players, officials] = await Promise.all([
          api(`/players/search?q=${encodeURIComponent(q)}`).catch(() => []),
          api(`/officials/search?q=${encodeURIComponent(q)}`).catch(() => []),
        ]);
        const loc = (x) => [x.city, x.state].filter(Boolean).join(", ");
        const rows = [
          ...players.map((p) => ({ type: "player", id: p.id,
            name: [p.last_name, p.first_name].filter(Boolean).join(", "),
            meta: `USTA #${p.usta_number || "—"}${loc(p) ? " · " + loc(p) : ""}` })),
          ...officials.map((o) => ({ type: "official", id: o.id,
            name: [o.last_name, o.first_name].filter(Boolean).join(", "),
            meta: loc(o) || "official" })),
        ];
        render(rows, q);
      } catch (_) { close(); }
    }, 200);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; close(); } });
  document.addEventListener("click", (e) => { if (!e.target.closest("#player-search-wrap")) close(); });
})();

// --- Reports (officials confirmation + pay/mileage) ---
let reportData = null;
// money() imported from ./app/ui.js (D11)

// Minimum officials/day the TD wants — a day/site below it (but >0) is flagged
// "thin" (amber); zero stays a hard gap (red). Persisted so it survives reloads.
let _coverageMin = Math.max(0, parseInt(localStorage.getItem("courtops.coverageMin"), 10) || 1);
// Cell class for a coverage count given the threshold: red at 0, amber if below
// the minimum, plain otherwise.
function _covClass(n) { return n === 0 ? "warn" : (n < _coverageMin ? "cov-thin" : ""); }
// Renders the per-day footer row, the per-site grid, and the coverage note from
// reportData + the current threshold (no refetch — used on threshold change).
function _renderCoverage() {
  if (!reportData) return;
  const cols = _reportColumns(reportData.tournament);
  const covByDate = {};
  for (const c of (reportData.coverage || [])) covByDate[c.date] = c.officials;
  const covCells = cols.map((c) => {
    const n = covByDate[c.date] ?? 0;
    const cls = _covClass(n);
    return `<th class="daycol${cls ? " " + cls : ""}">${n}</th>`;
  }).join("");
  document.getElementById("report-coverage").innerHTML =
    `<th colspan="6">Officials per day</th>${covCells}<th></th><th></th><th></th>`;
  // Note: zero-coverage days (hard gap) + below-minimum days (thin), separately.
  const covNote = document.getElementById("report-coverage-note");
  const uncovered = reportData.uncovered_days || [];
  const thin = (reportData.coverage || [])
    .filter((c) => c.officials > 0 && c.officials < _coverageMin)
    .map((c) => c.date);
  const bits = [];
  if (uncovered.length) bits.push(hstr`<strong>${uncovered.length} day(s) with no official</strong>: ${uncovered.map((d) => fmtDOW(d)).join(", ")}`);
  if (thin.length) bits.push(hstr`${thin.length} day(s) below the ${_coverageMin}-official minimum: ${thin.map((d) => fmtDOW(d)).join(", ")}`);
  if (bits.length) { covNote.hidden = false; covNote.innerHTML = "⚠ " + bits.join(" · ") + " — fill before the event."; }
  else { covNote.hidden = true; covNote.textContent = ""; }

  const siteCov = reportData.site_coverage || [];
  document.querySelector("#site-coverage-table thead").innerHTML =
    html`<tr><th>Site</th>${cols.map((c) => html`<th class="daycol">${c.head}</th>`)}</tr>`;
  const scBody = document.querySelector("#site-coverage-table tbody");
  scBody.innerHTML = siteCov.length
    ? html`${siteCov.map((s) => {
        const cells = s.by_date.map((b) => {
          const cls = _covClass(b.officials);
          return hstr`<td class="daycol${cls ? " " + cls : ""}">${b.officials}</td>`;
        }).join("");
        return html`<tr><td>${s.site_label}</td>${raw(cells)}</tr>`;
      })}`
    : html`<tr><td class="empty" colspan="${cols.length + 1}">No sites linked to this tournament.</td></tr>`;

  // Per-role coverage grid: rows = roles used, columns = days, cell = officials
  // working that role that day (same zero/thin highlighting as the others).
  // Conditional attribute fragments (flag/attrs) are built with hstr`` (which
  // auto-escapes + returns a string) and raw()'d into the cell, so they compose
  // without re-escaping — the documented attribute-fragment technique.
  const roleCov = reportData.role_coverage || [];
  document.querySelector("#role-coverage-table thead").innerHTML =
    html`<tr><th>Role</th>${cols.map((c) => html`<th class="daycol">${c.head}</th>`)}</tr>`;
  const rcBody = document.querySelector("#role-coverage-table tbody");
  rcBody.innerHTML = roleCov.length
    ? html`${roleCov.map((r) => {
        const holders = r.holders || 0;
        const cells = r.by_date.map((b) => {
          const n = b.officials;
          const cls = _covClass(n);
          // Cert-pool gap: a day undercovered for this role while MORE certified
          // officials are available is a *fixable* gap — flag it with a ⚑ and make
          // the cell clickable to pick a certified official and fill it on the spot.
          const below = n === 0 || n < _coverageMin;
          const fixable = below && holders > n;
          const flag = fixable
            ? hstr` <span class="cov-flag" title="${`${n} staffed, ${holders} certified available — click to fill`}">⚑</span>` : "";
          const attrs = fixable ? hstr` data-cov-role="${r.role}" data-cov-date="${b.date}"` : "";
          return hstr`<td class="daycol${cls ? " " + cls : ""}${fixable ? " cov-fixable" : ""}"${raw(attrs)} title="${`${n} staffed · ${holders} certified${fixable ? " — click to fill" : ""}`}">${n}${raw(flag)}</td>`;
        }).join("");
        return html`<tr><td>${certLabel(r.role)} <span class="muted">(${holders} certified)</span></td>${raw(cells)}</tr>`;
      })}`
    : html`<tr><td class="empty" colspan="${cols.length + 1}">No officials assigned yet.</td></tr>`;
}

// Coverage gap → invite: clicking a fixable role/day cell opens a popover of
// certified officials who could fill it, each with a one-click "Fill" that
// assigns them (if needed) + adds the day in the right role, then refreshes.
let _covPop = null;
function _closeCovPop() { if (_covPop) { _covPop.remove(); _covPop = null; } }
document.addEventListener("click", (e) => {
  const cell = e.target.closest && e.target.closest("#role-coverage-table .cov-fixable");
  if (!cell) { if (!e.target.closest || !e.target.closest(".cov-pop")) _closeCovPop(); return; }
  _openCovGap(cell);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") _closeCovPop(); });

async function _openCovGap(cell) {
  _closeCovPop();
  if (!active) return;
  const role = cell.dataset.covRole, date = cell.dataset.covDate;
  const pop = document.createElement("div");
  pop.className = "cov-pop";
  pop.innerHTML = hstr`<div class="cov-pop-head">${certLabel(role)} · ${fmtDOW(date)}</div><p class="muted">Loading…</p>`;
  document.body.appendChild(pop);
  _covPop = pop;
  // Anchor below the cell, clamped to the viewport.
  const r = cell.getBoundingClientRect();
  pop.style.top = `${window.scrollY + r.bottom + 4}px`;
  pop.style.left = `${window.scrollX + Math.min(r.left, window.innerWidth - 300)}px`;
  let cands;
  try {
    cands = await api(`/tournaments/${active.id}/coverage-candidates?role=${encodeURIComponent(role)}&date=${encodeURIComponent(date)}`);
  } catch (err) { pop.innerHTML = hstr`<p class="msg bad">${err.message}</p>`; return; }
  if (_covPop !== pop) return;  // closed while loading
  if (!cands.length) {
    pop.innerHTML = html`<div class="cov-pop-head">${certLabel(role)} · ${fmtDOW(date)}</div><p class="cov-pop-empty">No un-booked official holds this certification. Add a certification or a new official first.</p>`;
    return;
  }
  const tag = (c) => {
    const t = [];
    if (c.available) t.push('<span class="cov-tag cov-tag-ok">available</span>');
    if (c.assigned_here) t.push('<span class="cov-tag">already on event</span>');
    if (c.busy_elsewhere) t.push('<span class="cov-tag cov-tag-warn">busy elsewhere</span>');
    return t.join(" ");
  };
  pop.innerHTML = html`<div class="cov-pop-head">Fill ${certLabel(role)} · ${fmtDOW(date)}</div><ul class="cov-cand-list">${cands.map((c) =>
    html`<li class="cov-cand"><span class="cov-cand-name">${c.official_name} ${raw(tag(c))}</span><button type="button" class="cov-fill-btn" data-oid="${c.official_id}" data-name="${c.official_name}">Fill</button></li>`)}</ul>`;
  pop.querySelectorAll(".cov-fill-btn").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api(`/tournaments/${active.id}/coverage-fill`, {
        method: "POST",
        body: JSON.stringify({ official_id: Number(btn.dataset.oid), work_date: date, working_as: role }),
      });
      toast(`Assigned ${btn.dataset.name} as ${certLabel(role)} on ${fmtDOW(date)}`, true);
      _closeCovPop();
      loadReports();
    } catch (err) { toast(err.message, false); btn.disabled = false; }
  }));
}

// Staffing-conflict report: one consolidated, grouped list of every clash the
// TD must resolve (double-bookings, uncertified days, off-availability/off-window
// days, hotel-date mismatches). Officials link to their 360 for quick triage.
async function _renderConflicts() {
  const box = document.getElementById("report-conflicts");
  if (!box || !active) return;
  let rep;
  try { rep = await api(`/tournaments/${active.id}/conflicts`); }
  catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
  if (!rep.counts.total) {
    box.innerHTML = '<p class="conflict-clean">✓ No staffing conflicts — every assignment is clean.</p>';
    return;
  }
  const name = (c) => html`<strong>${c.official_name}</strong>`;
  const groups = [];
  if (rep.double_bookings.length) {
    groups.push(html`<div class="conflict-group"><h5>⛔ Double-booked (${rep.double_bookings.length}${rep.counts.hard_double_bookings ? `, ${rep.counts.hard_double_bookings} impossible` : ""})</h5><ul>${rep.double_bookings.map((c) =>
      html`<li class="${c.different_site ? "conflict-hard" : ""}">${name(c)} on <strong>${fmtDOW(c.work_date)}</strong> — also at ${c.other_tournament || "another event"}${c.other_site ? html` (${c.other_site})` : ""}${c.different_site ? raw(' <span class="conflict-badge">different site — impossible</span>') : raw(' <span class="conflict-badge soft">same/again — verify</span>')}</li>`)}</ul></div>`);
  }
  if (rep.uncertified.length) {
    groups.push(html`<div class="conflict-group"><h5>⚠ Uncertified for the role (${rep.uncertified.length})</h5><ul>${rep.uncertified.map((c) =>
      html`<li>${name(c)} works <strong>${certLabel(c.working_as)}</strong> on ${fmtDOW(c.work_date)} without that certification</li>`)}</ul></div>`);
  }
  if (rep.outside_availability.length) {
    groups.push(html`<div class="conflict-group"><h5>📅 Worked outside declared availability (${rep.outside_availability.length})</h5><ul>${rep.outside_availability.map((c) =>
      html`<li>${name(c)} is assigned <strong>${fmtDOW(c.work_date)}</strong> but didn't declare it available</li>`)}</ul></div>`);
  }
  if (rep.out_of_window.length) {
    groups.push(html`<div class="conflict-group"><h5>🗓 Day outside the play window (${rep.out_of_window.length})</h5><ul>${rep.out_of_window.map((c) => html`<li>${name(c)} has a worked day outside the tournament dates</li>`)}</ul></div>`);
  }
  if (rep.hotel_mismatch.length) {
    groups.push(html`<div class="conflict-group"><h5>🛏 Hotel dates don't cover worked days (${rep.hotel_mismatch.length})</h5><ul>${rep.hotel_mismatch.map((c) => html`<li>${name(c)} works days outside their room-block check-in/out</li>`)}</ul></div>`);
  }
  box.innerHTML = html`<p class="conflict-summary">⚠ ${rep.counts.total} issue(s) to resolve before the event.</p>${groups}`;
}

// Day-by-day schedule: one block per play-day listing who works (official, role,
// site), with a headcount and an empty-day flag — the TD's day-of sheet. Officials
// link to their 360. Built from the lightweight /schedule aggregate.
async function _renderSchedule() {
  const box = document.getElementById("report-schedule");
  if (!box || !active) return;
  let d;
  try { d = await api(`/tournaments/${active.id}/schedule`); }
  catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
  if (!d.days.length) { box.innerHTML = '<p class="muted">No play-date window set.</p>'; return; }
  box.innerHTML = html`${d.days.map((day) => {
    const head = html`<div class="sched-day-head">${fmtDOW(day.date)} <span class="sched-count${day.count === 0 ? " sched-empty" : ""}">${day.count} working</span></div>`;
    if (!day.count) return html`<div class="sched-day">${head}<p class="sched-none">— no officials assigned —</p></div>`;
    const rows = day.entries.map((e) =>
      html`<tr><td>${e.official_name}</td><td>${certLabel(e.working_as)}</td><td>${e.site_label || "—"}</td><td>${raw(_respChip(e.response_status))}</td></tr>`);
    return html`<div class="sched-day">${head}<table class="list-table sched-table"><thead><tr><th>Official</th><th>Role</th><th>Site</th><th>Response</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  })}`;
}

// Dietary summary: assigned officials grouped by restriction (most common first),
// each with a count + the names, plus a none-count — a catering-ready rollup.
async function _renderDietary() {
  const box = document.getElementById("report-dietary");
  if (!box || !active) return;
  let d;
  try { d = await api(`/tournaments/${active.id}/dietary-summary`); }
  catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
  if (!d.total_people) { box.innerHTML = '<p class="muted">No officials staffed yet.</p>'; return; }
  if (!d.items.length) {
    box.innerHTML = `<p class="muted">No dietary restrictions on file (${d.total_people} official(s) staffed).</p>`;
    return;
  }
  const rows = d.items.map((i) =>
    html`<tr><td><strong>${i.restriction}</strong></td><td class="num">${i.count}</td><td>${i.people.join("; ")}</td></tr>`);
  box.innerHTML = html`<p class="diet-sub">${d.with_restrictions} of ${d.total_people} staffed official(s) have a dietary restriction${d.none_count ? html` · ${d.none_count} none` : ""}.</p><table class="list-table diet-table"><thead><tr><th>Restriction</th><th class="num">Count</th><th>Officials</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// Missing distances: official↔site pairs with no mileage on file (mileage stays
// null). Each row has an inline miles input + Save (POST /distances) so the TD
// fills them all here; saving refreshes the list.
async function _renderMissingDistances() {
  const box = document.getElementById("report-missing-dist");
  if (!box || !active) return;
  let d;
  try { d = await api(`/tournaments/${active.id}/missing-distances`); }
  catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
  if (!d.count) { box.innerHTML = '<p class="muted">✓ Every assigned official has a distance to their site.</p>'; return; }
  const rows = d.items.map((i) =>
    html`<tr data-oid="${i.official_id}" data-sid="${i.site_id}"><td>${i.official_name}</td><td>${i.site_label || "—"}</td><td class="num">${i.days}</td><td><input type="number" class="md-miles" min="0" step="0.1" placeholder="miles" style="width:6rem" /> <button type="button" class="md-save btn-small">Save</button></td></tr>`);
  box.innerHTML = html`<p class="muted md-sub">${d.count} official↔site pair(s) need a one-way distance for mileage.</p><table class="list-table md-table"><thead><tr><th>Official</th><th>Site</th><th class="num">Days</th><th>One-way miles</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll(".md-save").forEach((btn) => btn.addEventListener("click", async () => {
    const tr = btn.closest("tr");
    const miles = parseFloat(tr.querySelector(".md-miles").value);
    if (!(miles >= 0)) { toast("Enter a valid mileage", false); return; }
    btn.disabled = true;
    try {
      await api("/distances", { method: "POST", body: JSON.stringify({
        official_id: Number(tr.dataset.oid), site_id: Number(tr.dataset.sid),
        one_way_miles: miles, source: "manual" }) });
      toast("Distance saved", true);
      loadReports();  // re-render: the pair clears + mileage recomputes
    } catch (e) { toast(e.message, false); btn.disabled = false; }
  }));
}

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
    cols.map((c) => hstr`<th class="daycol">${c.head}</th>`).join("") +
    '<th class="num">Days</th><th class="num">Pay</th><th class="num">Mileage</th></tr>';
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
      (o.days_outside_availability && o.days_outside_availability.length) ? "not available" : "",
      (o.uncertified_days && o.uncertified_days.length) ? "not certified" : "",
      o.response_status === "declined" ? "DECLINED" : "",
    ].filter(Boolean);
    const warn = flags.length ? hstr` <span class="warn" title="${flags.join(", ")}">⚠</span>` : "";
    const dayCells = cols.map((c) => `<td class="daycol">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
    const tr = document.createElement("tr");
    tr.innerHTML = html`<td>${o.official_name}${raw(warn)}</td><td>${roles}</td><td>${o.dietary_restrictions}</td><td>${o.hotel_name ? "Yes" : "No"}</td><td>${_fmtMDY(o.check_in)}</td><td>${_fmtMDY(o.check_out)}</td>${raw(dayCells)}<td class="num">${o.days.length}</td><td class="num">${money(o.pay)}</td><td class="num">${money(o.mileage)}</td>`;
    tbody.appendChild(tr);
  }
  const lead = 6 + cols.length;  // columns before the Days/Pay/Mileage trio
  if (reportData.officials.length === 0)
    tbody.innerHTML = `<tr><td class="empty" colspan="${lead + 3}">No officials assigned yet.</td></tr>`;
  const note = (totals.conflict_count ? ` · ${totals.conflict_count} double-booked` : "") +
    (totals.missing_distance_count ? ` · ${totals.missing_distance_count} missing distance` : "") +
    (totals.hotel_mismatch_count ? ` · ${totals.hotel_mismatch_count} hotel-date alert(s)` : "") +
    (totals.out_of_window_count ? ` · ${totals.out_of_window_count} off-window day alert(s)` : "") +
    (totals.availability_count ? ` · ${totals.availability_count} availability alert(s)` : "") +
    (totals.uncertified_count ? ` · ${totals.uncertified_count} cert alert(s)` : "") +
    (totals.declined_count ? ` · ${totals.declined_count} declined` : "") +
    (totals.pending_count ? ` · ${totals.pending_count} pending` : "");
  document.getElementById("report-totals").innerHTML =
    `<th colspan="${lead}">Totals${note}</th>` +
    `<th class="num">${totals.official_days_total}</th>` +
    `<th class="num">${money(totals.pay)}</th><th class="num">${money(totals.mileage)}</th>`;

  _renderCoverage();
  _renderConflicts();
  _renderSchedule();
  _renderDietary();
  _renderMissingDistances();

  // Officials needing accommodation: those with a hotel assignment, with the
  // span of days they work (the nights they need a room).
  const lodge = document.querySelector("#lodging-table tbody");
  const housed = reportData.officials.filter((o) => o.hotel_name);
  lodge.innerHTML = housed.length
    ? html`${housed.map((o) => {
        const ds = o.days.map((d) => d.work_date).sort();
        const span = ds.length ? `${fmtDOW(ds[0])} – ${fmtDOW(ds[ds.length - 1])}` : "—";
        return html`<tr><td>${o.official_name}</td><td>${o.hotel_name}</td><td>${span}</td></tr>`;
      })}`
    : '<tr><td class="empty" colspan="3">No officials have a hotel assignment yet.</td></tr>';

  // Room-block pickup: reserved vs assigned per official comp block, so the TD
  // can release unused rooms before the hotel cutoff. Unused rooms are flagged.
  const blocks = reportData.room_blocks || [];
  const pickupBody = document.querySelector("#pickup-table tbody");
  pickupBody.innerHTML = blocks.length
    ? html`${blocks.map((b) => {
        const span = (b.check_in && b.check_out)
          ? `${_fmtMDY(b.check_in)} – ${_fmtMDY(b.check_out)}` : "—";
        return html`<tr><td>${b.hotel_name}</td><td>${b.confirmation_number || ""}</td><td>${span}</td><td class="num">${b.room_count}</td><td class="num">${b.assigned}</td><td class="num${b.remaining > 0 ? " warn" : ""}">${b.remaining}</td></tr>`;
      })}`
    : '<tr><td class="empty" colspan="6">No official room blocks for this tournament.</td></tr>';
  document.getElementById("pickup-totals").innerHTML = blocks.length
    ? `<th colspan="3">Totals</th><th class="num">${totals.rooms_reserved}</th>` +
      `<th class="num">${totals.rooms_assigned}</th>` +
      `<th class="num${totals.rooms_remaining > 0 ? " warn" : ""}">${totals.rooms_remaining}</th>`
    : "";
  const pnote = document.getElementById("pickup-note");
  if (totals.rooms_remaining > 0) {
    pnote.hidden = false;
    pnote.innerHTML = `<span class="warn">⚠ ${totals.rooms_remaining} reserved room(s) not yet assigned</span> — release before the hotel cutoff to avoid attrition charges.`;
  } else { pnote.hidden = true; pnote.textContent = ""; }

  // Non-official support staff (Site Director, Trainer, …), grouped by role,
  // with the same weekday day-grid the officials roster uses.
  const staff = reportData.staff || [];
  const scols = _reportColumns(reportData.tournament);
  document.querySelector("#report-staff-table thead").innerHTML =
    html`<tr><th>Name</th><th>Role</th>${scols.map((c) => html`<th class="daycol">${c.head}</th>`)}<th class="num">Pay</th><th>Phone</th></tr>`;
  const staffBody = document.querySelector("#report-staff-table tbody");
  staffBody.innerHTML = staff.length
    ? html`${staff.map((s) => {
        const worked = new Set(s.days || []);
        const dayCells = scols.map((c) => `<td class="daycol">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
        return html`<tr><td>${s.name}</td><td>${STAFF_ROLES[s.role] || s.role}</td>${raw(dayCells)}<td class="num">${s.pay ? money(s.pay) : ""}</td><td>${s.phone || ""}</td></tr>`;
      })}`
    : html`<tr><td class="empty" colspan="${scols.length + 4}">No non-official staff added for this tournament.</td></tr>`;
  if (staff.length && (totals.staff_pay || 0) > 0) {
    staffBody.innerHTML += `<tr><th colspan="${scols.length + 2}">Staff pay total</th>` +
      `<th class="num">${money(totals.staff_pay)}</th><th></th></tr>`;
  }

  _renderCertPool();
}
// Certification pool matrix: officials (rows) × cert types (cols), ✓ where held,
// with a holder count per cert in the footer — so the TD plans role coverage
// against the available pool. A cert with zero holders is flagged (a gap).
function _renderCertPool() {
  const pool = reportData.cert_pool || { officials: [], counts: {} };
  document.querySelector("#cert-pool-table thead").innerHTML =
    html`<tr><th>Official</th>${_certs.pairs.map(([, lbl]) => html`<th class="num">${lbl}</th>`)}</tr>`;
  const body = document.querySelector("#cert-pool-table tbody");
  body.innerHTML = pool.officials.length
    ? html`${pool.officials.map((o) => {
        const held = new Set(o.certs);
        const cells = _certs.pairs.map(([v]) => `<td class="num">${held.has(v) ? "✓" : ""}</td>`).join("");
        // An official with no certs can't be assigned ANY role — flag the name.
        const noCert = !o.certs.length;
        const name = noCert
          ? html`<span class="warn" title="holds no certification — can't be assigned any role">⚠ ${o.official_name}</span>`
          : html`${o.official_name}`;
        return html`<tr><td>${name}</td>${raw(cells)}</tr>`;
      })}`
    : html`<tr><td class="empty" colspan="${_certs.pairs.length + 1}">No officials in the system yet.</td></tr>`;
  // Footer: holders per cert (zero flagged as a coverage gap in the pool).
  document.getElementById("cert-pool-totals").innerHTML =
    `<th>Holders</th>` + _certs.pairs.map(([v]) => {
      const n = pool.counts[v] || 0;
      return `<th class="num${n === 0 ? " warn" : ""}">${n}</th>`;
    }).join("");
  // A note when any official holds no cert at all (chase their paperwork).
  const note = document.getElementById("cert-pool-note");
  const noneCert = pool.officials.filter((o) => !o.certs.length);
  if (note) {
    if (noneCert.length) {
      note.hidden = false;
      note.innerHTML = html`⚠ ${noneCert.length} official(s) hold no certification: <strong>${noneCert.map((o) => o.official_name).join("; ")}</strong> — can't be assigned any role.`;
    } else { note.hidden = true; note.textContent = ""; }
  }
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
    ...cols.map((c) => c.head), "Days", "Pay", "Mileage"];
  const rows = [header];
  if (includeData) {
    for (const o of reportData.officials) {
      const worked = new Set(o.days.map((d) => d.work_date));
      const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
      rows.push([
        o.official_name, roles, o.dietary_restrictions || "", o.hotel_name ? "Yes" : "No",
        _fmtMDY(o.check_in), _fmtMDY(o.check_out),
        ...cols.map((c) => (worked.has(c.date) ? "X" : "")),
        o.days.length, o.pay, o.mileage == null ? "" : o.mileage,
      ]);
    }
    const tt = reportData.totals;
    rows.push(["Totals", "", "", "", "", "", ...cols.map(() => ""),
      tt.official_days_total, tt.pay, tt.mileage]);
    // Coverage section — per-day officials count + per-site grid, aligned under
    // the same day columns so the TD can track gaps in a spreadsheet.
    const covByDate = {};
    for (const c of (reportData.coverage || [])) covByDate[c.date] = c.officials;
    rows.push([]);  // blank separator
    rows.push(["Officials per day", "", "", "", "", "",
      ...cols.map((c) => covByDate[c.date] ?? 0), "", "", ""]);
    for (const s of (reportData.site_coverage || [])) {
      const byDate = {};
      for (const b of s.by_date) byDate[b.date] = b.officials;
      rows.push([s.site_label, "", "", "", "", "",
        ...cols.map((c) => byDate[c.date] ?? 0), "", "", ""]);
    }
    for (const r of (reportData.role_coverage || [])) {
      const byDate = {};
      for (const b of r.by_date) byDate[b.date] = b.officials;
      rows.push([certLabel(r.role), "", "", "", "", "",
        ...cols.map((c) => byDate[c.date] ?? 0), "", "", ""]);
    }
  }
  return rows;
}
document.getElementById("report-print").addEventListener("click", () => window.print());
// PDF export: open a clean, self-contained report (officials staffing plan +
// lodging + other staff) in a new window and auto-print → the TD saves as PDF.
// No PDF lib — mirrors the hotel-report print-window pattern.
function exportReportPdf() {
  if (!reportData) { toast("Load the report first", false); return; }
  const e = esc, t = reportData.tournament, totals = reportData.totals;
  const cols = _reportColumns(t);
  const dayHead = cols.map((c) => `<th class="day">${e(c.head)}</th>`).join("");
  const offRows = reportData.officials.length ? reportData.officials.map((o) => {
    const worked = new Set(o.days.map((d) => d.work_date));
    const roles = [...new Set(o.days.map((d) => d.working_as))].map(certLabel).join(", ");
    const dayCells = cols.map((c) => `<td class="day">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
    const flags = [o.has_conflict ? "double-booked" : "", o.missing_distance ? "no distance" : "",
      o.hotel_date_mismatch ? "hotel dates" : "", o.work_date_out_of_window ? "off-window" : "",
      (o.days_outside_availability && o.days_outside_availability.length) ? "not available" : "",
      (o.uncertified_days && o.uncertified_days.length) ? "not certified" : "",
      o.response_status === "declined" ? "DECLINED" : ""].filter(Boolean).join("; ");
    return `<tr><td>${e(o.official_name)}${flags ? ` <span class="flag">⚠ ${e(flags)}</span>` : ""}</td>` +
      `<td>${e(roles)}</td><td>${e(o.dietary_restrictions || "")}</td><td>${o.hotel_name ? "Yes" : "No"}</td>` +
      `<td>${e(_fmtMDY(o.check_in))}</td><td>${e(_fmtMDY(o.check_out))}</td>${dayCells}` +
      `<td class="num">${o.days.length}</td>` +
      `<td class="num">${money(o.pay)}</td><td class="num">${money(o.mileage)}</td></tr>`;
  }).join("") : `<tr><td class="empty" colspan="${cols.length + 9}">No officials assigned.</td></tr>`;
  const staff = reportData.staff || [];
  const staffRows = staff.length ? staff.map((s) => {
    const worked = new Set(s.days || []);
    const dayCells = cols.map((c) => `<td class="day">${worked.has(c.date) ? "✓" : ""}</td>`).join("");
    return `<tr><td>${e(s.name)}</td><td>${e(STAFF_ROLES[s.role] || s.role)}</td>${dayCells}` +
      `<td class="num">${s.pay ? money(s.pay) : ""}</td></tr>`;
  }).join("") : `<tr><td class="empty" colspan="${cols.length + 3}">No non-official staff.</td></tr>`;
  const housed = reportData.officials.filter((o) => o.hotel_name);
  const lodgeRows = housed.length ? housed.map((o) => {
    const ds = o.days.map((d) => d.work_date).sort();
    const span = ds.length ? `${fmtDOW(ds[0])} – ${fmtDOW(ds[ds.length - 1])}` : "—";
    return `<tr><td>${e(o.official_name)}</td><td>${e(o.hotel_name)}</td><td>${e(span)}</td></tr>`;
  }).join("") : `<tr><td class="empty" colspan="3">No officials with a hotel assignment.</td></tr>`;
  const blocks = reportData.room_blocks || [];
  const pickupRows = blocks.length ? blocks.map((b) => {
    const span = (b.check_in && b.check_out) ? `${e(_fmtMDY(b.check_in))} – ${e(_fmtMDY(b.check_out))}` : "—";
    const flag = b.remaining > 0 ? ' class="flag"' : "";
    return `<tr><td>${e(b.hotel_name)}</td><td>${e(b.confirmation_number || "")}</td><td>${span}</td>` +
      `<td class="num">${b.room_count}</td><td class="num">${b.assigned}</td><td class="num"${flag}>${b.remaining}</td></tr>`;
  }).join("") + `<tr class="totals"><td colspan="3">Totals</td><td class="num">${totals.rooms_reserved}</td>` +
      `<td class="num">${totals.rooms_assigned}</td><td class="num">${totals.rooms_remaining}</td></tr>`
    : `<tr><td class="empty" colspan="6">No official room blocks.</td></tr>`;
  // Certification pool matrix (officials × cert types).
  const pool = reportData.cert_pool || { officials: [], counts: {} };
  const certHead = _certs.pairs.map(([, lbl]) => `<th class="num">${e(lbl)}</th>`).join("");
  const certRows = pool.officials.length ? pool.officials.map((o) => {
    const held = new Set(o.certs);
    const cells = _certs.pairs.map(([v]) => `<td class="num">${held.has(v) ? "✓" : ""}</td>`).join("");
    const name = o.certs.length ? e(o.official_name) : `<span style="color:#c62828">⚠ ${e(o.official_name)}</span>`;
    return `<tr><td>${name}</td>${cells}</tr>`;
  }).join("") + `<tr class="totals"><td>Holders</td>` +
      _certs.pairs.map(([v]) => { const n = pool.counts[v] || 0; return `<td class="num"${n === 0 ? ' style="color:#c62828;font-weight:700"' : ""}>${n}</td>`; }).join("") + `</tr>`
    : `<tr><td class="empty" colspan="${_certs.pairs.length + 1}">No officials.</td></tr>`;
  // Coverage cells honor the same threshold as the on-screen tables: red at 0,
  // amber below the minimum.
  const _covStyle = (n) => n === 0 ? ' style="color:#c62828;font-weight:700"'
    : (n < _coverageMin ? ' style="color:#735710;background:#fff8e6;font-weight:700"' : "");
  const covByDate = {};
  for (const c of (reportData.coverage || [])) covByDate[c.date] = c.officials;
  const covCells = cols.map((c) => {
    const n = covByDate[c.date] ?? 0;
    return `<td class="day"${_covStyle(n)}>${n}</td>`;
  }).join("");
  const coverageRow = `<tr class="totals"><td colspan="6">Officials per day</td>${covCells}<td></td><td></td><td></td></tr>`;
  const siteCov = reportData.site_coverage || [];
  const siteCovRows = siteCov.length ? siteCov.map((s) => {
    const cells = s.by_date.map((b) => `<td class="day"${_covStyle(b.officials)}>${b.officials}</td>`).join("");
    return `<tr><td>${e(s.site_label)}</td>${cells}</tr>`;
  }).join("") : `<tr><td class="empty" colspan="${cols.length + 1}">No sites linked.</td></tr>`;
  const roleCov = reportData.role_coverage || [];
  const roleCovRows = roleCov.length ? roleCov.map((r) => {
    const holders = r.holders || 0;
    const cells = r.by_date.map((b) => {
      const fixable = (b.officials === 0 || b.officials < _coverageMin) && holders > b.officials;
      return `<td class="day"${_covStyle(b.officials)}>${b.officials}${fixable ? " ⚑" : ""}</td>`;
    }).join("");
    return `<tr><td>${e(certLabel(r.role))} (${holders} certified)</td>${cells}</tr>`;
  }).join("") : `<tr><td class="empty" colspan="${cols.length + 1}">No officials assigned.</td></tr>`;
  printDoc({
    title: `Staffing plan — ${e(t.name)}`,
    styleExtra: `
      body { margin: 1.2cm; }
      h2 { font-size: 14px; margin: 1.4rem 0 0.4rem; border-bottom-width: 2px; }
      .meta { margin-bottom: 0.4rem; }
      td.day, th.day { text-align: center; }
      .flag { color: #c62828; font-size: 10px; }
      @media print { @page { margin: 1cm; size: landscape; } }`,
    body: `
    <h1>Officials staffing plan</h1>
    <div class="meta">${e(t.name)} · ${e(t.play_start_date)} → ${e(t.play_end_date)}${totals.rule_version ? ` · pay rule ${e(reportData.officials.find((o) => o.rule_version)?.rule_version || "")}` : ""}</div>
    <table><thead><tr><th>Name</th><th>Position</th><th>Dietary</th><th>Hotel?</th><th>Check-in</th><th>Check-out</th>${dayHead}<th class="num">Days</th><th class="num">Pay</th><th class="num">Mileage</th></tr></thead>
      <tbody>${offRows}
        <tr class="totals"><td colspan="${cols.length + 6}">Totals — ${totals.official_count} official(s)</td><td class="num">${totals.official_days_total}</td><td class="num">${money(totals.pay)}</td><td class="num">${money(totals.mileage)}</td></tr>
        ${coverageRow}
      </tbody></table>
    ${totals.uncovered_days_count ? `<p style="color:#c62828">⚠ ${totals.uncovered_days_count} day(s) with no official assigned: ${reportData.uncovered_days.map((d) => e(fmtDOW(d))).join(", ")}</p>` : ""}
    <h2>Coverage by site &amp; day</h2>
    <table><thead><tr><th>Site</th>${dayHead}</tr></thead><tbody>${siteCovRows}</tbody></table>
    <h2>Coverage by role &amp; day</h2>
    <table><thead><tr><th>Role</th>${dayHead}</tr></thead><tbody>${roleCovRows}</tbody></table>
    <h2>Certification pool — all officials</h2>
    <table><thead><tr><th>Official</th>${certHead}</tr></thead><tbody>${certRows}</tbody></table>
    <h2>Officials needing accommodation</h2>
    <table><thead><tr><th>Official</th><th>Hotel</th><th>Nights (worked days)</th></tr></thead><tbody>${lodgeRows}</tbody></table>
    <h2>Room-block pickup (officials)</h2>
    <table><thead><tr><th>Hotel</th><th>Confirmation</th><th>Dates</th><th class="num">Reserved</th><th class="num">Assigned</th><th class="num">Unused</th></tr></thead><tbody>${pickupRows}</tbody></table>
    <h2>Other staff${totals.staff_pay ? ` — pay ${money(totals.staff_pay)}` : ""}</h2>
    <table><thead><tr><th>Name</th><th>Role</th>${dayHead}<th class="num">Pay</th></tr></thead><tbody>${staffRows}</tbody></table>`,
  });
}
document.getElementById("report-pdf").addEventListener("click", exportReportPdf);

// Batch pay statements: one printable section per assigned official (worked days
// + rate, mileage, total) + a tournament grand total — the reimbursement packet
// the TD hands to finance. Reuses the report print-window pattern (no PDF lib).
async function exportPayStatementsBatch() {
  if (!active) { toast("Select a tournament first", false); return; }
  let d;
  try { d = await api(`/tournaments/${active.id}/pay-statements`); }
  catch (e) { toast(e.message, false); return; }
  if (!d.officials.length) { toast("No officials assigned yet", false); return; }
  const e = esc, t = d.tournament, tt = d.totals;
  const sections = d.officials.map((o) => {
    const dayRows = o.days.length ? o.days.map((x) =>
      `<tr><td>${e(_fmtMDY(x.work_date))}</td><td>${e(certLabel(x.working_as))}</td>` +
      `<td class="num">${money(x.rate_applied)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="muted">No worked days.</td></tr>`;
    const mileage = o.missing_distance ? "—  (no distance on file)"
      : `${money(o.mileage)}${o.one_way_miles != null ? `  (${o.one_way_miles} mi one-way${o.mileage === 0 ? ", within free 50 mi" : ""})` : ""}`;
    return `<h2>${e(o.official_name)}${o.official_email ? ` · ${e(o.official_email)}` : ""}</h2>` +
      `<table><thead><tr><th>Date</th><th>Role</th><th class="num">Rate</th></tr></thead>` +
      `<tbody>${dayRows}</tbody></table>` +
      `<p class="line">Pay: <strong>${money(o.pay)}</strong> · Mileage: <strong>${mileage}</strong>` +
      ` · Total: <strong>${money(o.total)}</strong></p>`;
  }).join("");
  printDoc({
    title: `Pay statements — ${t.name}`,
    styleExtra: `
      .grand { margin-top: 1rem; padding: 0.5rem 0.7rem; background: #e7f1ea; border: 1px solid #2e6f40; border-radius: 6px; font-size: 13px; }`,
    body: `
    <h1>Officiating pay statements</h1>
    <div class="sub">${e(t.name)} · ${e(t.play_start_date)} → ${e(t.play_end_date)} · generated ${e(_fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
    ${sections}
    <div class="grand"><strong>Tournament total: ${money(tt.total)}</strong> ` +
      `(pay ${money(tt.pay)} + mileage ${money(tt.mileage)}) · ${tt.days} day(s) across ${tt.officials} official(s)</div>`,
  });
}
document.getElementById("report-pay-statements").addEventListener("click", exportPayStatementsBatch);

// Rooming list → print window: one table per hotel block (official, nights they
// need, dietary) for the TD to hand to the hotel. A ⬇ CSV button is embedded in
// the print window for hotels that want a spreadsheet. Reuses the print pattern.
async function exportRoomingList() {
  if (!active) { toast("Select a tournament first", false); return; }
  let d;
  try { d = await api(`/tournaments/${active.id}/rooming-list`); }
  catch (e) { toast(e.message, false); return; }
  if (!d.blocks.length) { toast("No official room blocks for this tournament", false); return; }
  const e = esc, t = d.tournament, tt = d.totals;
  // CSV rows for the embedded download (flat: one row per occupant).
  const csv = [["Hotel", "Confirmation", "Official", "First night", "Last night", "Dietary", "Phone"]];
  const sections = d.blocks.map((b) => {
    const span = (b.check_in && b.check_out)
      ? `${e(_fmtMDY(b.check_in))} – ${e(_fmtMDY(b.check_out))}` : "dates TBD";
    const rows = b.occupants.length ? b.occupants.map((o) => {
      csv.push([b.hotel_name, b.confirmation_number || "", o.official_name,
                o.first_night || "", o.last_night || "", o.dietary_restrictions || "", o.official_phone || ""]);
      const nights = (o.first_night && o.last_night)
        ? `${e(_fmtMDY(o.first_night))} – ${e(_fmtMDY(o.last_night))}` : "—";
      return `<tr><td>${e(o.official_name)}</td><td>${nights}</td>` +
        `<td>${e(o.dietary_restrictions || "")}</td><td>${e(o.official_phone || "")}</td></tr>`;
    }).join("") : `<tr><td colspan="4" class="muted">No officials assigned to this block.</td></tr>`;
    return `<h2>${e(b.hotel_name)}${b.confirmation_number ? ` · conf. ${e(b.confirmation_number)}` : ""}</h2>` +
      `<p class="line">Block dates: ${span} · ${b.occupants.length}/${b.room_count} room(s) used</p>` +
      `<table><thead><tr><th>Official</th><th>Nights needed</th><th>Dietary</th><th>Phone</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }).join("");
  const csvData = csv.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  printDoc({
    title: `Rooming list — ${t.name}`,
    popupMsg: "Allow pop-ups to export",
    csv: { data: csvData, filename: "rooming-list-" + (t.name || "").replace(/\s+/g, "_") + ".csv" },
    styleExtra: `
      h2 { margin-bottom: 0.2rem; }
      .line { color: #556070; margin: 0.1rem 0 0.4rem; }`,
    body: `
    <h1>Hotel rooming list</h1>
    <div class="sub">${e(t.name)} · ${tt.blocks} block(s) · ${tt.occupants} room night-guest(s) · ${tt.rooms_reserved} room(s) reserved · generated ${e(_fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
    ${sections}`,
  });
}
document.getElementById("report-rooming-list").addEventListener("click", exportRoomingList);

// Day-by-day schedule → print window: one table per play-day (official, role,
// site) with an embedded CSV download — the day-of sheet to hand to sites.
async function exportSchedule() {
  if (!active) { toast("Select a tournament first", false); return; }
  let d;
  try { d = await api(`/tournaments/${active.id}/schedule`); }
  catch (e) { toast(e.message, false); return; }
  if (!d.days.length) { toast("No play-date window set", false); return; }
  const e = esc, t = d.tournament;
  const csv = [["Date", "Official", "Role", "Site", "Response"]];
  const sections = d.days.map((day) => {
    const rows = day.entries.length ? day.entries.map((en) => {
      csv.push([day.date, en.official_name, certLabel(en.working_as), en.site_label || "", en.response_status || ""]);
      return `<tr><td>${e(en.official_name)}</td><td>${e(certLabel(en.working_as))}</td>` +
        `<td>${e(en.site_label || "—")}</td><td>${e(en.response_status || "")}</td></tr>`;
    }).join("") : `<tr><td colspan="4" class="muted">No officials assigned.</td></tr>`;
    return `<h2>${e(_fmtMDY(day.date))} <span class="cnt">(${day.count} working)</span></h2>` +
      `<table><thead><tr><th>Official</th><th>Role</th><th>Site</th><th>Response</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`;
  }).join("");
  const csvData = csv.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  printDoc({
    title: `Schedule — ${t.name}`,
    popupMsg: "Allow pop-ups to export",
    csv: { data: csvData, filename: "schedule-" + (t.name || "").replace(/\s+/g, "_") + ".csv" },
    styleExtra: `
      h2 { margin-bottom: 0.2rem; }
      h2 .cnt { font-weight: 400; color: #556070; font-size: 11px; }`,
    body: `
    <h1>Day-by-day schedule</h1>
    <div class="sub">${e(t.name)} · generated ${e(_fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
    ${sections}`,
  });
}
document.getElementById("report-schedule-export").addEventListener("click", exportSchedule);
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
    { header: "ingest_address", key: "ingest_address" },
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
  columns: [
    { key: "id", responsive: 10 },
    // Inline-editable composite: shown "Last, First" → split back into last/first.
    { key: "name", fmt: officialLabel, responsive: 0,  // identity — never collapse
      edit: { editor: "input", composite: { get: officialLabel, set: (val) => _splitName(val) } } },
    // Inline-editable composite: "City, ST" → city / state.
    { key: "loc", fmt: (o) => [o.city, o.state].filter(Boolean).join(", "), responsive: 4,
      edit: { editor: "input", composite: { get: (o) => [o.city, o.state].filter(Boolean).join(", "), set: (val) => _splitCityState(val) } } },
    { key: "phone", responsive: 3, edit: { editor: "input" } },
    { key: "email", responsive: 2, edit: { editor: "input" } },
    { key: "dietary_restrictions", responsive: 6, edit: { editor: "input" } },
  ],
  exportCols: [
    { header: "first_name", key: "first_name" }, { header: "last_name", key: "last_name" },
    { header: "street", key: "street" }, { header: "city", key: "city" },
    { header: "state", key: "state" }, { header: "zip", key: "zip" },
    { header: "phone", key: "phone" }, { header: "email", key: "email" },
    { header: "dietary_restrictions", key: "dietary_restrictions" },
    { header: "lat", key: "lat" }, { header: "lng", key: "lng" },
  ],
  // Server-side search + capped page (same as Players; UI backlog).
  serverSearch: { pageSize: 500 },
  onLoad: (rows, info) => {
    // Keep the picker cache full — don't rebuild it from a search-narrowed page.
    if (info && info.q) return;
    for (const k in officialsById) delete officialsById[k]; rows.forEach((o) => (officialsById[o.id] = o)); refreshAllSelects();
  },
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
    formatter: (c) => { const h = c.getData(); return hstr`${(h.valid_from || "").slice(0, 10) + " → " + (h.valid_to || "").slice(0, 10)}`; } },
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

// Parse the combined Name / City-St cells back into their DB fields for inline
// edit. Name: "Last, First" honours the comma; otherwise the last token is the
// surname and everything before it the given name(s). City/St: split on the last
// comma so multi-word cities ("San Francisco, CA") survive.
function _splitName(val) {
  const s = String(val == null ? "" : val).trim();
  if (!s) return { first_name: "", last_name: "" };
  if (s.includes(",")) { const [last, ...rest] = s.split(","); return { last_name: last.trim(), first_name: rest.join(",").trim() }; }
  const parts = s.split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: "" };
  return { first_name: parts.slice(0, -1).join(" "), last_name: parts[parts.length - 1] };
}
function _splitCityState(val) {
  const s = String(val == null ? "" : val).trim();
  if (!s) return { city: "", state: "" };
  const i = s.lastIndexOf(",");
  if (i < 0) return { city: s, state: "" };
  return { city: s.slice(0, i).trim(), state: s.slice(i + 1).trim() };
}

const playersCrud = wireEntity({
  path: "/players", singular: "player", panelId: "panel-players", formId: "player-form", msgId: "player-msg",
  optimisticConcurrency: true,  // audit M19/M8: send X-If-Updated-At on PUT
  columns: [
    { key: "id", responsive: 10 },
    { key: "usta_number", responsive: 5, edit: { editor: "input" } },
    { key: "name", responsive: 0, fmt: (p) => [p.first_name, p.last_name].filter(Boolean).join(" "),
      // Inline-editable composite: type "First Last" (or "Last, First") → split back
      // into first_name / last_name. Edit the modal for anything fancier.
      edit: { editor: "input", composite: {
        get: (r) => [r.first_name, r.last_name].filter(Boolean).join(" "),
        set: (val) => _splitName(val) } } },
    { key: "gender", responsive: 3, fmt: (p) => p.gender === "male" ? "Male" : p.gender === "female" ? "Female" : "—",
      edit: { editor: "list", params: { values: [{ label: "Male", value: "male" }, { label: "Female", value: "female" }] } } },
    { key: "loc", responsive: 4, fmt: (p) => [p.city, p.state].filter(Boolean).join(", "),
      // Inline-editable composite: type "City, ST" → split into city / state.
      edit: { editor: "input", composite: {
        get: (r) => [r.city, r.state].filter(Boolean).join(", "),
        set: (val) => _splitCityState(val) } } },
  ],
  exportCols: [
    { header: "usta_number", key: "usta_number" },
    { header: "first_name", key: "first_name" }, { header: "last_name", key: "last_name" },
    { header: "gender", key: "gender" }, { header: "birthdate", key: "birthdate" },
    { header: "city", key: "city" }, { header: "state", key: "state" },
  ],
  // Server-side search + capped page (the inbox pattern; UI backlog). 500 covers
  // any realistic single-TD roster pool; past that the grid stays fast and the
  // note says to refine. q/limit/offset + X-Total-Count live on GET /api/players.
  serverSearch: { pageSize: 500 },
  onLoad: (rows, info) => {
    // Don't rebuild the picker cache from a SEARCH-narrowed page — pickers
    // (roster add, Part B player refs) need the full roster, and a stale-but-
    // complete cache beats a fresh-but-filtered one.
    if (info && info.q) return;
    for (const k in playersById) delete playersById[k];
    for (const k in playersByUsta) delete playersByUsta[k];
    rows.forEach((p) => { playersById[p.id] = p; if (p.usta_number) playersByUsta[p.usta_number] = p; });
    _invalidatePickCache();
    refreshAllSelects();
  },
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
  onLoad: (rows) => { _divCatalog.setDivisions(rows); refreshDivisionLists(); },
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
  onLoad: (rows) => { _divCatalog.setEvents(rows); refreshDivisionLists(); },
});

// =================== Generic CSV export for list tables ===================
// _csvDownload from createCsvExport (./app/export_csv.js — H4.1/H4.2 gate).
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
// Thin-coverage threshold: re-highlight the coverage tables from memory (no
// refetch) when the TD changes the minimum, and persist their choice.
(() => {
  const inp = document.getElementById("report-min-cov");
  if (!inp) return;
  inp.value = _coverageMin;
  inp.addEventListener("input", () => {
    _coverageMin = Math.max(0, parseInt(inp.value, 10) || 0);
    localStorage.setItem("courtops.coverageMin", String(_coverageMin));
    _renderCoverage();
  });
})();

// D11: workspace form modals + ARIA detail dialogs
installFormModals({ scheduleComboSync, detailBackdrop: _detailBackdrop, setCloseOpenDetail });
enhanceDetailDialogs();

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
      _certs.pairs = enums.cert_type.map((c) => [c.value, c.label]);
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
  _meOfficialGeo = { lat: o.lat ?? null, lng: o.lng ?? null };
  for (const el of document.getElementById("me-form").elements) {
    if (el.name) el.value = o[el.name] == null ? "" : o[el.name];
  }
  meTournaments = await api("/me/tournaments");
  const sel = document.getElementById("me-tournament");
  sel.innerHTML = "";
  if (!meTournaments.length) {
    const op = document.createElement("option");
    op.value = ""; op.textContent = "— no tournaments yet —";
    sel.appendChild(op);
  } else {
    for (const t of meTournaments) {
      const op = document.createElement("option");
      op.value = t.id; op.textContent = `${t.name} (${t.play_start_date} → ${t.play_end_date})`;
      sel.appendChild(op);
    }
  }
  await loadMyAvailability();
  await loadMyAssignments();
  await loadMyPay();
}
async function loadMyPay() {
  const box = document.getElementById("me-pay");
  if (!box) return;
  let s;
  try { s = await api("/me/pay-summary"); } catch (_) { return; }
  if (!s.tournaments.length) { box.innerHTML = '<p class="muted">No assignments yet.</p>'; return; }
  const rows = s.tournaments.map((t) =>
    html`<tr><td>${t.tournament_name || ("Tournament " + t.tournament_id)}</td><td>${t.days}</td><td>${raw(_respChip(t.response_status))}</td><td class="num">${money(t.pay)}</td><td class="num">${money(t.mileage)}</td><td class="num">${money(t.total)}</td></tr>`).join("");
  box.innerHTML = `<table class="list-table"><thead><tr><th>Tournament</th><th>Days</th><th>Status</th>` +
    `<th class="num">Pay</th><th class="num">Mileage</th><th class="num">Total</th></tr></thead><tbody>${rows}` +
    `<tr><th colspan="3">Season total — ${s.totals.assignments} assignment(s), ${s.totals.days} day(s)</th>` +
    `<th class="num">${money(s.totals.pay)}</th><th class="num">${money(s.totals.mileage)}</th>` +
    `<th class="num">${money(s.totals.total)}</th></tr></tbody></table>`;
}
async function loadMyAssignments() {
  const box = document.getElementById("me-assignments");
  if (!box) return;
  let rows = [];
  try { rows = await api("/me/assignments"); } catch (_) {}
  if (!rows.length) { box.innerHTML = '<p class="muted">No assignments yet.</p>'; return; }
  box.innerHTML = "";
  for (const a of rows) {
    const tname = (meTournaments.find((t) => t.id === a.tournament_id) || {}).name || `Tournament ${a.tournament_id}`;
    const days = a.days.map((d) => fmtDOW(d.work_date)).join(", ") || "—";
    const card = document.createElement("div"); card.className = "asg";
    // Pay/mileage the official actually cares about.
    const mileage = a.missing_distance ? "—" : (a.mileage == null ? "—" : "$" + a.mileage.toFixed(2));
    // Day-level issues the official should see and can act on (decline / contact
    // the TD): scheduled outside their availability, on a role they aren't
    // certified for, or double-booked with another tournament.
    const issues = [];
    for (const d of (a.days_outside_availability || [])) issues.push(`${fmtDOW(d)} — outside the dates you marked available`);
    for (const u of (a.uncertified_days || [])) issues.push(`${fmtDOW(u.work_date)} — ${certLabel(u.working_as)}, which isn't in your certifications`);
    // plain text — escaped once when rendered (issuesHtml below). (Previously
    // esc()'d here AND again via issues.map(esc) — a latent double-escape.)
    if (a.has_conflict) for (const c of (a.conflicts || [])) issues.push(`${fmtDOW(c.work_date)} — also booked at ${c.other_tournament}`);
    const issuesHtml = issues.length
      ? html`<div class="asg-flags">⚠ Heads-up: ${issues.join("; ")}.</div>` : "";
    const prompt = a.response_status === "pending"
      ? '<div class="asg-prompt">Please <strong>accept</strong> or <strong>decline</strong> below.</div>' : "";
    const card_head = html`<div class="asg-head"><strong>${tname}</strong> ${raw(_respChip(a.response_status))}<div class="asg-meta">site: ${a.site_label || "—"} · days: ${days} · pay $${a.pay.toFixed(2)} · mileage ${mileage}</div></div>`;
    card.innerHTML = `${card_head}${prompt}${issuesHtml}`;
    const actions = document.createElement("div"); actions.className = "add-day";
    const mk = (status, txt, danger) => {
      const b = document.createElement("button"); b.type = "button";
      b.className = "btn-link" + (danger ? " danger" : ""); b.textContent = txt;
      b.disabled = a.response_status === status;
      b.addEventListener("click", async () => {
        try { await api(`/me/assignments/${a.id}/respond`, { method: "POST", body: JSON.stringify({ status }) });
          toast(`Marked ${status}`, true); loadMyAssignments(); }
        catch (e) { toast(e.message, false); }
      });
      return b;
    };
    actions.append(mk("accepted", "Accept"), mk("declined", "Decline", true));
    if (a.response_status !== "pending") actions.append(mk("pending", "Clear"));
    card.appendChild(actions);
    box.appendChild(card);
  }
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

// Quick-select for the official's own availability grid (mirrors the admin
// editor's bulk buttons): toggle the #me-dates checkboxes in place; the official
// still reviews + clicks Save.
document.querySelectorAll("#official-app .avail-bulk [data-mebulk]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mebulk;
    document.querySelectorAll("#me-dates input").forEach((cb) => {
      const dow = _availDow(cb.value);  // 0=Sun … 6=Sat
      if (mode === "all") cb.checked = true;
      else if (mode === "none") cb.checked = false;
      else if (mode === "weekdays") cb.checked = dow >= 1 && dow <= 5;
      else if (mode === "weekends") cb.checked = dow === 0 || dow === 6;
    });
  });
});

// Auth / session / role-view wiring lives in app/auth.js (P2 #11b). What to
// LOAD when the role resolves stays here (nav history, breadcrumbs, admin /
// official init) and is injected via onRoleResolved; onLogout resets the
// admin-loaded latch. createAuth also wires the login / logout / change-password
// forms and the one-shot "session expired" listener.
const { applyAuth } = createAuth({
  api, setMsg, toast, onSubmit,
  onRoleResolved: ({ who, isAdmin, isOfficial }) => {
    authUser = who || null;
    // Clear stale crumbs on sign-out; when the user becomes admin (first login
    // OR session restore), seed the trail with the currently active tab so the
    // strip isn't empty until they click something.
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
    if (isAdmin) adminInit();
    if (isOfficial) officialInit();
  },
  onLogout: () => { adminLoaded = false; authUser = null; },
});

// --- Trash (P2 #13): list + restore soft-deleted tournaments / incidents ---
const _trashModal = document.getElementById("trash-modal");
function _closeTrash() { _trashModal.hidden = true; }
function _trashWhen(iso) {
  return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function _renderTrash(data) {
  const body = document.getElementById("trash-body");
  const tRows = (data.tournaments || []).map((t) => html`
    <tr><td>${t.name}</td><td class="muted">${t.type} · ${t.play_start_date}→${t.play_end_date}</td>
    <td class="muted">${_trashWhen(t.deleted_at)}</td>
    <td><button type="button" class="btn-link" data-restore="tournament" data-id="${t.id}">Restore</button></td></tr>`);
  const iRows = (data.incidents || []).map((i) => html`
    <tr><td>${i.description}</td><td class="muted">${i.tournament_name} · ${i.category}/${i.severity}</td>
    <td class="muted">${_trashWhen(i.deleted_at)}</td>
    <td><button type="button" class="btn-link" data-restore="incident" data-id="${i.id}">Restore</button></td></tr>`);
  if (!tRows.length && !iRows.length) { body.innerHTML = '<p class="muted">Trash is empty — nothing to restore.</p>'; return; }
  body.innerHTML = html`
    ${tRows.length ? html`<h4>Tournaments</h4><table class="list-table"><thead><tr><th>Name</th><th>When</th><th>Trashed</th><th></th></tr></thead><tbody>${tRows}</tbody></table>` : ""}
    ${iRows.length ? html`<h4>Incidents</h4><table class="list-table"><thead><tr><th>What happened</th><th>Tournament</th><th>Trashed</th><th></th></tr></thead><tbody>${iRows}</tbody></table>` : ""}`;
}
async function _openTrash() {
  const body = document.getElementById("trash-body");
  body.innerHTML = '<p class="muted">Loading…</p>';
  _trashModal.hidden = false;
  try { _renderTrash(await api("/trash")); }
  catch (e) { body.innerHTML = html`<p class="msg-err">${e.message}</p>`; }
}
document.getElementById("trash-btn").addEventListener("click", _openTrash);
document.getElementById("trash-close").addEventListener("click", _closeTrash);
_trashModal.addEventListener("click", (e) => { if (e.target.id === "trash-modal") _closeTrash(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !_trashModal.hidden) _closeTrash(); });
document.getElementById("trash-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-restore]");
  if (!btn) return;
  const { restore: kind, id } = btn.dataset;
  try {
    if (kind === "tournament") {
      await api(`/tournaments/${id}/restore`, { method: "POST" });
      tournamentsCrud.refresh();        // back into the Setup list + active picker
    } else {
      await api(`/incidents/${id}/restore`, { method: "POST" });
      if (active) loadIncidents();
    }
    toast("Restored", true);
    _openTrash();                       // refresh the trash list in place
  } catch (err) { toast(err.message, false); }
});

// Audit F27: explicit allow-list matches OfficialCreate so a future template
// change can't silently introduce an extra input that breaks the PUT with a
// confusing 422.
const _ME_PROFILE_FIELDS = [
  "first_name", "last_name", "street", "city", "state", "zip",
  "phone", "email", "dietary_restrictions", "lat", "lng",
];
// Cached from last /me load so a profile Save that only posts form fields
// cannot null out geocoded lat/lng (walkthrough: form has no lat/lng inputs).
let _meOfficialGeo = { lat: null, lng: null };
onSubmit(document.getElementById("me-form"), async (e) => {
  const b = {};
  for (const el of e.target.elements) {
    if (!el.name) continue;
    if (!_ME_PROFILE_FIELDS.includes(el.name)) continue;  // ignore stray inputs
    b[el.name] = el.value === "" ? null : el.value;
  }
  // Preserve coordinates the form doesn't expose.
  if (b.lat == null) b.lat = _meOfficialGeo.lat;
  if (b.lng == null) b.lng = _meOfficialGeo.lng;
  try {
    await api("/me/profile", { method: "PUT", body: JSON.stringify(b) });
    setMsg("me-msg", "saved", true);
  } catch (err) { setMsg("me-msg", err.message, false); }
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

// --- Admin users (Setup; multi-user TD access, D8) ---
const userForm = document.getElementById("user-form");
async function loadUsers() {
  let me = null;
  try { me = await api("/auth/me"); } catch (_) {}
  const rows = await api("/admin/users");
  const tb = document.querySelector("#user-table tbody");
  tb.innerHTML = "";
  if (!rows.length) { tb.innerHTML = '<tr><td class="empty" colspan="3">No admin users.</td></tr>'; return; }
  for (const u of rows) {
    const isSelf = me && u.username === me.username;
    const tr = document.createElement("tr");
    const nameCell = document.createElement("td");
    nameCell.innerHTML = hstr`${u.username}${isSelf ? raw(' <span class="badge badge-info">you</span>') : ""}`;
    const dateCell = document.createElement("td");
    dateCell.textContent = (u.created_at || "").slice(0, 10);
    const actCell = document.createElement("td"); actCell.className = "grid-actions-cell";
    const reset = document.createElement("button");
    reset.type = "button"; reset.className = "btn-link"; reset.textContent = "Reset password";
    reset.addEventListener("click", async () => {
      const pw = window.prompt(`New password for ${u.username}:`);
      if (!pw) return;
      try {
        await api(`/admin/users/${u.id}/password`, { method: "POST", body: JSON.stringify({ password: pw }) });
        toast(`Password reset — ${u.username} must sign in again`, true);
      } catch (e) { toast(e.message, false); }
    });
    actCell.appendChild(reset);
    if (!isSelf) {  // can't delete your own account (the backend also guards this)
      const del = document.createElement("button");
      del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
      del.addEventListener("click", async () => {
        if (!(await confirmDialog(`Delete admin "${u.username}"?`))) return;
        try { await api(`/admin/users/${u.id}`, { method: "DELETE" }); loadUsers(); }
        catch (e) { toast(e.message, false); }
      });
      actCell.append(" ", del);
    }
    tr.append(nameCell, dateCell, actCell);
    tb.appendChild(tr);
  }
}
onSubmit(userForm, async () => {
  try {
    await api("/admin/users", { method: "POST", body: JSON.stringify(formObj(userForm)) });
    setMsg("user-msg", "admin added", true); userForm.reset(); loadUsers();
  } catch (err) { setMsg("user-msg", err.message, false); markInvalid(userForm, err.message); }
});

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
