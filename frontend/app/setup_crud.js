// Setup entity wireEntity configs (tournaments, sites, officials, …) — D11.

export function createSetupCrud(ctx) {
  const {
    api, setMsg, toast, wireEntity, makeGrid, makeReadGrid, hstr, playerCell,
    officialLabel, siteLabel, syncCombos,
    fillActiveSelect, setActive, activateGroup, updateActiveUI, refreshAllSelects,
    refreshDivisionLists, divCatalog,
    tournamentsById, sitesById, officialsById, playersById, playersByUsta, hotelsById,
    getActive, setActiveRef, setLastSelectedTournamentId, renderTSites, invalidatePickCache,
  } = ctx;

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
      if (getActive() && tournamentsById[getActive().id]) { setActiveRef(tournamentsById[getActive().id]); updateActiveUI(); }
    },
    onSelect: (t) => { setLastSelectedTournamentId(t.id); },
    onNew: () => { setLastSelectedTournamentId(null); },
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
    onLoad: (rows) => { for (const k in sitesById) delete sitesById[k]; rows.forEach((s) => (sitesById[s.id] = s)); refreshAllSelects(); if (getActive()) renderTSites(); },
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
    { title: "Name", field: "last_name", formatter: playerCell },
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
      invalidatePickCache();
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
    onLoad: (rows) => { divCatalog.setDivisions(rows); refreshDivisionLists(); },
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
    onLoad: (rows) => { divCatalog.setEvents(rows); refreshDivisionLists(); },
  });

  document.getElementById("acct-save")?.addEventListener("click", async () => {
    if (!certOfficialId) return;
    try {
      await api(`/officials/${certOfficialId}/account`, { method: "PUT", body: JSON.stringify({ username: document.getElementById("acct-user").value, password: document.getElementById("acct-pass").value }) });
      setMsg("acct-msg", "login set", true);
    } catch (err) { setMsg("acct-msg", err.message, false); }
  });

  return {
    tournamentsCrud, sitesCrud, officialsCrud, playersCrud,
    ratesCrud, hotelsCrud, distancesCrud, divisionsCrud, eventsCrud,
    loadCerts, getCertOfficialId: () => certOfficialId,
  };
}
