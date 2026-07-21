// Player / Official 360 drawer — D11.

export function createPlayer360(ctx) {
  const {
    api, toast, html, hstr, raw, esc, money, fmtDOW, fmtMDY, certLabel, respChip, chip,
    printDoc, getActive,
  } = ctx;
  void chip; void esc;

  // --- Player 360 drawer: everything about one player, unified by USTA # ---
  const _p360Modal = document.getElementById("player360-modal");
  function _closePlayer360() { if (_p360Modal) _p360Modal.hidden = true; }
  document.getElementById("player360-close")?.addEventListener("click", _closePlayer360);
  _p360Modal?.addEventListener("click", (e) => { if (e.target.id === "player360-modal") _closePlayer360(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && _p360Modal && !_p360Modal.hidden) _closePlayer360(); });
  async function openPlayer360(playerId, tournamentId) {
    const body = document.getElementById("player360-body");
    document.getElementById("player360-title").textContent = "Player";
    body.innerHTML = '<p class="muted">Loading…</p>';
    _p360Modal.hidden = false;
    let d;
    try {
      const q = tournamentId ? `?tournament_id=${tournamentId}` : "";
      d = await api(`/players/${playerId}/overview${q}`);
    } catch (e) { body.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    const p = d.player;
    document.getElementById("player360-title").textContent = `${p.last_name}, ${p.first_name}`;
    const loc = [p.city, p.state].filter(Boolean).join(", ");
    // html`` auto-escapes the cell/field values; per-row templates are joined to a
    // string and the pre-built pieces are raw()'d into the final body (one html``
    // template + html`` would double-escape — see the helper's docs).
    const entriesHtml = d.entries.length
      ? `<table class="list-table p360-table"><thead><tr><th>Tournament</th><th>Status</th><th>Div</th><th>T-shirt</th><th>Lodging</th></tr></thead><tbody>` +
        d.entries.map((e) => html`<tr><td>${e.tournament_name}</td><td>${raw(chip(e.selection_status))}</td><td>${e.age_division || ""}</td><td>${e.t_shirt_size || ""}</td><td>${e.lodging_plan || ""}</td></tr>`).join("") +
        `</tbody></table>`
      : '<p class="muted">Not on any roster.</p>';
    const r = d.requests;
    const sec = (title, rows, fmt) => rows.length
      ? html`<div class="p360-sec"><h4>${title} (${rows.length})</h4><ul>${rows.map((x) => html`<li>${fmt(x)}</li>`)}</ul></div>` : "";
    const reqHtml =
      sec("Late entries", r.late_entries, (x) => html`${x.age_division || ""} ${x.events || ""}${x.request_date ? html` · ${x.request_date}` : ""}`) +
      sec("Withdrawals", r.withdrawals, (x) => html`${x.events || ""} — ${x.reason || "(alternate, no reason)"}${x.was_alternate ? " · was alternate" : ""}`) +
      sec("Scheduling avoidances", r.scheduling, (x) => html`avoid ${x.avoid_day || ""} ${x.avoid_time_range || ""}`) +
      sec("Division flexibility", r.division_flex, (x) => html`${x.home_division || ""} → ${x.willing_divisions || ""}`) +
      sec("Player hotels", r.hotels, (x) => html`${x.hotel_name || ""} ${x.lodging_plan || ""}`) +
      sec("Doubles", r.doubles, (x) => html`${x.age_division || ""} · ${x.wants_random ? "random" : "partner " + (x.partner_usta || "?")} · ${x.status || ""}`) +
      sec("Pairing avoidances", r.pairing, (x) => html`${x.age_division || ""} ${x.relationship || ""}`);
    body.innerHTML = html`<p class="p360-id">USTA #${p.usta_number || "—"}${p.gender ? html` · ${p.gender}` : ""}${loc ? html` · ${loc}` : ""}</p><h4>Tournament entries</h4>${raw(entriesHtml)}${
      reqHtml
        ? html`<h4 class="p360-reqhead">Requests${d.tournament_id ? " (this tournament)" : ""}</h4>${raw(reqHtml)}`
        : raw(`<p class="muted">No filed requests${d.tournament_id ? " for this tournament" : ""}.</p>`)
    }`;
    _p360Export = { title: `${p.last_name}, ${p.first_name}`, subtitle: "Player profile", html: body.innerHTML };
  }

  // Official 360 — reuses the player drawer modal to show an official's certs +
  // season assignments/pay (the search lands here for an official result).
  async function openOfficial360(officialId) {
    const body = document.getElementById("player360-body");
    document.getElementById("player360-title").textContent = "Official";
    body.innerHTML = '<p class="muted">Loading…</p>';
    _p360Modal.hidden = false;
    let d;
    try { d = await api(`/officials/${officialId}/overview`); }
    catch (e) { body.innerHTML = hstr`<p class="msg bad">${e.message}</p>`; return; }
    const o = d.official;
    document.getElementById("player360-title").textContent = `${o.last_name}, ${o.first_name} · official`;
    const loc = [o.city, o.state].filter(Boolean).join(", ");
    const certs = d.certs.length
      ? d.certs.map((c) => hstr`<span class="badge badge-info">${certLabel(c)}</span>`).join(" ")
      : '<span class="muted">no certifications on file</span>';
    const tt = d.pay.totals;
    const asg = d.pay.tournaments.length
      ? html`<table class="list-table p360-table"><thead><tr><th>Tournament</th><th>Days</th><th class="num">Pay</th><th class="num">Mileage</th><th class="num">Total</th><th>Response</th></tr></thead><tbody>${
          d.pay.tournaments.map((t) => html`<tr><td>${t.tournament_name}</td><td>${t.days}</td><td class="num">${money(t.pay)}</td><td class="num">${money(t.mileage)}</td><td class="num">${money(t.total)}</td><td>${raw(respChip(t.response_status))}</td></tr>`)
        }<tr class="totals"><td>Season totals (${tt.assignments} assignment${tt.assignments === 1 ? "" : "s"})</td><td>${tt.days}</td><td class="num">${money(tt.pay)}</td><td class="num">${money(tt.mileage)}</td><td class="num">${money(tt.total)}</td><td></td></tr></tbody></table>`
      : raw('<p class="muted">No assignments yet.</p>');
    const payBtn = tt.assignments
      ? html`<p><button type="button" id="off-pay-statement" class="btn-small" data-oid="${officialId}" data-name="${o.last_name}, ${o.first_name}">⬇ Pay statement (PDF)</button></p>`
      : "";
    body.innerHTML = html`<p class="p360-id">Official${loc ? html` · ${loc}` : ""}</p><h4>Certifications</h4><p>${raw(certs)}</p><h4>Assignments &amp; pay</h4>${asg}${payBtn}`;
    _p360Export = { title: `${o.last_name}, ${o.first_name}`, subtitle: "Official profile", html: body.innerHTML };
    document.getElementById("off-pay-statement")?.addEventListener("click", (e) =>
      exportPayStatement(Number(e.currentTarget.dataset.oid)));
  }

  // Reimbursement pay statement → print window (day-level rates + mileage), reusing
  // the report print-window pattern. No PDF lib.
  async function exportPayStatement(officialId) {
    let d;
    try { d = await api(`/officials/${officialId}/pay-statement`); }
    catch (e) { toast(e.message, false); return; }
    const e = esc, off = d.official, tt = d.totals;
    const sections = d.assignments.length ? d.assignments.map((a) => {
      const dayRows = a.days.map((x) =>
        `<tr><td>${e(fmtMDY(x.work_date))}</td><td>${e(certLabel(x.working_as))}</td>` +
        `<td class="num">${money(x.rate_applied)}</td></tr>`).join("") ||
        `<tr><td colspan="3" class="muted">No worked days.</td></tr>`;
      const mileage = a.missing_distance ? "—  (no distance on file)"
        : `${money(a.mileage)}${a.one_way_miles != null ? `  (${a.one_way_miles} mi one-way${a.mileage === 0 ? ", within free 50 mi" : ""})` : ""}`;
      return `<h2>${e(a.tournament_name)}${a.site_label ? ` · ${e(a.site_label)}` : ""}</h2>` +
        `<table><thead><tr><th>Date</th><th>Role</th><th class="num">Rate</th></tr></thead>` +
        `<tbody>${dayRows}</tbody></table>` +
        `<p class="line">Pay: <strong>${money(a.pay)}</strong> · Mileage: <strong>${mileage}</strong>` +
        ` · Assignment total: <strong>${money(a.total)}</strong></p>`;
    }).join("") : `<p class="muted">No assignments on file.</p>`;
    printDoc({
      title: `Pay statement — ${off.name}`,
      styleExtra: `
        .grand { margin-top: 1rem; padding: 0.5rem 0.7rem; background: #e7f1ea; border: 1px solid #2e6f40; border-radius: 6px; font-size: 13px; }`,
      body: `
      <h1>Officiating pay statement</h1>
      <div class="sub">${e(off.name)}${off.location ? ` · ${e(off.location)}` : ""}` +
        `${off.email ? ` · ${e(off.email)}` : ""}${off.phone ? ` · ${e(off.phone)}` : ""}` +
        ` · generated ${e(fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
      ${sections}
      <div class="grand"><strong>Grand total: ${money(tt.total)}</strong> ` +
        `(pay ${money(tt.pay)} + mileage ${money(tt.mileage)}) · ${tt.days} day(s) across ${tt.assignments} assignment(s)</div>`,
    });
  }

  // Print/PDF the currently-open 360 drawer (player or official) — reuses the
  // staffing-report print-window pattern: a clean, self-contained doc that
  // auto-prints so the TD saves it as a one-page PDF. No PDF lib.
  let _p360Export = null;
  function exportP360() {
    if (!_p360Export) { toast("Open a profile first", false); return; }
    const { title, subtitle, html } = _p360Export;
    printDoc({
      title: `${subtitle} — ${title}`,
      styleExtra: `
        h4 { font-size: 13px; margin: 1rem 0 0.3rem; border-bottom: 1.5px solid #2e6f40; padding-bottom: 0.15rem; color: #2e6f40; }
        .p360-id { color: #556070; font-size: 12px; }
        ul { margin: 0.2rem 0 0.6rem; padding-left: 1.2rem; }
        .badge { display: inline-block; padding: 1px 6px; border: 1px solid #ccd; border-radius: 5px; font-size: 10px; }
        .p360-link { display: none; }  /* the 👤 affordance has no meaning on paper */`,
      body: `
      <h1>${esc(title)}</h1>
      <div class="sub">${esc(subtitle)} · generated ${esc(fmtMDY(new Date().toISOString().slice(0, 10)))}</div>
      ${html}`,
    });
  }
  document.getElementById("player360-print")?.addEventListener("click", exportP360);


  return { openPlayer360, openOfficial360, exportP360, exportPayStatement };
}
