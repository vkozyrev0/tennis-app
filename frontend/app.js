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
import { createAssignmentsPanel } from "./app/assignments_ui.js";
import { createInboxPanel } from "./app/inbox.js";
import { createReportsPanel } from "./app/reports.js";
import { createStaffPanel } from "./app/staff.js";
import { createDashboardPanel } from "./app/dashboard.js";
import { createPlayer360 } from "./app/player360.js";
import { createIncidentsPanel } from "./app/incidents.js";
import { createTshirtsPanel } from "./app/tshirts.js";

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

// D11: assignments panel
const { loadAssignments, respChip: _respChip, filterByResponse: _filterAsgByResponse } = createAssignmentsPanel({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit, openForm,
  html, hstr, raw, esc, money, fmtDOW, fillSelect, officialLabel, siteLabel,
  certLabel, chip, makeMenuButton, scheduleComboSync, prereqCallout,
  makeListGrid, getActive: () => active, getOfficialsById: () => officialsById,
  getSitesById: () => sitesById, getHotelsById: () => hotelsById,
  getCertPairs: () => _certs.pairs, datesInRange: _datesInRange,
});

// D11: staff panel (./app/staff.js)
const { loadStaff } = createStaffPanel({
  api, setMsg, confirmDialog, markInvalid, formObj, onSubmit, openForm,
  hstr, money, fmtDOW, makeListGrid, getActive: () => active, datesInRange: _datesInRange,
});

// D11: incidents panel (./app/incidents.js)
const { loadIncidents } = createIncidentsPanel({
  api, setMsg, confirmDialog, markInvalid, onSubmit, openForm,
  hstr, fillSelect, siteLabel, makeListGrid, scheduleComboSync,
  getActive: () => active, getSitesById: () => sitesById,
});

// D11: day-of venue panel (./app/dayof.js)
const { loadDayOf, resetStickyDate: _dayOfReset } = createDayOfPanel({
  api, toast, setMsg, html, hstr, raw, fmtMDY: _fmtMDY, certLabel, respChip: _respChip,
  getActive: () => active, getCertPairs: () => _certs.pairs,
});
_resetDayOfDate = _dayOfReset;

// D11: payroll panel lives in ./app/payroll.js (pairs with backend payroll router)
const { loadPayroll } = createPayrollPanel({
  api, setMsg, confirmDialog, markInvalid, money, html, hstr, raw,
  makeReadGrid, printDoc, fmtMDY: _fmtMDY, getActive: () => active,
});

// D11: availability panel (./app/availability.js)
const { loadAvailability } = createAvailabilityPanel({
  api, setMsg, toast, html, hstr, raw, fmtDOW, fillSelect, officialLabel, certLabel,
  makeReadGrid, getActive: () => active, getOfficialsById: () => officialsById,
  getCertPairs: () => _certs.pairs,
});

// D11: review inbox panel
const { loadInbox } = createInboxPanel({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
  html, hstr, raw, esc, money, fmtDOW, chip, fillSelect, playerLabel, officialLabel,
  makeReadGrid, makeListGrid, makeMenuButton, scheduleComboSync, openForm,
  getActive: () => active, getPlayersById: () => playersById, getPlayersByUsta: () => playersByUsta,
  getTournamentsById: () => tournamentsById,
  rosterPrefillFromEmail, rosterPrefillFromName, resolveFilePlayerId,
  gotoImport: typeof gotoImport === "function" ? gotoImport : () => {},
  SHIRT_LABELS,
});

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

// D11: t-shirts panel (cumulative list + inventory/order + by-site)
const { loadTshirts, loadTshirtOrder, loadTshirtsBySite } = createTshirtsPanel({
  api, setMsg, toast, confirmDialog, html, hstr,
  makeReadGrid, _csvDownload, playerCell: _playerCell, getActive: () => active,
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

// D11: player/official 360 drawer (before dashboard — workload links open 360)
const { openPlayer360, openOfficial360, exportP360, exportPayStatement } = createPlayer360({
  api, toast, html, hstr, raw, esc, money, fmtDOW, fmtMDY: _fmtMDY, certLabel, respChip: _respChip, chip,
  printDoc, getActive: () => active,
});

// D11: home dashboard
const { loadDashboard } = createDashboardPanel({
  api, toast, html, hstr, raw, esc, money, fmtDOW, fmtMDY: _fmtMDY, certLabel, respChip: _respChip, chip,
  getActive: () => active, activateGroup, setActive, openOfficial360,
  filterAssignments: _filterAsgByResponse,
});

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

// D11: reports panel
const {
  loadReports, reportCsvExport, reportTemplateExport, exportReportPdf,
  exportPayStatementsBatch, exportRoomingList, exportSchedule,
} = createReportsPanel({
  api, setMsg, toast, confirmDialog, markInvalid,
  html, hstr, raw, esc, money, fmtDOW, fmtMDY: _fmtMDY, dowLong: _dowLong, certLabel, officialLabel,
  printDoc, csvDownload: _csvDownload, getActive: () => active,
  getOfficialsById: () => officialsById, getSitesById: () => sitesById,
  datesInRange: _datesInRange,
});

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
// tshirt-order-csv wired inside createTshirtsPanel (D11)
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
