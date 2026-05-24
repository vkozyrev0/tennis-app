// Minimal vanilla JS — the only scripting in the POC. Tabs, master-detail CRUD
// for simple entities, and a tournament-centric hub (sites / roster / official
// assignments with per-day roles + computed pay & mileage). No framework.

async function api(path, options) {
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
}

function setMsg(id, text, ok) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "bad");
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
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

function fillSelect(el, items, labelFn, none = true) {
  if (!el) return;
  const cur = el.value;
  el.innerHTML = none ? '<option value="">— none —</option>' : "";
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = labelFn(it);
    el.appendChild(o);
  }
  el.value = cur;
}

// ---- caches ----
const sitesById = {}, tournamentsById = {}, officialsById = {}, playersById = {}, hotelsById = {};
const officialLabel = (o) => `${o.last_name}, ${o.first_name}`;
const siteLabel = (s) => (s.code ? s.code + " — " : "") + s.name;
const playerLabel = (p) => `${[p.last_name, p.first_name].filter(Boolean).join(", ") || "?"} (${p.usta_number})`;

function refreshAllSelects() {
  fillSelect(document.getElementById("rb-hotel"), Object.values(hotelsById), (h) => h.name, false);
  fillSelect(document.getElementById("rb-tournament"), Object.values(tournamentsById), (t) => t.name);
  fillSelect(document.getElementById("dist-official"), Object.values(officialsById), officialLabel, false);
  fillSelect(document.getElementById("dist-site"), Object.values(sitesById), siteLabel, false);
  fillSelect(document.getElementById("roster-player"), Object.values(playersById), playerLabel, false);
  fillSelect(document.getElementById("asg-official"), Object.values(officialsById), officialLabel, false);
  fillSelect(document.getElementById("asg-site"), Object.values(sitesById), siteLabel);
}

// ---- tabs ----
document.getElementById("tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === tab.dataset.target));
});

// ---- generic master-detail CRUD ----
function wireEntity(cfg) {
  const panel = document.getElementById(cfg.panelId);
  const form = document.getElementById(cfg.formId);
  const tbody = panel.querySelector(".list-table tbody");
  const filterInput = panel.querySelector(".filter");
  const newBtn = panel.querySelector(".new-btn");
  const title = panel.querySelector(".detail-title");
  const submitBtn = form.querySelector('button[type="submit"]');
  const deleteBtn = form.querySelector(".delete");
  const cancelBtn = form.querySelector(".cancel");
  let items = [];
  let selectedId = null;

  function fillForm(item) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = item ? item[el.name] : null;
      el.value = v === null || v === undefined ? "" : v;
    }
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
  }
  async function removeItem(id) {
    if (!confirm(`Delete ${cfg.singular} #${id}?`)) return;
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
    try {
      let body = formObj(form);
      if (cfg.transform) body = cfg.transform(body);
      const editing = selectedId != null;
      const saved = await api(editing ? `${cfg.path}/${selectedId}` : cfg.path,
        { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
      if (saved && saved.id != null) selectedId = saved.id;
      setMsg(cfg.msgId, editing ? "saved" : "created", true);
      await refresh();
      if (cfg.afterChange) cfg.afterChange();
      if (saved && saved.id != null) select(saved);
    } catch (err) { setMsg(cfg.msgId, err.message, false); }
  });
  deleteBtn.addEventListener("click", () => { if (selectedId != null) removeItem(selectedId); });
  newBtn.addEventListener("click", showNew);
  cancelBtn.addEventListener("click", showNew);
  filterInput.addEventListener("input", renderList);
  showNew();
  return { refresh, select };
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

// =================== Tournament hub ===================
let currentTid = null;
let rosterEditId = null;
let asgEditId = null;
const extras = document.getElementById("tournament-extras");

function hubOpen(t) { currentTid = t.id; extras.hidden = false; loadHubSites(); loadRoster(); loadAssignments(); }
function hubClose() { currentTid = null; extras.hidden = true; }

// --- sites mapping ---
async function loadHubSites() {
  const box = document.getElementById("hub-site-checks");
  const selected = new Set((await api(`/tournaments/${currentTid}/sites`)).map((s) => s.id));
  box.innerHTML = "";
  for (const s of Object.values(sitesById)) {
    const lab = document.createElement("label");
    lab.className = "check";
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = s.id; cb.checked = selected.has(s.id);
    lab.append(cb, document.createTextNode(" " + siteLabel(s)));
    box.appendChild(lab);
  }
  if (Object.keys(sitesById).length === 0) box.innerHTML = '<span class="muted">No sites defined yet.</span>';
}
document.getElementById("hub-sites-save").addEventListener("click", async () => {
  const ids = [...document.querySelectorAll("#hub-site-checks input:checked")].map((c) => Number(c.value));
  try {
    await api(`/tournaments/${currentTid}/sites`, { method: "PUT", body: JSON.stringify({ site_ids: ids }) });
    setMsg("hub-sites-msg", "saved", true);
  } catch (e) { setMsg("hub-sites-msg", e.message, false); }
});

// --- roster mapping ---
const rosterForm = document.getElementById("roster-form");
async function loadRoster() {
  const tbody = document.querySelector("#roster-table tbody");
  const rows = await api(`/tournaments/${currentTid}/players`);
  tbody.innerHTML = "";
  for (const e of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc([e.last_name, e.first_name].filter(Boolean).join(", "))} <span class="muted">(${esc(e.usta_number)})</span></td>` +
      `<td>${esc(e.age_division)}</td><td>${esc(e.selection_status)}</td><td>${esc(e.t_shirt_size)}</td><td>${esc(e.dietary_preference)}</td><td class="actions"></td>`;
    const cell = tr.querySelector(".actions");
    const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
    ed.addEventListener("click", () => {
      rosterEditId = e.id;
      rosterForm.player_id.value = e.player_id;
      rosterForm.age_division.value = e.age_division || "";
      rosterForm.events.value = e.events || "";
      rosterForm.selection_status.value = e.selection_status;
      rosterForm.t_shirt_size.value = e.t_shirt_size || "";
      rosterForm.dietary_preference.value = e.dietary_preference || "";
      rosterForm.querySelector('button[type="submit"]').textContent = "Update player";
    });
    const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn-link danger"; dl.textContent = "Delete";
    dl.addEventListener("click", async () => {
      if (!confirm("Remove player from roster?")) return;
      try { await api(`/roster/${e.id}`, { method: "DELETE" }); loadRoster(); } catch (err) { setMsg("roster-msg", err.message, false); }
    });
    cell.append(ed, dl);
    tbody.appendChild(tr);
  }
  if (rows.length === 0) tbody.innerHTML = '<tr><td class="empty" colspan="6">No players on this roster yet.</td></tr>';
}
function rosterReset() {
  rosterEditId = null; rosterForm.reset();
  rosterForm.querySelector('button[type="submit"]').textContent = "Add player";
}
rosterForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = formObj(rosterForm);
  b.player_id = Number(b.player_id);
  try {
    if (rosterEditId) await api(`/roster/${rosterEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/tournaments/${currentTid}/players`, { method: "POST", body: JSON.stringify(b) });
    setMsg("roster-msg", rosterEditId ? "saved" : "added", true);
    rosterReset(); loadRoster();
  } catch (err) { setMsg("roster-msg", err.message, false); }
});
rosterForm.querySelector(".cancel").addEventListener("click", rosterReset);

// --- assignments mapping ---
const asgForm = document.getElementById("asg-form");
const ROLES = ["roving", "chair", "referee"];
async function loadAssignments() {
  const rbList = await api(`/room-blocks?tournament_id=${currentTid}`);
  fillSelect(document.getElementById("asg-room-block"), rbList,
    (b) => `${hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : "hotel " + b.hotel_id} (${b.room_count} rms)`);
  const list = await api(`/tournaments/${currentTid}/assignments`);
  const box = document.getElementById("asg-list");
  box.innerHTML = "";
  if (list.length === 0) { box.innerHTML = '<p class="muted">No officials assigned yet.</p>'; return; }
  for (const a of list) box.appendChild(renderAssignment(a));
}
function renderAssignment(a) {
  const card = document.createElement("div");
  card.className = "asg";
  const mileage = a.missing_distance ? '<span class="warn">no distance</span>' : (a.mileage == null ? "—" : "$" + a.mileage.toFixed(2));
  const flags = a.hotel_date_mismatch ? ' <span class="warn">⚠ hotel dates</span>' : "";
  const head = document.createElement("div");
  head.className = "asg-head";
  head.innerHTML = `<strong>${esc(a.official_name)}</strong> · site: ${esc(a.site_label) || "—"} · hotel: ${esc(a.hotel_name) || "—"}` +
    ` · pay $${a.pay.toFixed(2)} · mileage ${mileage} · <strong>total $${a.total.toFixed(2)}</strong>${flags}`;
  const actions = document.createElement("span"); actions.className = "asg-actions";
  const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
  ed.addEventListener("click", () => {
    asgEditId = a.id;
    asgForm.official_id.value = a.official_id;
    asgForm.site_id.value = a.site_id || "";
    asgForm.room_block_id.value = a.room_block_id || "";
    asgForm.querySelector('button[type="submit"]').textContent = "Update assignment";
  });
  const dl = document.createElement("button"); dl.type = "button"; dl.className = "btn-link danger"; dl.textContent = "Delete";
  dl.addEventListener("click", async () => {
    if (!confirm("Delete assignment?")) return;
    try { await api(`/assignments/${a.id}`, { method: "DELETE" }); loadAssignments(); } catch (e) { setMsg("asg-msg", e.message, false); }
  });
  actions.append(ed, dl);
  head.appendChild(actions);
  card.appendChild(head);

  // days
  const days = document.createElement("div");
  days.className = "days";
  for (const d of a.days) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `${esc(d.work_date)} ${esc(d.working_as)} $${d.rate_applied.toFixed(2)} `;
    const x = document.createElement("button"); x.type = "button"; x.className = "chip-x"; x.textContent = "×";
    x.addEventListener("click", async () => {
      try { await api(`/assignment-days/${d.id}`, { method: "DELETE" }); loadAssignments(); } catch (e) { setMsg("asg-msg", e.message, false); }
    });
    chip.appendChild(x);
    days.appendChild(chip);
  }
  card.appendChild(days);

  // add-day inline
  const addRow = document.createElement("div");
  addRow.className = "add-day";
  const dateIn = document.createElement("input"); dateIn.type = "date";
  const roleSel = document.createElement("select");
  ROLES.forEach((r) => { const o = document.createElement("option"); o.value = r; o.textContent = r; roleSel.appendChild(o); });
  const addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn-link"; addBtn.textContent = "+ day";
  addBtn.addEventListener("click", async () => {
    if (!dateIn.value) { setMsg("asg-msg", "pick a date", false); return; }
    try {
      await api(`/assignments/${a.id}/days`, { method: "POST", body: JSON.stringify({ work_date: dateIn.value, working_as: roleSel.value }) });
      loadAssignments();
    } catch (e) { setMsg("asg-msg", e.message, false); }
  });
  addRow.append(dateIn, roleSel, addBtn);
  card.appendChild(addRow);
  return card;
}
function asgReset() {
  asgEditId = null; asgForm.reset();
  asgForm.querySelector('button[type="submit"]').textContent = "Add official";
}
asgForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const b = formObj(asgForm);
  b.official_id = Number(b.official_id);
  b.site_id = b.site_id ? Number(b.site_id) : null;
  b.room_block_id = b.room_block_id ? Number(b.room_block_id) : null;
  try {
    if (asgEditId) await api(`/assignments/${asgEditId}`, { method: "PUT", body: JSON.stringify(b) });
    else await api(`/tournaments/${currentTid}/assignments`, { method: "POST", body: JSON.stringify(b) });
    setMsg("asg-msg", asgEditId ? "saved" : "added", true);
    asgReset(); loadAssignments();
  } catch (err) { setMsg("asg-msg", err.message, false); }
});
asgForm.querySelector(".cancel").addEventListener("click", asgReset);

// =================== entity configs ===================
const tournamentsCrud = wireEntity({
  path: "/tournaments", singular: "tournament", panelId: "panel-tournaments",
  formId: "tournament-form", msgId: "tournament-msg",
  columns: [{ key: "id" }, { key: "name" }, { key: "type" }],
  onLoad: (rows) => {
    for (const k in tournamentsById) delete tournamentsById[k];
    rows.forEach((t) => (tournamentsById[t.id] = t));
    refreshAllSelects();
  },
  onSelect: hubOpen,
  onNew: hubClose,
});

const sitesCrud = wireEntity({
  path: "/sites", singular: "site", panelId: "panel-sites", formId: "site-form", msgId: "site-msg",
  columns: [{ key: "id" }, { key: "code" }, { key: "name" }, { key: "city" }],
  onLoad: (rows) => { for (const k in sitesById) delete sitesById[k]; rows.forEach((s) => (sitesById[s.id] = s)); refreshAllSelects(); },
});

const officialsCrud = wireEntity({
  path: "/officials", singular: "official", panelId: "panel-officials", formId: "official-form", msgId: "official-msg",
  columns: [{ key: "id" }, { key: "name", fmt: officialLabel }, { key: "loc", fmt: (o) => [o.city, o.state].filter(Boolean).join(", ") }],
  onLoad: (rows) => { for (const k in officialsById) delete officialsById[k]; rows.forEach((o) => (officialsById[o.id] = o)); refreshAllSelects(); },
});

const playersCrud = wireEntity({
  path: "/players", singular: "player", panelId: "panel-players", formId: "player-form", msgId: "player-msg",
  columns: [{ key: "id" }, { key: "usta_number" }, { key: "name", fmt: (p) => [p.first_name, p.last_name].filter(Boolean).join(" ") }],
  onLoad: (rows) => { for (const k in playersById) delete playersById[k]; rows.forEach((p) => (playersById[p.id] = p)); refreshAllSelects(); },
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

const roomBlocksCrud = wireEntity({
  path: "/room-blocks", singular: "room block", panelId: "panel-room-blocks", formId: "room-block-form", msgId: "room-block-msg",
  columns: [
    { key: "id" },
    { key: "hotel", fmt: (b) => (hotelsById[b.hotel_id] ? hotelsById[b.hotel_id].name : "?") },
    { key: "room_count" },
    { key: "tournament", fmt: (b) => (b.tournament_id && tournamentsById[b.tournament_id] ? tournamentsById[b.tournament_id].name : "") },
  ],
  transform: (o) => {
    o.hotel_id = Number(o.hotel_id);
    o.tournament_id = o.tournament_id ? Number(o.tournament_id) : null;
    o.room_count = o.room_count == null ? 0 : Number(o.room_count);
    return o;
  },
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

(async function init() {
  await refreshHealth();
  // load master data first so caches + selects are ready for the hub
  for (const c of [sitesCrud, officialsCrud, playersCrud, hotelsCrud, ratesCrud, roomBlocksCrud, distancesCrud, tournamentsCrud]) {
    try { await c.refresh(); } catch (e) { /* health pill shows DB issues */ }
  }
})();
