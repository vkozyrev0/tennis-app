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
import { installGlobalSearch } from "./app/global_search.js";
import { createSetupCrud } from "./app/setup_crud.js";
import { installExportWiring } from "./app/export_wiring.js";
import { createOfficialApp } from "./app/official_app.js";
import { installTrash } from "./app/trash.js";
import { installAdminUsers } from "./app/admin_users.js";
import { installFormA11y } from "./app/form_a11y.js";
import { createAdminBoot } from "./app/admin_boot.js";
import { datesInRange as _datesInRange } from "./app/util.js";

// ============================================================================
// CourtOps Tennis — frontend composition root (vanilla JS, no build step).
//
// Two areas:
//  * Setup — persistent master data (tournaments, sites, officials, players,
//    rates, hotels, distances, divisions, events) via wireEntity factories.
//  * Tournament workspace — active tournament scopes Sites / Roster /
//    Assignments / Room blocks / Part B / Day-of / Reports / …
//
// Architecture (D11, 2026-07-21): `app.js` is the thin orchestrator (~740 LOC).
// Behaviour lives in `frontend/app/*.js` ESM factories (createX / installX).
// AG Grid Community is vendored. See docs/design.md §8 for the module map.
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
const {
  pushCrumb: _pushCrumb,
  clearHistory: clearNavHistory,
  seedIfEmpty: seedNavIfEmpty,
  renderCrumbs: renderNavCrumbs,
} = createBreadcrumbs({ activateGroup });

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
  // Pin grid height to the viewport *before* AG Grid measures columns, then
  // remeasure after layout/fonts settle (toolbars can reflow after loaders run).
  sizeLists();
  _redrawPanelGrids(tab.dataset.target);
  requestAnimationFrame(() => {
    sizeLists();
    _redrawPanelGrids(tab.dataset.target);
  });
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
// openPlayer360 filled after player360 factory; loadInbox after inbox factory.
// inboxAddToRoster is implemented *inside* roster (owns the form); inbox calls it.
const _rosterRefs = {
  openPlayer360: (pid, tid) => { if (typeof openPlayer360 === "function") openPlayer360(pid, tid); },
  playersCrudRefresh: async () => { if (typeof playersCrud !== "undefined" && playersCrud.refresh) await playersCrud.refresh(); },
  loadInbox: () => { if (typeof loadInbox === "function") loadInbox(); },
};
const {
  loadRoster, rosterSignInExport, rosterSignInTemplate, rosterGrid,
  inboxAddToRoster, inboxAddBothToRoster,
} = createRosterPanel({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
  html, hstr, raw, money, chip, makeMenuButton, makeGrid,
  scheduleComboSync, syncCombos, prereqCallout, openForm,
  divisionListParams: _divisionListParams, rowGender: _rowGender, inferFormGender: _inferFormGender,
  refreshDivisionLists, SHIRT_LABELS, csvDownload: _csvDownload,
  detailBackdrop: _detailBackdrop, setCloseOpenDetail, GRIDS,
  getActive: () => active, getPlayersById: () => playersById,
  openPlayer360: (pid, tid) => _rosterRefs.openPlayer360(pid, tid),
  loadInbox: () => _rosterRefs.loadInbox(),
  playersCrudRefresh: () => _rosterRefs.playersCrudRefresh(),
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
  certLabel, chip, makeMenuButton, scheduleComboSync, syncCombos, prereqCallout,
  makeListGrid, getActive: () => active, getOfficialsById: () => officialsById,
  getSitesById: () => sitesById, getHotelsById: () => hotelsById,
  getCertPairs: () => _certs.pairs, datesInRange: _datesInRange, activateGroup,
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
const { loadInbox, invalidatePickCache, verifyEmailTargets } = createInboxPanel({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
  html, hstr, raw, esc, money, fmtDOW, chip, fillSelect, playerLabel, officialLabel,
  makeReadGrid, makeListGrid, makeMenuButton, scheduleComboSync, openForm,
  getActive: () => active, setActive, getPlayersById: () => playersById, getPlayersByUsta: () => playersByUsta,
  getTournamentsById: () => tournamentsById,
  rosterPrefillFromEmail, rosterPrefillFromName, resolveFilePlayerId,
  gotoImport: typeof gotoImport === "function" ? gotoImport : () => {},
  SHIRT_LABELS,
  progress: _progress, humanizeDetail: _humanizeDetail,
  rosterAddFromEmail: inboxAddToRoster,
  rosterAddBothFromEmail: inboxAddBothToRoster,
});
_rosterRefs.loadInbox = loadInbox;

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

// D11: home dashboard
const { loadDashboard } = createDashboardPanel({
  api, toast, html, hstr, raw, esc, money, fmtDOW, fmtMDY: _fmtMDY, certLabel, respChip: _respChip, chip,
  getActive: () => active, activateGroup, setActive, openOfficial360,
  filterAssignments: _filterAsgByResponse,
});

// D11: global player/official search
installGlobalSearch({
  api, hstr, getActive: () => active, openPlayer360, openOfficial360,
});

// D11: reports panel
const {
  loadReports, reportCsvExport, reportTemplateExport, exportReportPdf,
  exportPayStatementsBatch, exportRoomingList, exportSchedule,
  getCoverageMin, setCoverageMin, renderCoverage,
} = createReportsPanel({
  api, setMsg, toast, confirmDialog, markInvalid,
  html, hstr, raw, esc, money, fmtDOW, fmtMDY: _fmtMDY, dowLong: _dowLong, certLabel, officialLabel,
  printDoc, csvDownload: _csvDownload, getActive: () => active,
  getOfficialsById: () => officialsById, getSitesById: () => sitesById,
  datesInRange: _datesInRange,
});

// D11: Setup entity CRUD configs
const {
  tournamentsCrud, sitesCrud, officialsCrud, playersCrud,
  ratesCrud, hotelsCrud, distancesCrud, divisionsCrud, eventsCrud,
} = createSetupCrud({
  api, setMsg, toast, wireEntity, makeGrid, makeReadGrid, hstr, playerCell: _playerCell,
  officialLabel, siteLabel, syncCombos,
  fillActiveSelect, setActive, activateGroup, updateActiveUI, refreshAllSelects,
  refreshDivisionLists, divCatalog: _divCatalog,
  tournamentsById, sitesById, officialsById, playersById, playersByUsta, hotelsById,
  getActive: () => active,
  setActiveRef: (t) => { active = t; },
  setLastSelectedTournamentId: (id) => { lastSelectedTournamentId = id; },
  renderTSites: () => renderTSites(),
  invalidatePickCache: () => invalidatePickCache(),
});

// D11: remaining CSV export wiring + coverage-min control
installExportWiring({
  csvDownload: _csvDownload, rosterGrid, rosterSignInExport, rosterSignInTemplate,
  reportCsvExport, reportTemplateExport,
  getCoverageMin, setCoverageMin, renderCoverage,
});

// D11: workspace form modals + ARIA detail dialogs
installFormModals({ scheduleComboSync, detailBackdrop: _detailBackdrop, setCloseOpenDetail });
enhanceDetailDialogs();

// D11: admin boot (enums + Setup CRUD refresh)
const { adminInit, resetAdminLoaded } = createAdminBoot({
  api, certs: _certs, tournamentsById, setActive, updateActiveUI,
  getCruds: () => ({
    sites: sitesCrud, officials: officialsCrud, players: playersCrud,
    hotels: hotelsCrud, rates: ratesCrud, distances: distancesCrud,
    divisions: divisionsCrud, events: eventsCrud, tournaments: tournamentsCrud,
  }),
});

// D11: official self-service portal
const { officialInit } = createOfficialApp({
  api, setMsg, toast, onSubmit, html, hstr, raw, money, esc,
  fmtDOW, certLabel, respChip: _respChip, datesInRange: _datesInRange,
});

// Auth / session (./app/auth.js) — role reactions stay here
const { applyAuth } = createAuth({
  api, setMsg, toast, onSubmit,
  onRoleResolved: ({ who, isAdmin, isOfficial }) => {
    authUser = who || null;
    if (!isAdmin) {
      clearNavHistory();
    } else {
      const activeTab = document.querySelector(".tab.active");
      const grp = activeTab ? activeTab.closest(".menu-group") : null;
      if (activeTab && grp) seedNavIfEmpty(grp.dataset.group, activeTab.dataset.target);
    }
    renderNavCrumbs();
    if (isAdmin) adminInit();
    if (isOfficial) officialInit();
  },
  onLogout: () => { resetAdminLoaded(); authUser = null; },
});

// D11: trash restore
installTrash({
  api, toast, html, getActive: () => active,
  tournamentsCrud, loadIncidents: () => loadIncidents(),
});

// D11: form required markers + toolbar consolidation
const { markRequiredFields, consolidateInboxToolbar, consolidateRosterToolbar } = installFormA11y({
  makeMenuButton, gotoImport,
});

// D11: admin users panel
installAdminUsers({
  api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit, hstr, raw,
});

(async function init() {
  enhanceAllSelects();
  markRequiredFields();
  consolidateInboxToolbar();
  consolidateRosterToolbar();
  await refreshHealth();
  let who = null;
  try { who = await api("/auth/me"); } catch (e) { who = null; }
  applyAuth(who);
  if (who && who.role === "admin") verifyEmailTargets();
})();
