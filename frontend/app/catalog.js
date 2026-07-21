// Division + Event Setup catalog helpers (D11 slice from app.js).
// Filters by tournament type + player gender for datalists, <select data-catalog>,
// and AG Grid list editors.
import { hstr, raw } from "./html.js";

/**
 * @param {{
 *   getActive: () => { type?: string } | null,
 *   getPlayersById: () => Record<string|number, { gender?: string }>,
 *   getPlayersByUsta: () => Record<string, { gender?: string }>,
 *   scheduleComboSync: () => void,
 * }} ctx
 */
export function createDivisionCatalog(ctx) {
  const { getActive, getPlayersById, getPlayersByUsta, scheduleComboSync } = ctx;

  let divisionsAll = [];
  let eventsAll = [];

  function _populateDatalist(id, items) {
    const dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = items.map((it) => {
      const value = typeof it === "string" ? it : it.code;
      const label = typeof it === "string" ? "" : (it.label === it.code ? "" : it.label);
      const labelAttr = label ? hstr` label="${label}"` : "";
      return hstr`<option value="${value}"${raw(labelAttr)}>${label || value}</option>`;
    }).join("");
  }

  function _divisionsFor(type, gender) {
    return divisionsAll.filter((d) => d.tournament_type === type
      && (d.gender == null || !gender || d.gender === gender));
  }
  function _eventsFor(type, gender) {
    return eventsAll
      .filter((e) => e.tournament_type === type
        && (e.gender == null || !gender || e.gender === gender))
      .map((e) => e.name);
  }

  function refreshDivisionLists(gender) {
    const active = getActive();
    const type = (active && active.type) || "junior";
    _populateDatalist("divisions-list", _divisionsFor(type, gender || null));
    _populateDatalist("events-list", _eventsFor(type, gender || null));
    _populateCatalogSelects(type, gender || null);
  }

  function divisionListParams(opts) {
    const o = opts || {};
    const active = getActive();
    const type = (active && active.type) || "junior";
    const items = _divisionsFor(type, o.gender || null);
    return {
      values: items.map((d) => ({ label: d.code, value: d.code })),
      autocomplete: true, listOnEmpty: true, clearable: true,
      multiselect: !!o.multiple,
    };
  }

  function rowGender(row) {
    const playersById = getPlayersById();
    const playersByUsta = getPlayersByUsta();
    if (!row || typeof playersById !== "object") return null;
    if (row.player_id && playersById[row.player_id]) return playersById[row.player_id].gender || null;
    if (row.usta_number) {
      const p = playersByUsta[row.usta_number];
      return p ? (p.gender || null) : null;
    }
    return null;
  }

  function eventListParams(opts) {
    const o = opts || {};
    const active = getActive();
    const type = (active && active.type) || "junior";
    const items = _eventsFor(type, o.gender || null);
    return {
      values: items.map((n) => ({ label: n, value: n })),
      autocomplete: true, listOnEmpty: true, clearable: true,
      multiselect: !!o.multiple,
    };
  }

  function _populateCatalogSelects(type, gender) {
    const divs = _divisionsFor(type, gender);
    const evs = _eventsFor(type, gender);
    for (const sel of document.querySelectorAll("select[data-catalog]")) {
      const kind = sel.getAttribute("data-catalog");
      const items = kind === "event" ? evs.map((n) => ({ code: n, label: n })) : divs;
      const isMulti = sel.multiple;
      const prevSelected = isMulti
        ? new Set([...sel.selectedOptions].map((o) => o.value))
        : sel.value;
      const placeholder = !isMulti && sel.querySelector('option[value=""]');
      sel.innerHTML = "";
      if (placeholder) sel.appendChild(placeholder);
      for (const it of items) {
        const o = document.createElement("option");
        o.value = it.code;
        o.textContent = it.label === it.code ? it.code : `${it.code} — ${it.label}`;
        sel.appendChild(o);
      }
      if (isMulti) {
        [...sel.options].forEach((o) => { if (prevSelected.has(o.value)) o.selected = true; });
      } else if (prevSelected) {
        if (![...sel.options].some((o) => o.value === prevSelected)) {
          const o = document.createElement("option");
          o.value = prevSelected; o.textContent = prevSelected + " (legacy)";
          sel.appendChild(o);
        }
        sel.value = prevSelected;
      }
      if (sel.dataset.combo === "1") scheduleComboSync();
    }
  }

  function inferFormGender(form) {
    const playersById = getPlayersById();
    if (!form || typeof playersById !== "object") return null;
    const pref = form.querySelector("[name='player_ref']");
    if (pref && pref.value) return (playersById[pref.value] || {}).gender || null;
    const picker = form.querySelector("[name='player_id']");
    if (picker && picker.value && !picker.disabled) {
      return (playersById[picker.value] || {}).gender || null;
    }
    const newRow = form.querySelector(".roster-new-row [name='gender']");
    if (newRow && !newRow.disabled && newRow.value) return newRow.value;
    return null;
  }

  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t) return;
    if (t.tagName === "INPUT") {
      const list = t.getAttribute("list");
      if (list === "divisions-list" || list === "events-list") {
        refreshDivisionLists(inferFormGender(t.closest("form")));
      }
      return;
    }
    if (t.tagName === "SELECT" && t.hasAttribute("data-catalog")) {
      refreshDivisionLists(inferFormGender(t.closest("form")));
    }
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!t || !t.form) return;
    const name = t.getAttribute("name");
    if (name === "player_ref" || name === "player_id" || name === "gender") {
      refreshDivisionLists(inferFormGender(t.form));
    }
  });

  return {
    setDivisions(rows) { divisionsAll = rows.slice(); },
    setEvents(rows) { eventsAll = rows.slice(); },
    getDivisions() { return divisionsAll; },
    getEvents() { return eventsAll; },
    refreshDivisionLists,
    divisionListParams,
    eventListParams,
    rowGender,
    inferFormGender,
  };
}
