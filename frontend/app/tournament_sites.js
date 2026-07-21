// Tournament sites membership + division→site assignment — D11.
export function createTournamentSitesPanel(ctx) {
  const {
    api,
    setMsg,
    hstr,
    makeReadGrid,
    siteLabel,
    getActive,
    getSitesById
  } = ctx;

  // --- Sites: filterable grid with membership toggles ---
  let tSitesSelected = new Set();
  async function loadTSites() {
    if (!getActive()) return;
    tSitesSelected = new Set((await api(`/tournaments/${getActive().id}/sites`)).map((s) => s.id));
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
  // whether it's currently part of the getActive() tournament.
  ], "tournament-sites", "No sites match.", {
    index: "id",
    // Multi-select tint: rows already part of the getActive() tournament get .row-selected.
    // Re-evaluated on every setData()/setFilter() (which redraw) and after toggleSite.
    rowClassRules: { "row-selected": (p) => p.data && tSitesSelected.has(p.data.id) },
  });
  function tSitesMatches(s) {
    const q = document.getElementById("t-sites-filter").value.trim().toLowerCase();
    return !q || siteLabel(s).toLowerCase().includes(q) || (s.city || "").toLowerCase().includes(q);
  }
  function renderTSites() {
    tSitesGrid.setData(Object.values(getSitesById()));
    tSitesGrid.setFilter(tSitesMatches);
  }
  async function toggleSite(id) {
    if (tSitesSelected.has(id)) tSitesSelected.delete(id); else tSitesSelected.add(id);
    try {
      await api(`/tournaments/${getActive().id}/sites`, { method: "PUT", body: JSON.stringify({ site_ids: [...tSitesSelected] }) });
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
    if (!getActive()) return;
    const tbody = document.querySelector("#t-site-divisions-table tbody");
    if (!tbody) return;
    // Need the linked sites first — division can only be assigned to a site
    // that's already used by this tournament.
    const [matrix, sites] = await Promise.all([
      api(`/tournaments/${getActive().id}/site-divisions`),
      api(`/tournaments/${getActive().id}/sites`),
    ]);
    tbody.innerHTML = "";
    if (!sites.length) {
      tbody.innerHTML = `<tr><td colspan="3" class="muted">Add sites above first, then come back to assign divisions.</td></tr>`;
      return;
    }
    // Limit divisions to the getActive() tournament's type so a junior tournament
    // doesn't list NTRP adult buckets and vice versa.
    const ttype = getActive().type;
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
          await api(`/tournaments/${getActive().id}/site-divisions/${d.division_id}`, {
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

  return { loadTSites, loadTSiteDivisions, renderTSites };
}
