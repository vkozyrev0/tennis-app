// Minimal vanilla JS (no framework). Two areas:
//  * Setup — persistent master data (tournaments catalog, sites, officials,
//    players, rates, hotels, distances) via generic master-detail CRUD.
//  * Tournament workspace — an active tournament (shown in the context bar,
//    persisted) scopes Sites / Roster / Assignments / Room blocks.

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
});

let _inflight = 0;
function _progress(delta) {
  _inflight = Math.max(0, _inflight + delta);
  const p = document.getElementById("progress");
  if (p) p.classList.toggle("active", _inflight > 0);
}
async function api(path, options) {
  _progress(1);
  try {
    const res = await fetch("/api" + path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const body = res.status === 204 ? null : await res.json();
    if (!res.ok) {
      const detail = body && body.detail ? body.detail : res.statusText;
      throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    }
    return body;
  } finally {
    _progress(-1);
  }
}
function toast(text, ok = true) {
  const box = document.getElementById("toasts");
  if (!box || !text) return;
  const t = document.createElement("div");
  t.className = "toast " + (ok ? "ok" : "bad");
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 300); }, ok ? 2500 : 5000);
}
function setMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
    el.className = "msg " + (ok ? "ok" : "bad");
    if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
  }
  toast(text, ok);
}

// Styled confirm dialog (replaces native confirm); returns a Promise<bool>.
function confirmDialog(message, okLabel = "Delete") {
  return new Promise((resolve) => {
    const m = document.getElementById("confirm-modal");
    const ok = document.getElementById("confirm-ok");
    const cancel = document.getElementById("confirm-cancel");
    document.getElementById("confirm-text").textContent = message;
    ok.textContent = okLabel;
    m.hidden = false;
    ok.focus();
    const done = (v) => {
      m.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => { if (e.key === "Escape") done(false); else if (e.key === "Enter") done(true); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

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

// Open the collapsible <details> wrapping a form (used when filing/editing).
function openForm(form) {
  const d = form && form.closest("details.addbox");
  if (d) d.open = true;
  if (typeof syncCombos === "function") requestAnimationFrame(syncCombos);
}
function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function formObj(form) {
  const o = {};
  for (const el of form.elements) if (el.name) o[el.name] = el.value === "" ? null : el.value;
  return o;
}
// Register a submit handler that preventDefaults and disables the submit button
// while the async handler runs (guards against double-submit), re-enabling after.
function onSubmit(form, handler) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;
    try { await handler(e); } finally { if (btn) btn.disabled = false; }
  });
}
function fillSelect(el, items, labelFn, none = true) {
  if (!el) return;
  const cur = el.value;
  el.innerHTML = none ? '<option value="">— none —</option>' : "";
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id; o.textContent = labelFn(it);
    el.appendChild(o);
  }
  el.value = cur;
}

// =================== Type-in dropdowns (searchable comboboxes) ===================
// Progressively enhance every native <select> into a filterable, type-to-search
// dropdown. The native <select> stays in the DOM as the form's source of truth
// (value/required/submit/listeners all unchanged) — we just overlay a text input.
function enhanceSelect(sel) {
  if (!sel || sel.dataset.combo) return;
  sel.dataset.combo = "1";
  sel.tabIndex = -1;
  sel.classList.add("combo-native");
  const wrap = document.createElement("span");
  wrap.className = "combo";
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  const input = document.createElement("input");
  input.type = "text"; input.className = "combo-input"; input.autocomplete = "off";
  input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
  const list = document.createElement("div");
  list.className = "combo-list"; list.hidden = true;
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
      it.textContent = o.textContent;
      it.addEventListener("mousedown", (e) => { e.preventDefault(); choose(o); });
      list.appendChild(it);
    });
  }
  function paintHi() {
    [...list.children].forEach((c, i) => c.classList.toggle("hi", i === hi));
    if (list.children[hi]) list.children[hi].scrollIntoView({ block: "nearest" });
  }
  function open() { if (sel.disabled) return; render(""); hi = shown.findIndex((o) => o.value === sel.value); paintHi(); list.hidden = false; }
  // commit=true: if the text was cleared, clear the selection (for optional fields
  // that have a blank "" option). Otherwise just restore the displayed value.
  function close(commit) {
    list.hidden = true; hi = -1;
    if (commit && input.value.trim() === "" && sel.value !== "" && [...sel.options].some((o) => o.value === "")) {
      sel.value = ""; sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    syncDisplay();
  }
  function choose(o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); syncDisplay(); close(false); }

  // Select existing text on focus so the first keystroke overtypes a prior choice.
  input.addEventListener("focus", () => { open(); input.select(); });
  input.addEventListener("click", open);
  input.addEventListener("input", () => { hi = -1; render(input.value); list.hidden = false; });
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
document.addEventListener("reset", () => requestAnimationFrame(syncCombos), true);

// ---- caches + labels ----
const sitesById = {}, tournamentsById = {}, officialsById = {}, playersById = {}, hotelsById = {};
const officialLabel = (o) => `${o.last_name}, ${o.first_name}`;
const siteLabel = (s) => (s.code ? s.code + " — " : "") + s.name;
const playerLabel = (p) => `${[p.last_name, p.first_name].filter(Boolean).join(", ") || "?"} (${p.usta_number})`;

// Certifications (value -> label) and a date formatter that appends the weekday.
const CERTS = [
  ["roving_official", "Roving official"],
  ["chair_umpire", "Chair umpire"],
  ["tournament_referee", "Tournament referee"],
  ["deputy_referee", "Deputy referee"],
  ["referee_in_training", "Referee in training"],
];
const CERT_LABEL = Object.fromEntries(CERTS);
const certLabel = (v) => CERT_LABEL[v] || v;
function fmtDOW(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return iso + " (" + d.toLocaleDateString("en-US", { weekday: "short" }) + ")";
}

function refreshAllSelects() {
  fillSelect(document.getElementById("dist-official"), Object.values(officialsById), officialLabel, false);
  fillSelect(document.getElementById("dist-site"), Object.values(sitesById), siteLabel, false);
  fillSelect(document.getElementById("roster-player"), Object.values(playersById), playerLabel, false);
  fillSelect(document.getElementById("asg-official"), Object.values(officialsById), officialLabel, false);
  // asg-site is filled per-tournament in loadAssignments() (mileage site must be
  // one of THIS tournament's sites), so it is intentionally not filled here.
  fillSelect(document.getElementById("trb-hotel"), Object.values(hotelsById), (h) => h.name, false);
  fillPlayerRefs();
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
  const p = id ? playersById[id] : null;
  if (p) { b.usta_number = p.usta_number; b.first_name = p.first_name || null; b.last_name = p.last_name || null; }
  return b;
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
  b.textContent = g.querySelector(".menu-label").textContent;
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
_menuEl.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t === tab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  const grpEl = tab.closest(".menu-group");
  if (grpEl) _markGroup(grpEl.dataset.group);  // keep level-1 in sync (e.g. file-from-email jumps)
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === tab.dataset.target));
  // Refresh tournament-scoped panels on open so they always reflect current data.
  const loaders = {
    "panel-t-sites": () => loadTSites(),
    "panel-t-roster": () => loadRoster(),
    "panel-t-assignments": () => loadAssignments(),
    "panel-t-roomblocks": () => loadRoomBlocks(),
    "panel-t-availability": () => loadAvailability(),
    "panel-t-inbox": () => loadInbox(),
    "panel-t-late": () => loadLate(),
    "panel-t-withdrawals": () => loadWithdrawals(),
    "panel-t-sched": () => schedList.load(),
    "panel-t-divflex": () => divflexList.load(),
    "panel-t-pairing": () => loadPairing(),
    "panel-t-doubles": () => loadDoubles(),
    "panel-t-photels": () => photelList.load(),
    "panel-t-reports": () => loadReports(),
  };
  if (active && loaders[tab.dataset.target]) loaders[tab.dataset.target]();
  if (tab.dataset.target === "panel-tshirts") loadTshirts();  // Setup tab (no active needed)
  sizeLists();
});

// Bound every scrollable list to the real space left below it so it never runs
// off the bottom of the screen, whatever the toolbar height happens to be.
function sizeLists() {
  const ls = document.querySelector(".panel.active .list-scroll");
  const top = ls ? ls.getBoundingClientRect().top : 160;
  const max = Math.max(140, window.innerHeight - top - 16);
  document.documentElement.style.setProperty("--list-max", max + "px");
}
window.addEventListener("resize", sizeLists);
window.addEventListener("load", sizeLists);
requestAnimationFrame(sizeLists);

// =================== Active tournament state ===================
let active = null;
let lastSelectedTournamentId = null;
const activeSelect = document.getElementById("active-tournament");

function fillActiveSelect(rows) {
  const cur = activeSelect.value;
  activeSelect.innerHTML = '<option value="">— select a tournament —</option>';
  for (const t of rows) {
    const o = document.createElement("option");
    o.value = t.id; o.textContent = t.name;
    activeSelect.appendChild(o);
  }
  activeSelect.value = cur;
}

function setActive(id) {
  active = id ? tournamentsById[id] || null : null;
  activeSelect.value = active ? String(active.id) : "";
  if (active) localStorage.setItem("activeTid", active.id);
  else localStorage.removeItem("activeTid");
  syncCombos();
  updateActiveUI();
}

function updateActiveUI() {
  const info = document.getElementById("active-info");
  document.getElementById("context-bar").classList.toggle("has-active", !!active);
  document.querySelectorAll(".needs-active").forEach((t) => t.classList.toggle("disabled", !active));
  document.querySelectorAll(".t-name").forEach((s) => (s.textContent = active ? active.name : ""));
  document.querySelectorAll(".tpanel").forEach((p) => {
    p.querySelector(".needs-active-note").hidden = !!active;
    p.querySelector(".t-content").hidden = !active;
  });
  if (active) {
    info.textContent = `${active.type} · ${active.play_start_date} → ${active.play_end_date}`;
    loadTSites(); loadRoster(); loadAssignments(); loadRoomBlocks(); loadAvailability(); loadInbox(); loadLate(); loadWithdrawals(); schedList.load(); divflexList.load(); loadPairing(); loadDoubles(); photelList.load(); loadReports();
  } else {
    info.textContent = "";
  }
}
activeSelect.addEventListener("change", () => setActive(activeSelect.value));

// =================== generic master-detail CRUD (Setup) ===================
function wireEntity(cfg) {
  const panel = document.getElementById(cfg.panelId);
  const form = document.getElementById(cfg.formId);
  const tbody = panel.querySelector(".list-table tbody");
  const filterInput = panel.querySelector(".filter");
  const newBtn = panel.querySelector(".new-btn");
  const title = panel.querySelector(".detail-title");
  const detailPane = panel.querySelector(".detail-pane");
  const submitBtn = form.querySelector('button[type="submit"]');
  const deleteBtn = form.querySelector(".delete");
  const cancelBtn = form.querySelector(".cancel");
  let items = [];
  let selectedId = null;

  // prev/next record navigation (so a long list needn't be scrolled to switch records)
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
  function shownList() { return items.filter(matchesFilter); }
  function updateNav() {
    const shown = shownList();
    const idx = shown.findIndex((it) => it.id === selectedId);
    const have = selectedId != null && idx >= 0;
    navPos.textContent = shown.length ? `${have ? idx + 1 : "–"} / ${shown.length}` : "";
    prevBtn.disabled = !have || idx <= 0;
    nextBtn.disabled = !have || idx >= shown.length - 1;
  }
  function navTo(delta) {
    const shown = shownList();
    const idx = shown.findIndex((it) => it.id === selectedId);
    if (idx < 0) return;
    const target = shown[idx + delta];
    if (!target) return;
    select(target);
    const row = tbody.querySelector("tr.selected");
    if (row) row.scrollIntoView({ block: "nearest" });
  }
  prevBtn.addEventListener("click", () => navTo(-1));
  nextBtn.addEventListener("click", () => navTo(1));

  function fillForm(item) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = item ? item[el.name] : null;
      el.value = v === null || v === undefined ? "" : v;
    }
    requestAnimationFrame(syncCombos);  // refresh type-in dropdown displays
  }
  function showNew() {
    selectedId = null; fillForm(null);
    title.textContent = "New " + cfg.singular;
    submitBtn.textContent = "Create";
    deleteBtn.hidden = true;
    renderList();
    if (cfg.onNew) cfg.onNew();
  }
  function select(item) {
    selectedId = item.id; fillForm(item);
    title.textContent = `${cfg.singular} #${item.id}`;
    submitBtn.textContent = "Save";
    deleteBtn.hidden = false;
    renderList();
    if (cfg.onSelect) cfg.onSelect(item);
  }
  function matchesFilter(item) {
    const q = filterInput.value.trim().toLowerCase();
    if (!q) return true;
    return cfg.columns.map((c) => (c.fmt ? c.fmt(item) : item[c.key])).concat(Object.values(item)).join(" ").toLowerCase().includes(q);
  }
  function renderList() {
    const shown = items.filter(matchesFilter);
    tbody.innerHTML = "";
    for (const item of shown) {
      const tr = document.createElement("tr");
      tr.className = item.id === selectedId ? "selected" : "";
      tr.innerHTML = cfg.columns.map((c) => `<td>${esc(c.fmt ? c.fmt(item) : item[c.key])}</td>`).join("") + '<td class="actions"></td>';
      tr.addEventListener("click", () => select(item));
      const cell = tr.querySelector(".actions");
      if (cfg.rowAction) {
        const extra = cfg.rowAction(item);  // optional per-row button (e.g. "Work on →")
        if (extra) cell.append(extra);
      }
      const e = document.createElement("button"); e.type = "button"; e.className = "btn-link"; e.textContent = "Edit";
      e.addEventListener("click", (ev) => { ev.stopPropagation(); select(item); });
      const d = document.createElement("button"); d.type = "button"; d.className = "btn-link danger"; d.textContent = "Delete";
      d.addEventListener("click", (ev) => { ev.stopPropagation(); removeItem(item.id); });
      cell.append(e, d);
      tbody.appendChild(tr);
    }
    const span = cfg.columns.length + 1;
    if (items.length === 0) tbody.innerHTML = `<tr><td class="empty" colspan="${span}">No ${cfg.singular}s yet — use the form to add one.</td></tr>`;
    else if (shown.length === 0) tbody.innerHTML = `<tr><td class="empty" colspan="${span}">No matches</td></tr>`;
    updateNav();
  }
  async function removeItem(id) {
    if (!(await confirmDialog(`Delete ${cfg.singular} #${id}?`))) return;
    try {
      await api(`${cfg.path}/${id}`, { method: "DELETE" });
      setMsg(cfg.msgId, "deleted", true);
      if (selectedId === id) showNew();
      await refresh();
      if (cfg.afterChange) cfg.afterChange();
    } catch (err) { setMsg(cfg.msgId, err.message, false); }
  }
  async function refresh() {
    items = await api(cfg.path);
    if (cfg.onLoad) cfg.onLoad(items);
    renderList();
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      let body = formObj(form);
      if (cfg.transform) body = cfg.transform(body);
      const editing = selectedId != null;
      const saved = await api(editing ? `${cfg.path}/${selectedId}` : cfg.path, { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      if (saved && saved.id != null) selectedId = saved.id;
      setMsg(cfg.msgId, editing ? "saved" : "created", true);
      await refresh();
      if (cfg.afterChange) cfg.afterChange();
      if (saved && saved.id != null) select(saved);
    } catch (err) { setMsg(cfg.msgId, err.message, false); }
    finally { submitBtn.disabled = false; }
  });
  deleteBtn.addEventListener("click", () => { if (selectedId != null) removeItem(selectedId); });
  newBtn.addEventListener("click", showNew);
  cancelBtn.addEventListener("click", showNew);
  filterInput.addEventListener("input", renderList);
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
function renderTSites() {
  const tbody = document.querySelector("#t-sites-table tbody");
  const q = document.getElementById("t-sites-filter").value.trim().toLowerCase();
  const rows = Object.values(sitesById).filter((s) => !q || siteLabel(s).toLowerCase().includes(q) || (s.city || "").toLowerCase().includes(q));
  tbody.innerHTML = "";
  for (const s of rows) {
    const inSet = tSitesSelected.has(s.id);
    const tr = document.createElement("tr");
    if (inSet) tr.className = "selected";
    tr.innerHTML = `<td class="toggle"></td><td>${esc(s.code)}</td><td>${esc(s.name)}</td><td>${esc(s.city)}</td>`;
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn-link" + (inSet ? "" : " add");
    btn.textContent = inSet ? "✓ In" : "Add";
    btn.addEventListener("click", () => toggleSite(s.id));
    tr.querySelector(".toggle").appendChild(btn);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="4">No matches</td></tr>';
}
async function toggleSite(id) {
  if (tSitesSelected.has(id)) tSitesSelected.delete(id); else tSitesSelected.add(id);
  try {
    await api(`/tournaments/${active.id}/sites`, { method: "PUT", body: JSON.stringify({ site_ids: [...tSitesSelected] }) });
    setMsg("t-sites-msg", "saved", true);
    renderTSites();
  } catch (e) { setMsg("t-sites-msg", e.message, false); loadTSites(); }
}
document.getElementById("t-sites-filter").addEventListener("input", renderTSites);

// --- Roster (master/detail, like the Setup entities) ---
const rosterForm = document.getElementById("roster-form");
const rosterTitle = document.getElementById("roster-title");
const rosterSubmit = rosterForm.querySelector('button[type="submit"]');
let rosterRows = [];
let rosterEditId = null;
async function loadRoster() {
  if (!active) return;
  rosterRows = await api(`/tournaments/${active.id}/players`);
  renderRoster();
}
const rosterName = (e) => [e.last_name, e.first_name].filter(Boolean).join(", ") || e.usta_number;
function rosterShown() {
  const q = document.getElementById("roster-filter").value.trim().toLowerCase();
  return rosterRows.filter((e) => !q || JSON.stringify(e).toLowerCase().includes(q));
}
function rosterSelect(e) {
  rosterEditId = e.id;
  rosterForm.player_id.value = e.player_id;
  rosterForm.age_division.value = e.age_division || "";
  rosterForm.events.value = e.events || "";
  rosterForm.selection_status.value = e.selection_status;
  rosterForm.t_shirt_size.value = e.t_shirt_size || "";
  rosterForm.dietary_preference.value = e.dietary_preference || "";
  rosterTitle.textContent = "Edit: " + rosterName(e);
  rosterSubmit.textContent = "Update player";
  if (typeof syncCombos === "function") syncCombos();
  renderRoster();
}
function rosterShowNew() {
  rosterEditId = null; rosterForm.reset();
  rosterTitle.textContent = "New roster entry";
  rosterSubmit.textContent = "Add player";
  if (typeof syncCombos === "function") syncCombos();
  renderRoster();
}
function renderRoster() {
  const tbody = document.querySelector("#roster-table tbody");
  const shown = rosterShown();
  tbody.innerHTML = "";
  for (const e of shown) {
    const tr = document.createElement("tr");
    tr.className = e.id === rosterEditId ? "selected" : "";
    tr.innerHTML = `<td>${esc(rosterName(e))} <span class="muted">(${esc(e.usta_number)})</span></td>` +
      `<td>${esc(e.age_division)}</td><td>${chip(e.selection_status)}</td><td>${esc(e.t_shirt_size)}</td><td>${esc(e.dietary_preference)}</td><td class="actions"></td>`;
    tr.addEventListener("click", () => rosterSelect(e));
    const cell = tr.querySelector(".actions");
    const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
    ed.addEventListener("click", (ev) => { ev.stopPropagation(); rosterSelect(e); });
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn-link danger"; dl.textContent = "Delete";
    dl.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!(await confirmDialog("Remove player from roster?"))) return;
      try { await api(`/roster/${e.id}`, { method: "DELETE" }); if (rosterEditId === e.id) rosterShowNew(); await loadRoster(); }
      catch (err) { setMsg("roster-msg", err.message, false); }
    });
    cell.append(ed, dl);
    tbody.appendChild(tr);
  }
  if (rosterRows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="6">No players on this roster yet.</td></tr>';
  else if (shown.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="6">No matches</td></tr>';
  rosterUpdateNav();
}
// Prev/Next record navigation (parity with the Setup master/detail forms).
const rosterNav = document.createElement("div"); rosterNav.className = "detail-nav";
const rosterPrev = document.createElement("button"); rosterPrev.type = "button"; rosterPrev.className = "nav-btn"; rosterPrev.textContent = "‹ Prev";
const rosterNext = document.createElement("button"); rosterNext.type = "button"; rosterNext.className = "nav-btn"; rosterNext.textContent = "Next ›";
const rosterPos = document.createElement("span"); rosterPos.className = "nav-pos";
rosterNav.append(rosterPrev, rosterPos, rosterNext);
rosterTitle.parentNode.insertBefore(rosterNav, rosterTitle);
function rosterUpdateNav() {
  const shown = rosterShown();
  const idx = shown.findIndex((e) => e.id === rosterEditId);
  const have = rosterEditId != null && idx >= 0;
  rosterPos.textContent = shown.length ? `${have ? idx + 1 : "–"} / ${shown.length}` : "";
  rosterPrev.disabled = !have || idx <= 0;
  rosterNext.disabled = !have || idx >= shown.length - 1;
}
function rosterNavTo(delta) {
  const shown = rosterShown();
  const idx = shown.findIndex((e) => e.id === rosterEditId);
  if (idx < 0) return;
  const t = shown[idx + delta];
  if (!t) return;
  rosterSelect(t);
  const r = document.querySelector("#roster-table tr.selected");
  if (r) r.scrollIntoView({ block: "nearest" });
}
rosterPrev.addEventListener("click", () => rosterNavTo(-1));
rosterNext.addEventListener("click", () => rosterNavTo(1));
onSubmit(rosterForm, async () => {
  const b = formObj(rosterForm); b.player_id = Number(b.player_id);
  try {
    const editing = rosterEditId != null;
    const saved = editing
      ? await api(`/roster/${rosterEditId}`, { method: "PUT", body: JSON.stringify(b) })
      : await api(`/tournaments/${active.id}/players`, { method: "POST", body: JSON.stringify(b) });
    setMsg("roster-msg", editing ? "saved" : "added", true);
    await loadRoster();
    const row = saved && saved.id != null && rosterRows.find((r) => r.id === saved.id);
    if (row) rosterSelect(row); else rosterShowNew();
  } catch (err) { setMsg("roster-msg", err.message, false); }
});
rosterForm.querySelector(".cancel").addEventListener("click", rosterShowNew);
document.getElementById("roster-new").addEventListener("click", rosterShowNew);
document.getElementById("roster-filter").addEventListener("input", renderRoster);
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
document.getElementById("roster-import").addEventListener("click", async () => {
  if (!active) return;
  const f = document.getElementById("roster-file").files[0];
  if (!f) { setMsg("roster-import-msg", "choose a CSV/XLSX file", false); return; }
  const fd = new FormData();
  fd.append("file", f);
  try {
    const res = await fetch(`/api/tournaments/${active.id}/players/import`, { method: "POST", body: fd });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || res.statusText);
    const errs = body.errors && body.errors.length ? `, ${body.errors.length} row error(s)` : "";
    setMsg("roster-import-msg", `imported ${body.entries} (new ${body.created_players}, updated ${body.updated_players})${errs}`, true);
    document.getElementById("roster-file").value = "";
    loadRoster();
  } catch (e) { setMsg("roster-import-msg", e.message, false); }
});

// --- Assignments ---
const asgForm = document.getElementById("asg-form");
let asgEditId = null;
// True when a work date falls outside the active tournament's play window.
function _outOfWindow(d) {
  return !!(active && d && (d < active.play_start_date || d > active.play_end_date));
}
async function loadAssignments() {
  if (!active) return;
  // Mileage site must be one of THIS tournament's sites (audit §3 — not any site).
  const tSites = await api(`/tournaments/${active.id}/sites`);
  fillSelect(document.getElementById("asg-site"), tSites, siteLabel);
  const rbList = await api(`/room-blocks?tournament_id=${active.id}&kind=official`);
  fillSelect(document.getElementById("asg-room-block"), rbList, (b) => {
    const hn = hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : "hotel " + b.hotel_id;
    return `${hn} (${b.rooms_remaining}/${b.room_count} left)`;
  });
  const list = await api(`/tournaments/${active.id}/assignments`);
  const avail = await api(`/tournaments/${active.id}/availability`);
  const availByOfficial = {};
  for (const r of avail) (availByOfficial[r.official_id] ||= []).push(r.available_date);
  // Surface availability in the official picker for this tournament.
  fillSelect(document.getElementById("asg-official"), Object.values(officialsById), (o) => {
    const n = (availByOfficial[o.id] || []).length;
    return `${officialLabel(o)} — ${n ? n + " avail day(s)" : "no availability"}`;
  }, false);
  const box = document.getElementById("asg-list");
  box.innerHTML = "";
  if (list.length === 0) { box.innerHTML = '<p class="muted">No officials assigned yet.</p>'; return; }
  for (const a of list) box.appendChild(renderAssignment(a, (availByOfficial[a.official_id] || []).sort()));
}
function renderAssignment(a, availDates) {
  const card = document.createElement("div");
  card.className = "asg";
  // Structured header: name + actions on top; venue/hotel meta line; then
  // pay/mileage/total badges and any flags as colored chips (no run-on line).
  const mileage = a.missing_distance ? '<span class="warn">no distance</span>'
    : (a.mileage == null ? "—" : "$" + a.mileage.toFixed(2));
  const flagChips = [
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
  e.preventDefault();
  const b = formObj(asgForm);
  b.official_id = Number(b.official_id);
  b.site_id = b.site_id ? Number(b.site_id) : null;
  b.room_block_id = b.room_block_id ? Number(b.room_block_id) : null;
  try {
    if (asgEditId) await api(`/assignments/${asgEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/tournaments/${active.id}/assignments`, { method: "POST", body: JSON.stringify(b) });
    setMsg("asg-msg", asgEditId ? "saved" : "added", true); asgReset(); loadAssignments();
  } catch (err) { setMsg("asg-msg", err.message, false); }
});
asgForm.querySelector(".cancel").addEventListener("click", asgReset);

// --- Room blocks (tournament-scoped) ---
const trbForm = document.getElementById("trb-form");
let trbEditId = null;
async function loadRoomBlocks() {
  if (!active) return;
  const rows = await api(`/room-blocks?tournament_id=${active.id}`);
  const tbody = document.querySelector("#trb-table tbody");
  tbody.innerHTML = "";
  for (const b of rows) {
    const tr = document.createElement("tr");
    const kindLbl = b.kind === "official" ? "Officials comp" : "Player rate";
    tr.innerHTML = `<td>${b.id}</td><td>${esc(hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : b.hotel_id)}</td>` +
      `<td>${kindLbl}</td><td>${b.room_count}</td><td>${b.rooms_remaining}</td><td>${esc(b.check_in)}</td><td>${esc(b.check_out)}</td><td class="actions"></td>`;
    const cell = tr.querySelector(".actions");
    const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
    ed.addEventListener("click", () => {
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
    });
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn-link danger"; dl.textContent = "Delete";
    dl.addEventListener("click", async () => { if (!(await confirmDialog("Delete room block?"))) return; try { await api(`/room-blocks/${b.id}`, { method: "DELETE" }); loadRoomBlocks(); } catch (e) { setMsg("trb-msg", e.message, false); } });
    cell.append(ed, dl);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="8">No room blocks for this tournament yet.</td></tr>';
}
function trbReset() { trbEditId = null; trbForm.reset(); trbForm.querySelector('button[type="submit"]').textContent = "Add block"; }
onSubmit(trbForm, async (e) => {
  e.preventDefault();
  const b = formObj(trbForm);
  b.hotel_id = Number(b.hotel_id);
  b.tournament_id = active.id;
  b.room_count = b.room_count == null ? 0 : Number(b.room_count);
  try {
    if (trbEditId) await api(`/room-blocks/${trbEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/room-blocks`, { method: "POST", body: JSON.stringify(b) });
    setMsg("trb-msg", trbEditId ? "saved" : "added", true); trbReset(); loadRoomBlocks();
  } catch (err) { setMsg("trb-msg", err.message, false); }
});
trbForm.querySelector(".cancel").addEventListener("click", trbReset);

// --- Availability (per official, per tournament) ---
let availAll = [];
function _datesInRange(start, end) {
  const out = []; const d = new Date(start + "T00:00:00"); const e = new Date(end + "T00:00:00");
  while (d <= e) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
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
function renderAvailTable() {
  const tbody = document.querySelector("#avail-table tbody");
  const byOff = {};
  for (const r of availAll) {
    (byOff[r.official_name] ||= { dates: [], hotel: false });
    byOff[r.official_name].dates.push(r.available_date);
    if (r.hotel_needed) byOff[r.official_name].hotel = true;
  }
  const names = Object.keys(byOff).sort();
  tbody.innerHTML = names.length
    ? names.map((n) => `<tr><td>${esc(n)}</td><td>${esc(byOff[n].dates.sort().map(fmtDOW).join(", "))}</td><td>${byOff[n].hotel ? "yes" : ""}</td></tr>`).join("")
    : '<tr><td class="empty" colspan="3">No availability recorded yet.</td></tr>';
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
  fillSelect(document.getElementById("avail-official"), Object.values(officialsById), officialLabel, false);
  availAll = await api(`/tournaments/${active.id}/availability`);
  renderAvailDates();
  renderAvailTable();
  renderAvailCerts(Number(document.getElementById("avail-official").value) || null);
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
const lateForm = document.getElementById("late-form");
const wdForm = document.getElementById("withdrawal-form");
const FILE_TARGETS = {
  late_entry: { label: "Late entry", tab: "panel-t-late", form: lateForm, msg: "late-msg" },
  withdrawal: { label: "Withdrawal", tab: "panel-t-withdrawals", form: wdForm, msg: "withdrawal-msg" },
  scheduling_avoidance: { label: "Scheduling avoid.", tab: "panel-t-sched", form: document.getElementById("sched-form"), msg: "sched-msg" },
  division_flex: { label: "Division flex", tab: "panel-t-divflex", form: document.getElementById("divflex-form"), msg: "divflex-msg" },
  hotel: { label: "Player hotel", tab: "panel-t-photels", form: document.getElementById("photel-form"), msg: "photel-msg" },
  pairing_avoidance: { label: "Pairing avoid.", tab: "panel-t-pairing", form: document.getElementById("pairing-form"), msg: "pairing-msg" },
  doubles: { label: "Doubles", tab: "panel-t-doubles", form: document.getElementById("doubles-form"), msg: "doubles-msg" },
};

async function loadInbox() {
  if (!active) return;
  const rows = await api(`/emails?tournament_id=${active.id}`);
  const tbody = document.querySelector("#inbox-table tbody");
  tbody.innerHTML = "";
  for (const m of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc((m.received_at || "").slice(0, 10))}</td><td>${esc(m.from_address)}</td>` +
      `<td>${esc(m.subject)}</td><td class="cls"></td><td>${chip(m.status)}</td><td class="actions"></td>`;
    const sel = document.createElement("select");
    EMAIL_CLASSES.forEach((c) => { const o = document.createElement("option"); o.value = c; o.textContent = c; sel.appendChild(o); });
    sel.value = m.classification || "unclassified";
    sel.addEventListener("change", async () => {
      try { await api(`/emails/${m.id}`, { method: "PUT", body: JSON.stringify({ tournament_id: active.id, classification: sel.value, status: m.status }) }); }
      catch (e) { setMsg("email-msg", e.message, false); }
    });
    tr.querySelector(".cls").appendChild(sel);
    const cell = tr.querySelector(".actions");
    // File into a list: pick a target (defaults to the classification if fileable).
    const tgt = document.createElement("select");
    for (const k of Object.keys(FILE_TARGETS)) { const o = document.createElement("option"); o.value = k; o.textContent = FILE_TARGETS[k].label; tgt.appendChild(o); }
    if (FILE_TARGETS[m.classification]) tgt.value = m.classification;
    const fileBtn = document.createElement("button"); fileBtn.type = "button"; fileBtn.className = "btn-link"; fileBtn.textContent = "File →";
    fileBtn.addEventListener("click", () => {
      const t = FILE_TARGETS[tgt.value];
      t.form.source_email_id.value = m.id;
      document.querySelector(`.tab[data-target="${t.tab}"]`).click();
      openForm(t.form);
      setMsg(t.msg, `filing from email #${m.id}`, true);
      const focusEl = t.form.querySelector(".combo-input") || t.form.querySelector("input, select");
      if (focusEl) focusEl.focus();
    });
    const sgBtn = document.createElement("button"); sgBtn.type = "button"; sgBtn.className = "btn-link"; sgBtn.textContent = "Suggest";
    sgBtn.addEventListener("click", async () => {
      try {
        const res = await api(`/emails/${m.id}/suggest`, { method: "POST" });
        sel.value = res.classification;
        if (FILE_TARGETS[res.classification]) tgt.value = res.classification;
        await api(`/emails/${m.id}`, { method: "PUT", body: JSON.stringify({ tournament_id: active.id, classification: res.classification, status: m.status }) });
        setMsg("email-msg", `suggested: ${res.classification}`, true);
      } catch (e) { setMsg("email-msg", e.message, false); }
    });
    cell.append(sgBtn, tgt, fileBtn);
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => { if (!(await confirmDialog("Delete email?"))) return; try { await api(`/emails/${m.id}`, { method: "DELETE" }); loadInbox(); } catch (e) { setMsg("email-msg", e.message, false); } });
    cell.append(del);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="6">Inbox empty — add a forwarded email above.</td></tr>';
}
onSubmit(document.getElementById("email-form"), async (e) => {
  e.preventDefault(); if (!active) return;
  const b = formObj(e.target); b.tournament_id = active.id;
  try { await api("/emails", { method: "POST", body: JSON.stringify(b) }); setMsg("email-msg", "added", true); e.target.reset(); loadInbox(); }
  catch (err) { setMsg("email-msg", err.message, false); }
});

async function loadLate() {
  if (!active) return;
  const rows = await api(`/tournaments/${active.id}/late-entries`);
  const tbody = document.querySelector("#late-table tbody");
  tbody.innerHTML = "";
  for (const e of rows) {
    const tr = document.createElement("tr");
    const nm = [e.last_name, e.first_name].filter(Boolean).join(", ");
    const lateFlag = e.past_deadline ? ' <span class="warn" title="After the late-entry deadline">⚠ past deadline</span>' : "";
    tr.innerHTML = `<td>${esc(e.request_date)}${lateFlag}</td><td>${esc(e.request_time)}</td><td>${esc(nm)}</td>` +
      `<td>${esc(e.usta_number)}</td><td>${esc(e.age_division)}</td><td>${esc(e.events)}</td><td class="actions"></td>`;
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => { if (!(await confirmDialog("Delete late entry?"))) return; try { await api(`/late-entries/${e.id}`, { method: "DELETE" }); loadLate(); } catch (err) { setMsg("late-msg", err.message, false); } });
    tr.querySelector(".actions").appendChild(del);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="7">No late entries yet.</td></tr>';
}
function lateReset() { lateForm.reset(); lateForm.source_email_id.value = ""; }
onSubmit(lateForm, async (e) => {
  e.preventDefault(); if (!active) return;
  const b = expandPlayerRef(formObj(lateForm));
  b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
  try {
    await api(`/tournaments/${active.id}/late-entries`, { method: "POST", body: JSON.stringify(b) });
    setMsg("late-msg", "added", true); lateReset(); loadLate(); loadInbox();
  } catch (err) { setMsg("late-msg", err.message, false); }
});
lateForm.querySelector(".cancel").addEventListener("click", lateReset);

async function loadWithdrawals() {
  if (!active) return;
  const rows = await api(`/tournaments/${active.id}/withdrawals`);
  const tbody = document.querySelector("#withdrawal-table tbody");
  tbody.innerHTML = "";
  for (const w of rows) {
    const tr = document.createElement("tr");
    const nm = [w.last_name, w.first_name].filter(Boolean).join(", ");
    tr.innerHTML = `<td>${esc(nm)}</td><td>${esc(w.usta_number)}</td><td>${esc(w.age_division)}</td>` +
      `<td>${esc(w.events)}</td><td>${w.was_alternate ? "yes" : ""}</td><td>${esc(w.reason)}</td>` +
      `<td>${esc(w.notes)}</td><td class="actions"></td>`;
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => { if (!(await confirmDialog("Delete withdrawal?"))) return; try { await api(`/withdrawals/${w.id}`, { method: "DELETE" }); loadWithdrawals(); loadRoster(); } catch (e) { setMsg("withdrawal-msg", e.message, false); } });
    tr.querySelector(".actions").appendChild(del);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="8">No withdrawals yet.</td></tr>';
}
function wdReset() { wdForm.reset(); wdForm.source_email_id.value = ""; }
onSubmit(wdForm, async (e) => {
  e.preventDefault(); if (!active) return;
  const b = expandPlayerRef(formObj(wdForm));
  b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
  try {
    await api(`/tournaments/${active.id}/withdrawals`, { method: "POST", body: JSON.stringify(b) });
    setMsg("withdrawal-msg", "added", true); wdReset(); loadWithdrawals(); loadRoster(); loadInbox();
  } catch (err) { setMsg("withdrawal-msg", err.message, false); }
});
wdForm.querySelector(".cancel").addEventListener("click", wdReset);

// Generic player-keyed Part B list (form + table + delete + file-from-email).
function wirePlayerList(cfg) {
  const form = document.getElementById(cfg.formId);
  async function load() {
    if (!active) return;
    const rows = await api(`/tournaments/${active.id}${cfg.path}`);
    const tbody = document.querySelector(`#${cfg.tableId} tbody`);
    tbody.innerHTML = "";
    for (const r of rows) {
      const nm = [r.last_name, r.first_name].filter(Boolean).join(", ");
      const tr = document.createElement("tr");
      tr.innerHTML = cfg.cells(r, nm) + '<td class="actions"></td>';
      const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
      del.addEventListener("click", async () => { if (!(await confirmDialog("Delete?"))) return; try { await api(`${cfg.del}/${r.id}`, { method: "DELETE" }); load(); } catch (e) { setMsg(cfg.msgId, e.message, false); } });
      tr.querySelector(".actions").appendChild(del);
      tbody.appendChild(tr);
    }
    if (rows.length === 0) tbody.innerHTML = `<tr><td class="empty" colspan="${cfg.cols}">${cfg.empty}</td></tr>`;
    if (cfg.after) cfg.after();
  }
  function reset() { form.reset(); form.source_email_id.value = ""; }
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); if (!active) return;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    const b = expandPlayerRef(formObj(form)); b.source_email_id = b.source_email_id ? Number(b.source_email_id) : null;
    try { await api(`/tournaments/${active.id}${cfg.path}`, { method: "POST", body: JSON.stringify(b) }); setMsg(cfg.msgId, "added", true); reset(); load(); loadInbox(); }
    catch (err) { setMsg(cfg.msgId, err.message, false); }
    finally { btn.disabled = false; }
  });
  form.querySelector(".cancel").addEventListener("click", reset);
  return { load };
}
const schedList = wirePlayerList({
  formId: "sched-form", msgId: "sched-msg", tableId: "sched-table",
  path: "/scheduling-avoidances", del: "/scheduling-avoidances", cols: 5,
  empty: "No scheduling avoidances yet.",
  cells: (r, nm) => `<td>${esc(nm)}</td><td>${esc(r.usta_number)}</td><td>${esc(r.avoid_day)}</td><td>${esc(r.avoid_time_range)}</td>`,
});
const divflexList = wirePlayerList({
  formId: "divflex-form", msgId: "divflex-msg", tableId: "divflex-table",
  path: "/division-flex", del: "/division-flex", cols: 5,
  empty: "No division-flexibility entries yet.",
  cells: (r, nm) => `<td>${esc(nm)}</td><td>${esc(r.usta_number)}</td><td>${esc(r.home_division)}</td><td>${esc(r.willing_divisions)}</td>`,
});

async function loadCvb() {
  const tbody = document.querySelector("#cvb-table tbody");
  try {
    const rows = await api("/hotel-analytics");
    tbody.innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${esc(r.hotel_name)}</td><td>${r.stays}</td></tr>`).join("")
      : '<tr><td class="empty" colspan="2">No player hotel data yet.</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td class="empty" colspan="2">${esc(e.message)}</td></tr>`; }
}
// Per-tournament hotel summary: players per hotel (selected only, alphabetical).
async function loadHotelSummary() {
  if (!active) return;
  const tbody = document.querySelector("#hotel-summary-table tbody");
  try {
    const rows = await api(`/tournaments/${active.id}/hotel-summary`);
    tbody.innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${esc(r.hotel_name)}</td><td>${r.players}</td></tr>`).join("")
      : '<tr><td class="empty" colspan="2">No hotels entered for selected players yet.</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td class="empty" colspan="2">${esc(e.message)}</td></tr>`; }
}
// Per-tournament lodging-plan summary: players per plan (Hotel/Commuter/…).
async function loadLodgingSummary() {
  if (!active) return;
  const tbody = document.querySelector("#lodging-summary-table tbody");
  try {
    const rows = await api(`/tournaments/${active.id}/lodging-summary`);
    tbody.innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${esc(r.lodging_plan)}</td><td>${r.players}</td></tr>`).join("")
      : '<tr><td class="empty" colspan="2">No lodging plans entered for selected players yet.</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td class="empty" colspan="2">${esc(e.message)}</td></tr>`; }
}
const photelList = wirePlayerList({
  formId: "photel-form", msgId: "photel-msg", tableId: "photel-table",
  path: "/player-hotels", del: "/player-hotels", cols: 5,
  empty: "No player hotels reported yet.",
  cells: (r, nm) => `<td>${esc(nm)}</td><td>${esc(r.usta_number)}</td><td>${esc(r.hotel_name)}</td><td>${esc(r.lodging_plan)}</td>`,
  after: () => { loadCvb(); loadHotelSummary(); loadLodgingSummary(); },
});

// --- T-shirts (Setup: cumulative cross-tournament list) ---
let tshirtRows = [];
// Canonical size codes smallest→largest, and code→label for display.
const _SHIRT_CODES = ["YS", "YM", "YL", "AS", "AM", "AL", "AXL"];
const _SHIRT_LABEL = {
  YS: "Youth Small", YM: "Youth Medium", YL: "Youth Large",
  AS: "Adult Small", AM: "Adult Medium", AL: "Adult Large", AXL: "Adult Extra Large",
};
const _SIZE_TOKEN = { s: "S", sm: "S", small: "S", m: "M", med: "M", medium: "M",
  l: "L", lg: "L", large: "L", xl: "XL", xlarge: "XL", extralarge: "XL", xxl: "XL", xxxl: "XL" };
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
function renderTshirts() {
  renderTshirtSummary();
  const q = document.getElementById("tshirt-filter").value.trim().toLowerCase();
  const rows = tshirtRows.filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q));
  const tbody = document.querySelector("#tshirt-table tbody");
  tbody.innerHTML = rows.length
    ? rows.map((r) => `<tr><td>${esc([r.last_name, r.first_name].filter(Boolean).join(", "))}</td>` +
        `<td>${esc(r.usta_number)}</td><td>${esc(r.age_division)}</td><td>${esc(r.tournament_name)}</td><td>${esc(r.t_shirt_size)}</td></tr>`).join("")
    : '<tr><td class="empty" colspan="5">No t-shirt sizes recorded yet.</td></tr>';
}
async function loadTshirts() { tshirtRows = await api("/tshirts"); renderTshirts(); }
document.getElementById("tshirt-filter").addEventListener("input", renderTshirts);

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
async function loadPairing() {
  if (!active) return;
  const rows = await api(`/tournaments/${active.id}/pairing-avoidances`);
  const tbody = document.querySelector("#pairing-table tbody");
  tbody.innerHTML = "";
  for (const g of rows) {
    const names = g.members.map((m) => [m.last_name, m.first_name].filter(Boolean).join(", ") || m.usta_number).join(" & ");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(g.age_division)}</td><td>${esc(g.relationship)}</td><td>${esc(names)}</td><td class="actions"></td>`;
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => { if (!(await confirmDialog("Delete group?"))) return; try { await api(`/pairing-avoidances/${g.id}`, { method: "DELETE" }); loadPairing(); } catch (e) { setMsg("pairing-msg", e.message, false); } });
    tr.querySelector(".actions").appendChild(del);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="4">No pairing avoidances yet.</td></tr>';
}
onSubmit(pairingForm, async (e) => {
  e.preventDefault(); if (!active) return;
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
  catch (err) { setMsg("pairing-msg", err.message, false); }
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
async function loadDoubles() {
  if (!active) return;
  const data = await api(`/tournaments/${active.id}/doubles`);
  const rt = document.querySelector("#doubles-req-table tbody");
  rt.innerHTML = "";
  for (const r of data.requests) {
    const nm = [r.last_name, r.first_name].filter(Boolean).join(", ");
    const type = r.wants_random ? "random" : "mutual";
    const info = r.status === "paired" ? "paired"
      : r.wants_random ? "queued (waiting)" : `→ ${esc(r.partner_usta || "?")} (awaiting partner)`;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(nm)}</td><td>${esc(r.usta_number)}</td><td>${esc(r.age_division)}</td><td>${chip(type)}</td><td>${info}</td><td class="actions"></td>`;
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => { if (!(await confirmDialog("Delete request?"))) return; try { await api(`/doubles-requests/${r.id}`, { method: "DELETE" }); loadDoubles(); } catch (e) { setMsg("doubles-msg", e.message, false); } });
    tr.querySelector(".actions").appendChild(del);
    rt.appendChild(tr);
  }
  if (data.requests.length === 0) rt.innerHTML = '<tr><td class="empty" colspan="6">No doubles requests yet.</td></tr>';
  const pt = document.querySelector("#doubles-pair-table tbody");
  pt.innerHTML = "";
  for (const d of data.pairs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(d.age_division)}</td><td>${chip(d.pairing_type)}</td><td>${esc(d.player1)}</td><td>${esc(d.player2)}</td><td class="actions"></td>`;
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => { if (!(await confirmDialog("Delete pair?"))) return; try { await api(`/doubles-pairs/${d.id}`, { method: "DELETE" }); loadDoubles(); } catch (e) { setMsg("doubles-msg", e.message, false); } });
    tr.querySelector(".actions").appendChild(del);
    pt.appendChild(tr);
  }
  if (data.pairs.length === 0) pt.innerHTML = '<tr><td class="empty" colspan="5">No verified pairs yet.</td></tr>';
}
onSubmit(doublesForm, async (e) => {
  e.preventDefault(); if (!active) return;
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
  } catch (err) { setMsg("doubles-msg", err.message, false); }
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
  const note = (totals.missing_distance_count ? ` · ${totals.missing_distance_count} missing distance` : "") +
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
}
// Weekday columns for the tournament's play window (TD staffing-plan format).
function _reportColumns(t) {
  return _datesInRange(t.play_start_date, t.play_end_date).map((d) => ({ date: d, head: _dowLong(d) }));
}
function _dowLong(iso) { return new Date(iso + "T00:00:00").toLocaleDateString("en-US", { weekday: "long" }); }
function _fmtMDY(iso) {
  return iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "2-digit" }) : "";
}
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
const workOnBtn = document.getElementById("work-on-btn");
workOnBtn.addEventListener("click", () => {
  if (lastSelectedTournamentId) {
    setActive(lastSelectedTournamentId);
    document.querySelector('.tab[data-target="panel-t-sites"]').click();
  }
});

const tournamentsCrud = wireEntity({
  path: "/tournaments", singular: "tournament", panelId: "panel-tournaments", formId: "tournament-form", msgId: "tournament-msg",
  columns: [{ key: "id" }, { key: "name" }, { key: "type" }],
  onLoad: (rows) => {
    for (const k in tournamentsById) delete tournamentsById[k];
    rows.forEach((t) => (tournamentsById[t.id] = t));
    fillActiveSelect(rows);
    if (active && tournamentsById[active.id]) { active = tournamentsById[active.id]; updateActiveUI(); }
  },
  onSelect: (t) => { lastSelectedTournamentId = t.id; workOnBtn.hidden = false; },
  onNew: () => { lastSelectedTournamentId = null; workOnBtn.hidden = true; },
  // "Work on →" right on the row: jump straight into the workspace for that tournament.
  rowAction: (t) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn-link"; b.textContent = "Work on →";
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
  columns: [{ key: "id" }, { key: "code" }, { key: "name" }, { key: "city" }],
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
async function loadPlayerHistory(id) {
  const box = document.getElementById("player-history");
  const tbody = box.querySelector("tbody");
  box.hidden = false;
  try {
    const rows = await api(`/players/${id}/history`);
    tbody.innerHTML = "";
    for (const h of rows) {
      const when = (h.valid_from || "").slice(0, 10) + " → " + (h.valid_to || "").slice(0, 10);
      const name = [h.last_name, h.first_name].filter(Boolean).join(", ");
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(when)}</td><td>${esc(name)}</td><td>${esc(h.usta_number)}</td><td>${esc(h.change_type)}</td>`;
      tbody.appendChild(tr);
    }
    if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="4">No prior versions — this is the original record.</td></tr>';
  } catch (e) { tbody.innerHTML = `<tr><td class="empty" colspan="4">${esc(e.message)}</td></tr>`; }
}

const playersCrud = wireEntity({
  path: "/players", singular: "player", panelId: "panel-players", formId: "player-form", msgId: "player-msg",
  columns: [{ key: "id" }, { key: "usta_number" }, { key: "name", fmt: (p) => [p.first_name, p.last_name].filter(Boolean).join(" ") }],
  onLoad: (rows) => { for (const k in playersById) delete playersById[k]; rows.forEach((p) => (playersById[p.id] = p)); refreshAllSelects(); },
  onSelect: (p) => loadPlayerHistory(p.id),
  onNew: () => { document.getElementById("player-history").hidden = true; },
});
const ratesCrud = wireEntity({
  path: "/rates", singular: "rate", panelId: "panel-rates", formId: "rate-form", msgId: "rate-msg",
  columns: [{ key: "id" }, { key: "cert_type" }, { key: "rate_per_day", fmt: (r) => "$" + Number(r.rate_per_day).toFixed(2) }, { key: "effective_from" }],
  transform: (o) => { o.rate_per_day = Number(o.rate_per_day); if (o.effective_from == null) delete o.effective_from; return o; },
});
const hotelsCrud = wireEntity({
  path: "/hotels", singular: "hotel", panelId: "panel-hotels", formId: "hotel-form", msgId: "hotel-msg",
  columns: [{ key: "id" }, { key: "name" }, { key: "city" }],
  onLoad: (rows) => { for (const k in hotelsById) delete hotelsById[k]; rows.forEach((h) => (hotelsById[h.id] = h)); refreshAllSelects(); },
});
const distancesCrud = wireEntity({
  path: "/distances", singular: "distance", panelId: "panel-distances", formId: "distance-form", msgId: "distance-msg",
  columns: [
    { key: "id" },
    { key: "official", fmt: (d) => (officialsById[d.official_id] ? officialLabel(officialsById[d.official_id]) : d.official_id) },
    { key: "site", fmt: (d) => (sitesById[d.site_id] ? siteLabel(sitesById[d.site_id]) : d.site_id) },
    { key: "one_way_miles" },
  ],
  transform: (o) => { o.official_id = Number(o.official_id); o.site_id = Number(o.site_id); o.one_way_miles = Number(o.one_way_miles); return o; },
});

// =================== Generic CSV export for list tables ===================
function _csvDownload(matrix, filename) {
  const csv = matrix
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename + ".csv"; a.click();
  URL.revokeObjectURL(url);
}
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
// An empty CSV with just the header row, for the user to fill in and (where
// supported) import. Roster uses the importer's canonical field names so the
// downloaded template can be re-imported as-is.
const TEMPLATE_HEADERS = {
  "roster-table": ["usta_number", "first_name", "last_name", "age_division",
    "events", "selection_status", "t_shirt_size", "dietary_preference"],
};
function templateTable(table, name) {
  const headers = TEMPLATE_HEADERS[table.id] || _visibleHeaders(table).headers;
  _csvDownload([headers], name + "-template");
}
// All exports live on the Export page (Import / Export menu). Each table is kept
// populated by its loader (on active-tournament set / tab open), so exportTable can
// read it from here even when its tab isn't visible.
function _exTable(id, name) {
  if (!active) { toast("Select a tournament first", false); return; }
  exportTable(document.getElementById(id), name);
}
function _tmplTable(id, name) { templateTable(document.getElementById(id), name); }
// One section per export: title + explanation + Export CSV + Download template.
const _tEx = (id, name) => () => _exTable(id, name);
const _tTmpl = (id, name) => () => _tmplTable(id, name);
const EXPORTS = [
  { title: "Roster", desc: "All players entered for the active tournament — division, status, t-shirt and dietary. The template uses the importer's column names, so a filled-in copy can be re-imported on the Roster tab.",
    ex: _tEx("roster-table", "roster"), tmpl: () => _csvDownload([TEMPLATE_HEADERS["roster-table"]], "roster-template") },
  { title: "Sign-in sheet", desc: "Check-in roster in the TD's format — status, events, city/state, t-shirt, hotel and lodging for every player, sorted by last name.",
    ex: rosterSignInExport, tmpl: rosterSignInTemplate },
  { title: "Officials report (staffing plan)", desc: "Assigned officials with per-day roles, site/hotel, pay, mileage and flags for the active tournament (the printable Staffing Plan).",
    ex: reportCsvExport, tmpl: reportTemplateExport },
  { title: "T-shirt order", desc: "Quantity to order per size for selected players (no withdrawals/alternates), smallest size to largest — hand this to the vendor.",
    ex: tshirtOrderExport, tmpl: () => _csvDownload([["Size", "Quantity"]], "tshirt-order-template") },
  { title: "Hotel summary", desc: "Number of selected players per hotel for the active tournament, alphabetical.",
    ex: _tEx("hotel-summary-table", "hotel-summary"), tmpl: _tTmpl("hotel-summary-table", "hotel-summary") },
  { title: "Lodging summary", desc: "Number of selected players per lodging plan (Hotel / Commuter / …) for the active tournament.",
    ex: _tEx("lodging-summary-table", "lodging-summary"), tmpl: _tTmpl("lodging-summary-table", "lodging-summary") },
  { title: "Late entries", desc: "Players who entered after the deadline for the active tournament, with request date/time.",
    ex: _tEx("late-table", "late-entries"), tmpl: _tTmpl("late-table", "late-entries") },
  { title: "Withdrawals", desc: "Players withdrawn from the active tournament, with reason and alternate flag.",
    ex: _tEx("withdrawal-table", "withdrawals"), tmpl: _tTmpl("withdrawal-table", "withdrawals") },
  { title: "Scheduling avoidances", desc: "Day/time conflicts a player asked to avoid (adult events).",
    ex: _tEx("sched-table", "scheduling-avoidances"), tmpl: _tTmpl("sched-table", "scheduling-avoidances") },
  { title: "Division flexibility", desc: "Players willing to play other divisions if theirs is undersubscribed.",
    ex: _tEx("divflex-table", "division-flexibility"), tmpl: _tTmpl("divflex-table", "division-flexibility") },
  { title: "Pairing avoidances", desc: "Groups of juniors (same club / siblings) who should not meet in the first round.",
    ex: _tEx("pairing-table", "pairing-avoidances"), tmpl: _tTmpl("pairing-table", "pairing-avoidances") },
  { title: "Doubles requests", desc: "Pending doubles requests + the random-pairing queue for the active tournament.",
    ex: _tEx("doubles-req-table", "doubles-requests"), tmpl: _tTmpl("doubles-req-table", "doubles-requests") },
  { title: "Doubles pairs", desc: "Verified doubles partnerships (mutual or random) for the active tournament.",
    ex: _tEx("doubles-pair-table", "doubles-pairs"), tmpl: _tTmpl("doubles-pair-table", "doubles-pairs") },
  { title: "Player hotels", desc: "Each player's reported hotel and lodging plan for the active tournament.",
    ex: _tEx("photel-table", "player-hotels"), tmpl: _tTmpl("photel-table", "player-hotels") },
  { title: "Review inbox", desc: "Forwarded player/parent emails in the review inbox with their classification and status.",
    ex: _tEx("inbox-table", "inbox"), tmpl: _tTmpl("inbox-table", "inbox") },
  { title: "T-shirts — all tournaments", desc: "Cumulative t-shirt list across every tournament (latest size per player). Not tied to the active tournament.",
    ex: async () => { await loadTshirts(); exportTable(document.getElementById("tshirt-table"), "tshirts"); },
    tmpl: _tTmpl("tshirt-table", "tshirts") },
  { title: "CVB hotel totals — all tournaments", desc: "Players per hotel across all tournaments, for CVB / convention-bureau negotiations.",
    ex: async () => { await loadCvb(); exportTable(document.getElementById("cvb-table"), "cvb-hotel-totals"); },
    tmpl: _tTmpl("cvb-table", "cvb-hotel-totals") },
];
(function buildExportPage() {
  const root = document.getElementById("export-groups");
  if (!root) return;
  for (const s of EXPORTS) {
    const sec = document.createElement("section"); sec.className = "export-section";
    const h = document.createElement("h4"); h.textContent = s.title; sec.appendChild(h);
    const p = document.createElement("p"); p.className = "muted"; p.textContent = s.desc; sec.appendChild(p);
    const grid = document.createElement("div"); grid.className = "export-grid";
    const ex = document.createElement("button"); ex.type = "button"; ex.className = "export-btn"; ex.textContent = "⬇ Export CSV"; ex.addEventListener("click", s.ex);
    const tm = document.createElement("button"); tm.type = "button"; tm.className = "export-btn"; tm.textContent = "⬇ Download template"; tm.addEventListener("click", s.tmpl);
    grid.append(ex, tm); sec.appendChild(grid); root.appendChild(sec);
  }
})();

// =================== Collapse workspace add-forms (list stays primary) ===================
// Wrap each workspace add-form in a <details> at runtime (no HTML changes).
const COLLAPSIBLE = {
  "withdrawal-form": "Add withdrawal",
  "sched-form": "Add scheduling avoidance", "divflex-form": "Add division flexibility",
  "pairing-form": "Add pairing group", "doubles-form": "File doubles request",
  "photel-form": "Add player hotel", "late-form": "Add late entry", "trb-form": "Add room block",
  "asg-form": "Assign official", "email-form": "Add email",
};
for (const [id, label] of Object.entries(COLLAPSIBLE)) {
  const form = document.getElementById(id);
  if (!form || form.closest("details.addbox")) continue;
  const det = document.createElement("details"); det.className = "addbox";
  const sum = document.createElement("summary"); sum.textContent = "＋ " + label;
  form.parentNode.insertBefore(det, form);
  det.append(sum, form);
}

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
  for (const c of [sitesCrud, officialsCrud, playersCrud, hotelsCrud, ratesCrud, distancesCrud, tournamentsCrud]) {
    try { await c.refresh(); } catch (e) { /* health pill shows DB issues */ }
  }
  const saved = localStorage.getItem("activeTid");
  if (saved && tournamentsById[saved]) setActive(saved);
  else updateActiveUI();
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

function applyAuth(who) {
  const logged = !!who;
  const isAdmin = logged && who.role === "admin";
  const isOfficial = logged && who.role === "official";
  document.getElementById("login-view").hidden = logged;
  document.getElementById("user-box").hidden = !logged;
  document.getElementById("username-label").textContent = who ? `${who.username} (${who.role})` : "";
  document.getElementById("menu").hidden = !isAdmin;
  document.querySelector("main:not(#official-app)").hidden = !isAdmin;
  document.getElementById("context-bar").hidden = !isAdmin;
  document.getElementById("official-app").hidden = !isOfficial;
  if (isAdmin) adminInit();
  if (isOfficial) officialInit();
}

onSubmit(document.getElementById("login-form"), async (e) => {
  e.preventDefault();
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
onSubmit(document.getElementById("me-form"), async (e) => {
  e.preventDefault();
  const b = {};
  for (const el of e.target.elements) if (el.name) b[el.name] = el.value === "" ? null : el.value;
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

(async function init() {
  enhanceAllSelects();  // turn every <select> into a type-in dropdown
  markRequiredFields();
  await refreshHealth();
  let who = null;
  try { who = await api("/auth/me"); } catch (e) { who = null; }
  applyAuth(who);
})();
