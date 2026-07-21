// Incidents (day-of log) panel — D11.

/**
 * @returns {{ loadIncidents: () => Promise<void> }}
 */
export function createIncidentsPanel(ctx) {
  const {
    api, setMsg, confirmDialog, markInvalid, onSubmit, openForm,
    hstr, fillSelect, siteLabel, makeListGrid, scheduleComboSync,
    getActive, getSitesById,
  } = ctx;

  // =================== Incidents (P4-3 day-of log) ===================
  const incidentForm = document.getElementById("incident-form");
  let incEditId = null, incEditRow = null;
  function incReset() {
    incEditId = null; incEditRow = null; incidentForm.reset();
    incidentForm.querySelector('button[type="submit"]').textContent = "Log incident";
    scheduleComboSync();
  }
  const INC_CATS = {
    weather: "Weather", injury: "Injury", dispute: "Dispute",
    facility: "Facility", conduct: "Conduct", other: "Other",
  };
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
    async (i) => {
      if (!(await confirmDialog("Delete this incident?"))) return;
      try { await api(`/incidents/${i.id}`, { method: "DELETE" }); loadIncidents(); }
      catch (e) { setMsg("incident-msg", e.message, false); }
    },
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
      } catch (e) {
        setMsg("incident-msg", e.message, false);
        try { cell.restoreOldValue(); } catch (_) {}
        loadIncidents();
      }
    });

  async function loadIncidents() {
    const active = getActive();
    if (!active) return;
    fillSelect(document.getElementById("inc-site"), Object.values(getSitesById()), siteLabel, true);
    incidentsGrid.setData(await api(`/tournaments/${active.id}/incidents`));
  }

  if (incidentForm) {
    onSubmit(incidentForm, async () => {
      const active = getActive();
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
    incidentForm.querySelector(".cancel")?.addEventListener("click", incReset);
  }

  return { loadIncidents };
}
