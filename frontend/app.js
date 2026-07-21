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
import { createPairingDoublesPanel } from "./app/pairing_doubles.js";
import { createPartBPanels } from "./app/partb.js";
import { createTournamentSitesPanel } from "./app/tournament_sites.js";
import { createRosterPanel } from "./app/roster.js";
import { createImportPage } from "./app/import_ui.js";

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

// D11: tournament sites membership + division->site map
const { loadTSites, loadTSiteDivisions, renderTSites } = createTournamentSitesPanel({
  api, setMsg, hstr, makeReadGrid, siteLabel,
  getActive: () => active, getSitesById: () => sitesById,
});


// D11: Roster panel
// openPlayer360 / inboxAddToRoster filled after those factories run (mutable refs).
const _rosterRefs = {
  openPlayer360: (pid, tid) => { if (typeof openPlayer360 === "function") openPlayer360(pid, tid); },
  inboxAddToRoster: (m, plan) => { if (typeof inboxAddToRoster === "function") inboxAddToRoster(m, plan); },
  playersCrudRefresh: async () => { if (typeof playersCrud !== "undefined" && playersCrud.refresh) await playersCrud.refresh(); },
};
const { loadRoster, rosterSignInExport, rosterSignInTemplate, rosterGrid } = createRosterPanel({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
  html, hstr, raw, money, chip, makeMenuButton, makeGrid,
  scheduleComboSync, syncCombos, prereqCallout, openForm,
  divisionListParams: _divisionListParams, rowGender: _rowGender, inferFormGender: _inferFormGender,
  refreshDivisionLists, SHIRT_LABELS, csvDownload: _csvDownload,
  detailBackdrop: _detailBackdrop, setCloseOpenDetail, GRIDS,
  getActive: () => active, getPlayersById: () => playersById,
  openPlayer360: (pid, tid) => _rosterRefs.openPlayer360(pid, tid),
  loadInbox: () => loadInbox(),
  playersCrudRefresh: () => _rosterRefs.playersCrudRefresh(),
  inboxAddToRoster: (m, plan) => _rosterRefs.inboxAddToRoster(m, plan),
});

// D11: Import page
function _importRefresh() {
  // Audit (fifth-pass #1 + seventh-pass B2): refresh every grid that an
  // importer can touch. Roster + Part B grids are tournament-scoped; Setup ->
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
const { gotoImport, buildImportPage } = createImportPage({
  api, setMsg, toast, confirmDialog, html, hstr, raw, esc,
  makeMenuButton, makeGrid, scheduleComboSync, activateGroup,
  getActive: () => active, importRefresh: _importRefresh,
});


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
const { loadInbox, inboxAddToRoster } = createInboxPanel({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
  html, hstr, raw, esc, money, fmtDOW, chip, fillSelect, playerLabel, officialLabel,
  makeReadGrid, makeListGrid, makeMenuButton, scheduleComboSync, openForm,
  getActive: () => active, getPlayersById: () => playersById, getPlayersByUsta: () => playersByUsta,
  getTournamentsById: () => tournamentsById,
  rosterPrefillFromEmail, rosterPrefillFromName, resolveFilePlayerId,
  gotoImport: typeof gotoImport === "function" ? gotoImport : () => {},
  SHIRT_LABELS,
});

// D11: Part B lists (late, withdrawals, sched/divflex, player hotels)
const {
  loadLate, loadWithdrawals, loadCvb, loadHotelSummary, loadLodgingSummary,
  schedList, divflexList, photelList,
} = createPartBPanels({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
  html, hstr, raw, esc, makeListGrid, makeReadGrid, makeGrid,
  createPlayerList, expandPlayerRef, csvDownload: _csvDownload, autoHeaderFilters: _autoHeaderFilters, GRIDS,
  divisionListParams: _divisionListParams, eventListParams: _eventListParams, rowGender: _rowGender, playerCell: _playerCell, printDoc,
  getActive: () => active, getHotelsById: () => hotelsById,
  loadInbox: () => loadInbox(), loadRoster: () => loadRoster(),
});


// D11: t-shirts panel (cumulative list + inventory/order + by-site)
const { loadTshirts, loadTshirtOrder, loadTshirtsBySite } = createTshirtsPanel({
  api, setMsg, toast, confirmDialog, html, hstr,
  makeReadGrid, _csvDownload, playerCell: _playerCell, getActive: () => active,
});


// D11: pairing avoidances + doubles
const { loadPairing, loadDoubles } = createPairingDoublesPanel({
  api, setMsg, confirmDialog, markInvalid, formObj, onSubmit,
  hstr, chip, makeListGrid, fillPlayerRef, enhanceSelect,
  divisionListParams: _divisionListParams, rowGender: _rowGender, playerCell: _playerCell,
  getActive: () => active, getPlayersById: () => playersById, loadInbox: () => loadInbox(),
});


// D11: player/official 360 drawer (before dashboard — workload links open 360)
const { openPlayer360, openOfficial360, exportP360, exportPayStatement } = createPlayer360({
  api, toast, html, hstr, raw, esc, money, fmtDOW, fmtMDY: _fmtMDY, certLabel, respChip: _respChip, chip,
  printDoc, getActive: () => active,
});
_rosterRefs.openPlayer360 = openPlayer360;
_rosterRefs.inboxAddToRoster = inboxAddToRoster;

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
