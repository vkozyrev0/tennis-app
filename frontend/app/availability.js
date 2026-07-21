// Availability panel — TD grid + heatmap + bulk date picks (D11).
// Backend: /api/tournaments/{id}/availability (+ /grid, coverage-fill).

import { datesInRange } from "./util.js";

/**
 * @returns {{ loadAvailability: () => Promise<void> }}
 */
export function createAvailabilityPanel(ctx) {
  const {
    api, setMsg, toast,
    html, hstr, raw, fmtDOW, fillSelect, officialLabel, certLabel,
    makeReadGrid, getActive, getOfficialsById, getCertPairs,
  } = ctx;

  // --- Availability (per official, per tournament) ---
  let availAll = [];
  function renderAvailDates() {
    const sel = document.getElementById("avail-official");
    const oid = sel.value ? Number(sel.value) : null;
    const mine = availAll.filter((r) => r.official_id === oid);
    const checked = new Set(mine.map((r) => r.available_date));
    document.getElementById("avail-hotel").checked = mine.some((r) => r.hotel_needed);
    const box = document.getElementById("avail-dates");
    box.innerHTML = "";
    if (!getActive()) return;
    for (const d of datesInRange(getActive().play_start_date, getActive().play_end_date)) {
      const lbl = document.createElement("label"); lbl.className = "chip";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = d; cb.checked = checked.has(d);
      lbl.append(cb, document.createTextNode(" " + fmtDOW(d)));
      box.appendChild(lbl);
    }
  }
  const availGrid = makeReadGrid("avail-table", [
    { title: "Official", field: "official_name" },
    { title: "Available dates", field: "dates_text", headerSort: false },
    { title: "Hotel", field: "hotel", width: 90, noFilter: true, formatter: (c) => (c.getData().hotel ? "yes" : "") },
    // Availability-vs-assigned gap: an official who offered dates but has no
    // assigned day yet is the TD's cue to staff them (audit §Availability).
    // "Show me who offered dates but isn't staffed yet" is the whole point of this
    // tab — make Assigned filterable (and a chip, for parity with the app).
    { title: "Assigned", field: "assigned", width: 130,
      headerFilter: "list",
      headerFilterParams: { values: { "": "All", yes: "assigned", no: "not yet" } },
      headerFilterFunc: (sel, _v, data) => !sel || (sel === "yes" ? !!data.assigned : !data.assigned),
      formatter: (c) => (c.getData().assigned
        ? '<span class="badge badge-ok">✓ assigned</span>'
        : '<span class="badge badge-warn">⚠ not yet</span>') },
  ], "availability", "No availability recorded yet.");
  // Official ids that have at least one assigned day in this tournament (set in
  // loadAvailability), so the table + gap callout can flag the unstaffed.
  let availAssignedIds = new Set();
  function renderAvailTable() {
    const byOff = {};
    for (const r of availAll) {
      (byOff[r.official_id] ||= { name: r.official_name, dates: [], hotel: false });
      byOff[r.official_id].dates.push(r.available_date);
      if (r.hotel_needed) byOff[r.official_id].hotel = true;
    }
    const rows = Object.keys(byOff)
      .map((id) => ({ id: Number(id), ...byOff[id] }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => ({
        official_name: o.name, hotel: o.hotel,
        dates_text: o.dates.sort().map(fmtDOW).join(", "),
        assigned: availAssignedIds.has(o.id),
      }));
    availGrid.setData(rows);
    // Gap callout: how many available officials aren't staffed yet.
    const gap = rows.filter((r) => !r.assigned);
    const el = document.getElementById("avail-gap");
    if (gap.length) {
      el.hidden = false;
      el.innerHTML = `⚠ ${gap.length} of ${rows.length} available official(s) have no assigned day yet: ` +
        hstr`<strong>${gap.map((r) => r.official_name).join("; ")}</strong>. ` +
        `Staff them on the Assignments tab.`;
    } else {
      el.hidden = true; el.textContent = "";
    }
  }
  async function renderAvailCerts(oid) {
    const box = document.getElementById("avail-certs");
    box.innerHTML = "";
    if (!oid) return;
    const certs = await api(`/officials/${oid}/certifications`);
    const held = {};
    certs.forEach((c) => (held[c.cert_type] = c.id));
    for (const [v, lbl] of getCertPairs()) {
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
    if (!getActive()) return;
    // Audit M34: officialsById may be empty on first load (the Officials Setup
    // tab hasn't refreshed yet). Fetch directly so the picker is always populated.
    const sel = document.getElementById("avail-official");
    const officials = Object.values(getOfficialsById()).length
      ? Object.values(getOfficialsById())
      : await api("/officials");
    fillSelect(sel, officials, officialLabel, false);
    // Availability + assignments together so the table can flag who offered dates
    // but isn't staffed yet. allSettled so an assignments hiccup doesn't blank the
    // availability view.
    const [availR, asgR] = await Promise.allSettled([
      api(`/tournaments/${getActive().id}/availability`),
      api(`/tournaments/${getActive().id}/assignments`),
    ]);
    availAll = availR.status === "fulfilled" ? availR.value : [];
    const asgList = asgR.status === "fulfilled" ? asgR.value : [];
    // An official counts as "assigned" only with at least one working day.
    availAssignedIds = new Set(asgList.filter((a) => a.days && a.days.length).map((a) => a.official_id));
    // Pick the current value once and feed it through both renderers, instead of
    // letting renderAvailDates read .value while comboSync may still be settling.
    const oid = sel.value ? Number(sel.value) : null;
    renderAvailDates();
    renderAvailTable();
    renderAvailCerts(oid);
    renderAvailHeatmap();
  }

  // Staffing heatmap: officials × play-window days. A cell is green when the
  // official declared available, carries a ● when they're actually assigned that
  // day, and the footer tallies available/assigned per day so thin days pop out.
  async function renderAvailHeatmap() {
    const box = document.getElementById("avail-heatmap");
    if (!box || !getActive()) return;
    let g;
    try { g = await api(`/tournaments/${getActive().id}/availability/grid`); }
    catch (e) { box.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    if (!g.days.length) { box.innerHTML = '<p class="muted">This tournament has no play-date window set.</p>'; return; }
    if (!g.officials.length) { box.innerHTML = '<p class="muted">No availability declared and nobody assigned yet.</p>'; return; }
    const head = `<th class="hm-name">Official</th>` +
      g.days.map((d) => hstr`<th class="hm-day">${fmtDOW(d)}</th>`).join("");
    const body = g.officials.map((o) => {
      const avail = new Set(o.available), asg = new Set(o.assigned);
      const cells = g.days.map((d) => {
        const a = avail.has(d), s = asg.has(d);
        // assigned-but-not-declared-available is worth flagging (amber ring).
        const cls = ["hm-cell"];
        if (a) cls.push("hm-avail");
        if (s) cls.push("hm-asg");
        if (s && !a) cls.push("hm-asg-only");
        // Non-assigned cells are clickable to staff this official on this day.
        const click = !s;
        if (click) cls.push("hm-clickable");
        const attrs = click ? hstr` data-oid="${o.official_id}" data-date="${d}" data-name="${o.official_name}"` : "";
        const title = `${o.official_name} · ${fmtDOW(d)}: ` +
          (a ? "available" : "not declared") + (s ? ", assigned" : " — click to assign");
        return hstr`<td class="${cls.join(" ")}"${raw(attrs)} title="${title}">${s ? "●" : ""}</td>`;
      }).join("");
      const pid = hstr`<span class="hm-off${o.hotel_needed ? " hm-hotel" : ""}">${o.official_name}${o.hotel_needed ? raw(' <span class="hm-hotel-tag" title="needs hotel">🛏</span>') : ""}</span>`;
      return `<tr><th class="hm-name">${pid}</th>${cells}</tr>`;
    }).join("");
    const foot = `<th class="hm-name">Available / assigned</th>` +
      g.per_day.map((p) => {
        const thin = p.available_count === 0;
        return `<td class="hm-tot${thin ? " hm-thin" : ""}" title="${p.available_count} available, ${p.assigned_count} assigned">` +
          `${p.available_count}<span class="hm-sep">/</span>${p.assigned_count}</td>`;
      }).join("");
    box.innerHTML =
      `<table class="avail-heatmap"><thead><tr>${head}</tr></thead>` +
      `<tbody>${body}</tbody>` +
      `<tfoot><tr>${foot}</tr></tfoot></table>`;
  }

  // Click a heatmap cell → assign that official on that day. The role isn't in the
  // heatmap, so a small popover offers the official's held certifications (or the
  // full role list when they hold none); picking one runs coverage-fill.
  let _hmPop = null;
  function _closeHmPop() { if (_hmPop) { _hmPop.remove(); _hmPop = null; } }
  document.addEventListener("click", (e) => {
    const cell = e.target.closest && e.target.closest("#avail-heatmap .hm-clickable");
    if (!cell) { if (!e.target.closest || !e.target.closest(".cov-pop")) _closeHmPop(); return; }
    _openAssignCell(cell);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") _closeHmPop(); });

  async function _openAssignCell(cell) {
    _closeHmPop();
    if (!getActive()) return;
    const oid = Number(cell.dataset.oid), date = cell.dataset.date, name = cell.dataset.name;
    const pop = document.createElement("div");
    pop.className = "cov-pop";
    pop.innerHTML = hstr`<div class="cov-pop-head">${name} · ${fmtDOW(date)}</div><p class="muted">Loading…</p>`;
    document.body.appendChild(pop);
    _hmPop = pop;
    const r = cell.getBoundingClientRect();
    pop.style.top = `${window.scrollY + r.bottom + 4}px`;
    pop.style.left = `${window.scrollX + Math.min(r.left, window.innerWidth - 280)}px`;
    let held = [];
    try { held = await api(`/officials/${oid}/certifications`); }
    catch (_) {}
    if (_hmPop !== pop) return;
    // Offer the roles they're certified for; if none on file, the whole list (the
    // backend cert guard allows any role when no certs are recorded).
    const roles = held.length ? held.map((c) => c.cert_type) : getCertPairs().map(([v]) => v);
    const note = held.length ? "Assign as:" : "No certifications on file — assign as:";
    pop.innerHTML = html`<div class="cov-pop-head">Assign ${name} · ${fmtDOW(date)}</div><p class="cov-pop-note">${note}</p><ul class="cov-cand-list">${roles.map((role) =>
      html`<li class="cov-cand"><span class="cov-cand-name">${certLabel(role)}</span><button type="button" class="cov-fill-btn" data-role="${role}">Assign</button></li>`)}</ul>`;
    pop.querySelectorAll(".cov-fill-btn").forEach((btn) => btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/tournaments/${getActive().id}/coverage-fill`, {
          method: "POST",
          body: JSON.stringify({ official_id: oid, work_date: date, working_as: btn.dataset.role }),
        });
        toast(`Assigned ${name} as ${certLabel(btn.dataset.role)} on ${fmtDOW(date)}`, true);
        _closeHmPop();
        loadAvailability();
      } catch (err) { toast(err.message, false); btn.disabled = false; }
    }));
  }
  document.getElementById("avail-official").addEventListener("change", () => {
    renderAvailDates();
    renderAvailCerts(Number(document.getElementById("avail-official").value) || null);
  });
  document.getElementById("avail-save").addEventListener("click", async () => {
    if (!getActive()) return;
    const sel = document.getElementById("avail-official");
    if (!sel.value) { setMsg("avail-msg", "pick an official", false); return; }
    const dates = [...document.querySelectorAll("#avail-dates input:checked")].map((c) => c.value);
    try {
      await api(`/tournaments/${getActive().id}/availability`, {
        method: "PUT",
        body: JSON.stringify({ official_id: Number(sel.value), dates, hotel_needed: document.getElementById("avail-hotel").checked }),
      });
      setMsg("avail-msg", "saved", true);
      await loadAvailability();
    } catch (e) { setMsg("avail-msg", e.message, false); }
  });

  // Bulk date selection — toggles the day checkboxes in place (the user still
  // reviews + clicks Save, consistent with the manual flow). 0=Sun … 6=Sat via
  // getUTCDay (dates are midnight-UTC ISO strings, matching _datesInRange).
  function _availDow(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
  document.querySelectorAll("#panel-t-availability .avail-bulk [data-bulk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.bulk;
      const boxes = [...document.querySelectorAll("#avail-dates input")];
      if (!boxes.length) { setMsg("avail-msg", "no dates in the play window", false); return; }
      if (mode === "range") {
        const from = document.getElementById("avail-range-from").value;
        const to = document.getElementById("avail-range-to").value;
        if (!from || !to || from > to) { setMsg("avail-msg", "pick a valid from–to range", false); return; }
        // additive: ticks dates in range, leaves the rest as-is
        boxes.forEach((cb) => { if (cb.value >= from && cb.value <= to) cb.checked = true; });
      } else {
        boxes.forEach((cb) => {
          const dow = _availDow(cb.value);
          if (mode === "all") cb.checked = true;
          else if (mode === "none") cb.checked = false;
          else if (mode === "weekdays") cb.checked = dow >= 1 && dow <= 5;
          else if (mode === "weekends") cb.checked = dow === 0 || dow === 6;
        });
      }
      const n = boxes.filter((c) => c.checked).length;
      setMsg("avail-msg", `${n} day(s) selected — click Save availability`, true);
    });
  });


  return { loadAvailability };
}
