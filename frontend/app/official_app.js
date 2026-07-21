// Official self-service portal (assignments, availability, pay, profile) — D11.

export function createOfficialApp(ctx) {
  const {
    api, setMsg, toast, onSubmit, html, hstr, raw, money, esc,
    fmtDOW, certLabel, respChip, datesInRange,
  } = ctx;

  function availDow(iso) { return new Date(iso + "T00:00:00Z").getUTCDay(); }
  const ME_PROFILE_FIELDS = [
    "first_name", "last_name", "street", "city", "state", "zip",
    "phone", "email", "dietary_restrictions", "lat", "lng",
  ];
  let meOfficialGeo = { lat: null, lng: null };

  let meTournaments = [];
  async function officialInit() {
    const me = await api("/me");
    const o = me.official || {};
    meOfficialGeo = { lat: o.lat ?? null, lng: o.lng ?? null };
    for (const el of document.getElementById("me-form").elements) {
      if (el.name) el.value = o[el.name] == null ? "" : o[el.name];
    }
    meTournaments = await api("/me/tournaments");
    const sel = document.getElementById("me-tournament");
    sel.innerHTML = "";
    if (!meTournaments.length) {
      const op = document.createElement("option");
      op.value = ""; op.textContent = "— no tournaments yet —";
      sel.appendChild(op);
    } else {
      for (const t of meTournaments) {
        const op = document.createElement("option");
        op.value = t.id; op.textContent = `${t.name} (${t.play_start_date} → ${t.play_end_date})`;
        sel.appendChild(op);
      }
    }
    await loadMyAvailability();
    await loadMyAssignments();
    await loadMyPay();
  }
  async function loadMyPay() {
    const box = document.getElementById("me-pay");
    if (!box) return;
    let s;
    try { s = await api("/me/pay-summary"); } catch (_) { return; }
    if (!s.tournaments.length) { box.innerHTML = '<p class="muted">No assignments yet.</p>'; return; }
    const rows = s.tournaments.map((t) =>
      html`<tr><td>${t.tournament_name || ("Tournament " + t.tournament_id)}</td><td>${t.days}</td><td>${raw(respChip(t.response_status))}</td><td class="num">${money(t.pay)}</td><td class="num">${money(t.mileage)}</td><td class="num">${money(t.total)}</td></tr>`).join("");
    box.innerHTML = `<table class="list-table"><thead><tr><th>Tournament</th><th>Days</th><th>Status</th>` +
      `<th class="num">Pay</th><th class="num">Mileage</th><th class="num">Total</th></tr></thead><tbody>${rows}` +
      `<tr><th colspan="3">Season total — ${s.totals.assignments} assignment(s), ${s.totals.days} day(s)</th>` +
      `<th class="num">${money(s.totals.pay)}</th><th class="num">${money(s.totals.mileage)}</th>` +
      `<th class="num">${money(s.totals.total)}</th></tr></tbody></table>`;
  }
  async function loadMyAssignments() {
    const box = document.getElementById("me-assignments");
    if (!box) return;
    let rows = [];
    try { rows = await api("/me/assignments"); } catch (_) {}
    if (!rows.length) { box.innerHTML = '<p class="muted">No assignments yet.</p>'; return; }
    box.innerHTML = "";
    for (const a of rows) {
      const tname = (meTournaments.find((t) => t.id === a.tournament_id) || {}).name || `Tournament ${a.tournament_id}`;
      const days = a.days.map((d) => fmtDOW(d.work_date)).join(", ") || "—";
      const card = document.createElement("div"); card.className = "asg";
      // Pay/mileage the official actually cares about.
      const mileage = a.missing_distance ? "—" : (a.mileage == null ? "—" : "$" + a.mileage.toFixed(2));
      // Day-level issues the official should see and can act on (decline / contact
      // the TD): scheduled outside their availability, on a role they aren't
      // certified for, or double-booked with another tournament.
      const issues = [];
      for (const d of (a.days_outside_availability || [])) issues.push(`${fmtDOW(d)} — outside the dates you marked available`);
      for (const u of (a.uncertified_days || [])) issues.push(`${fmtDOW(u.work_date)} — ${certLabel(u.working_as)}, which isn't in your certifications`);
      // plain text — escaped once when rendered (issuesHtml below). (Previously
      // esc()'d here AND again via issues.map(esc) — a latent double-escape.)
      if (a.has_conflict) for (const c of (a.conflicts || [])) issues.push(`${fmtDOW(c.work_date)} — also booked at ${c.other_tournament}`);
      const issuesHtml = issues.length
        ? html`<div class="asg-flags">⚠ Heads-up: ${issues.join("; ")}.</div>` : "";
      const prompt = a.response_status === "pending"
        ? '<div class="asg-prompt">Please <strong>accept</strong> or <strong>decline</strong> below.</div>' : "";
      const card_head = html`<div class="asg-head"><strong>${tname}</strong> ${raw(respChip(a.response_status))}<div class="asg-meta">site: ${a.site_label || "—"} · days: ${days} · pay $${a.pay.toFixed(2)} · mileage ${mileage}</div></div>`;
      card.innerHTML = `${card_head}${prompt}${issuesHtml}`;
      const actions = document.createElement("div"); actions.className = "add-day";
      const mk = (status, txt, danger) => {
        const b = document.createElement("button"); b.type = "button";
        b.className = "btn-link" + (danger ? " danger" : ""); b.textContent = txt;
        b.disabled = a.response_status === status;
        b.addEventListener("click", async () => {
          try { await api(`/me/assignments/${a.id}/respond`, { method: "POST", body: JSON.stringify({ status }) });
            toast(`Marked ${status}`, true); loadMyAssignments(); }
          catch (e) { toast(e.message, false); }
        });
        return b;
      };
      actions.append(mk("accepted", "Accept"), mk("declined", "Decline", true));
      if (a.response_status !== "pending") actions.append(mk("pending", "Clear"));
      card.appendChild(actions);
      box.appendChild(card);
    }
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
    for (const d of datesInRange(t.play_start_date, t.play_end_date)) {
      const lbl = document.createElement("label"); lbl.className = "chip";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = d; cb.checked = checked.has(d);
      lbl.append(cb, document.createTextNode(" " + fmtDOW(d)));
      box.appendChild(lbl);
    }
  }

  // Quick-select for the official's own availability grid (mirrors the admin
  // editor's bulk buttons): toggle the #me-dates checkboxes in place; the official
  // still reviews + clicks Save.
  document.querySelectorAll("#official-app .avail-bulk [data-mebulk]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mebulk;
      document.querySelectorAll("#me-dates input").forEach((cb) => {
        const dow = availDow(cb.value);  // 0=Sun … 6=Sat
        if (mode === "all") cb.checked = true;
        else if (mode === "none") cb.checked = false;
        else if (mode === "weekdays") cb.checked = dow >= 1 && dow <= 5;
        else if (mode === "weekends") cb.checked = dow === 0 || dow === 6;
      });
    });
  });

  // Cached from last /me load so a profile Save that only posts form fields
  // cannot null out geocoded lat/lng (walkthrough: form has no lat/lng inputs).
  onSubmit(document.getElementById("me-form"), async (e) => {
    const b = {};
    for (const el of e.target.elements) {
      if (!el.name) continue;
      if (!ME_PROFILE_FIELDS.includes(el.name)) continue;  // ignore stray inputs
      b[el.name] = el.value === "" ? null : el.value;
    }
    // Preserve coordinates the form doesn't expose.
    if (b.lat == null) b.lat = meOfficialGeo.lat;
    if (b.lng == null) b.lng = meOfficialGeo.lng;
    try {
      await api("/me/profile", { method: "PUT", body: JSON.stringify(b) });
      setMsg("me-msg", "saved", true);
    } catch (err) { setMsg("me-msg", err.message, false); }
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

  return { officialInit, loadMyAssignments, loadMyAvailability, loadMyPay };
}
