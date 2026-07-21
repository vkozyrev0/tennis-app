// Staff (non-official support roles) panel — D11.
import { datesInRange as datesInRangeUtil } from "./util.js";

/**
 * @param {{
 *   api: Function,
 *   setMsg: Function,
 *   confirmDialog: Function,
 *   markInvalid: Function,
 *   formObj: Function,
 *   onSubmit: Function,
 *   openForm: Function,
 *   hstr: Function,
 *   money: Function,
 *   fmtDOW: Function,
 *   makeListGrid: Function,
 *   getActive: () => any,
 *   datesInRange?: (start: string, end: string) => string[],
 * }} ctx
 * @returns {{ loadStaff: () => Promise<void> }}
 */
export function createStaffPanel(ctx) {
  const {
    api, setMsg, confirmDialog, markInvalid, formObj, onSubmit, openForm,
    hstr, money, fmtDOW, makeListGrid, getActive, datesInRange: datesInRangeFn,
  } = ctx;
  const datesInRange = datesInRangeFn || datesInRangeUtil;

  // --- Staff (non-official support roles, tournament-scoped) ---
  const STAFF_ROLES = {
    site_director: "Site Director", player_amenities: "Player Amenities",
    trainer: "Trainer", operations: "Operations", stringer: "Stringer", other: "Other",
  };
  const staffForm = document.getElementById("staff-form");
  let staffEditId = null;

  // Populate the staff Days multi-select from the active tournament's play window;
  // `selected` is an optional Set of ISO dates to pre-check.
  function _fillStaffDays(selected) {
    const sel = document.getElementById("staff-days");
    if (!sel) return;
    const want = selected || new Set([...sel.selectedOptions].map((o) => o.value));
    sel.innerHTML = "";
    const active = getActive();
    if (!active) return;
    for (const d of datesInRange(active.play_start_date, active.play_end_date)) {
      const o = document.createElement("option");
      o.value = d; o.textContent = fmtDOW(d);
      if (want.has(d)) o.selected = true;
      sel.appendChild(o);
    }
  }

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
    async (s) => {
      if (!(await confirmDialog("Delete staff member?"))) return;
      try { await api(`/staff/${s.id}`, { method: "DELETE" }); loadStaff(); }
      catch (e) { setMsg("staff-msg", e.message, false); }
    },
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
      } catch (e) {
        setMsg("staff-msg", e.message, false);
        try { cell.restoreOldValue(); } catch (_) {}
        loadStaff();
      }
    });

  async function loadStaff() {
    if (!getActive()) return;
    _fillStaffDays();  // play-window options for the add/edit form
    staffGrid.setData(await api(`/tournaments/${getActive().id}/staff`));
  }

  function staffReset() {
    staffEditId = null;
    staffForm.reset();
    _fillStaffDays(new Set());
    staffForm.querySelector('button[type="submit"]').textContent = "Add staff";
  }

  if (staffForm) {
    onSubmit(staffForm, async () => {
      const active = getActive();
      if (!active) return;
      const b = formObj(staffForm);
      // formObj joins a multi-select into "a, b"; the API wants a list of dates.
      b.days = b.days ? b.days.split(", ") : [];
      b.daily_rate = b.daily_rate ? Number(b.daily_rate) : null;
      try {
        if (staffEditId) await api(`/staff/${staffEditId}`, { method: "PUT", body: JSON.stringify(b) });
        else await api(`/tournaments/${active.id}/staff`, { method: "POST", body: JSON.stringify(b) });
        setMsg("staff-msg", staffEditId ? "saved" : "added", true);
        staffReset(); loadStaff();
      } catch (err) {
        setMsg("staff-msg", err.message, false);
        markInvalid(staffForm, err.message);
      }
    });
    staffForm.querySelector(".cancel")?.addEventListener("click", staffReset);
  }

  return { loadStaff };
}
