// Assignments panel — load, render cards, bulk invite (D11).
import { datesInRange as datesInRangeUtil } from "./util.js";

export function createAssignmentsPanel(ctx) {
  const {
    api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit, openForm,
    html, hstr, raw, esc, money, fmtDOW, fillSelect, officialLabel, siteLabel,
    certLabel, chip, makeMenuButton, scheduleComboSync, prereqCallout,
    makeListGrid, getActive, getOfficialsById, getSitesById, getHotelsById,
    getCertPairs, datesInRange: datesInRangeFn,
  } = ctx;
  const datesInRange = datesInRangeFn || datesInRangeUtil;
  void makeListGrid; void getHotelsById; void getSitesById; void esc;

  // =================== Assignment change history (P4-5) ===================
  const _AUDIT_LABEL = {
    created: "Assignment created", updated: "Assignment updated",
    deleted: "Assignment deleted", day_added: "Day added",
    day_removed: "Day removed", day_status: "Day-of status set",
    response: "Official responded",
  };
  function _auditDetail(row) {
    const d = row.detail || {};
    const bits = [];
    if (d.work_date) bits.push(fmtDOW(d.work_date));
    if (d.working_as) bits.push(certLabel(d.working_as));
    if (d.actual_status) bits.push(d.actual_status.replace("_", " "));
    if (d.status) bits.push(d.status);
    if (d.via) bits.push(`via ${d.via}`);
    if (row.action === "updated") {
      if (d.site_id != null) bits.push(`site #${d.site_id}`);
      if (d.room_block_id != null) bits.push(`room block #${d.room_block_id}`);
    }
    return bits.join(" · ");
  }
  async function showAssignmentHistory(a) {
    let rows;
    try { rows = await api(`/assignments/${a.id}/audit`); }
    catch (e) { toast(e.message, false); return; }
    let m = document.getElementById("asg-history-modal");
    if (!m) {
      m = document.createElement("div"); m.id = "asg-history-modal"; m.className = "modal"; m.hidden = true;
      m.innerHTML = '<div class="modal-box modal-box--wide" role="dialog" aria-modal="true" aria-labelledby="asg-hist-title">' +
        '<h3 id="asg-hist-title" class="detail-title"></h3>' +
        '<div id="asg-hist-body" style="max-height:60vh;overflow:auto"></div>' +
        '<div class="modal-actions"><button type="button" id="asg-hist-close">Close</button></div></div>';
      document.body.appendChild(m);
      m.querySelector("#asg-hist-close").addEventListener("click", () => { m.hidden = true; });
      m.addEventListener("click", (e) => { if (e.target === m) m.hidden = true; });
      document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !m.hidden) m.hidden = true; });
    }
    m.querySelector("#asg-hist-title").textContent = `History — ${a.official_name}`;
    const body = m.querySelector("#asg-hist-body");
    if (!rows.length) {
      body.innerHTML = '<p class="muted">No recorded changes yet (the trail starts with migration 0044 — earlier edits predate it).</p>';
    } else {
      body.innerHTML = html`<table class="list-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>${
        rows.map((r) => html`<tr><td>${new Date(r.changed_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td><td>${r.changed_by}</td><td>${_AUDIT_LABEL[r.action] || r.action}</td><td class="muted">${_auditDetail(r)}</td></tr>`)
      }</tbody></table>`;
    }
    m.hidden = false;
  }

  // --- Assignments ---
  const asgForm = document.getElementById("asg-form");
  let asgEditId = null;
  // Response-status filter chips (re-render from memory, no refetch).
  document.querySelectorAll("#asg-respbar .chip-toggle").forEach((btn) => {
    btn.addEventListener("click", () => { _asgRespFilter = btn.dataset.resp; _renderAsgList(); });
  });
  // True when a work date falls outside the active tournament's play window.
  // Audit M23: string-compare only when all three values are valid `YYYY-MM-DD`
  // (the API always returns this form; defensive against any future drift).
  const _ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  function _outOfWindow(d) {
    if (!getActive() || !d) return false;
    if (!_ISO_DATE.test(d) || !_ISO_DATE.test(getActive().play_start_date)
        || !_ISO_DATE.test(getActive().play_end_date)) return false;
    return d < getActive().play_start_date || d > getActive().play_end_date;
  }
  async function loadAssignments() {
    if (!getActive()) return;
    prereqCallout("panel-t-assignments", !Object.keys(getOfficialsById()).length,
      "No officials in the catalog yet — add them (with certifications) before assigning.",
      "tab-panel-officials");
    // Mileage site must be one of THIS tournament's sites (audit §3 — not any site).
    // Audit M15 + N14: fire all four fetches in parallel; allSettled so one
    // failure doesn't blank the whole panel.
    const results = await Promise.allSettled([
      api(`/tournaments/${getActive().id}/sites`),
      api(`/room-blocks?tournament_id=${getActive().id}&kind=official`),
      api(`/tournaments/${getActive().id}/assignments`),
      api(`/tournaments/${getActive().id}/availability`),
    ]);
    const [tSitesR, rbListR, listR, availR] = results;
    const tSites = tSitesR.status === "fulfilled" ? tSitesR.value : [];
    const rbList = rbListR.status === "fulfilled" ? rbListR.value : [];
    const list = listR.status === "fulfilled" ? listR.value : [];
    const avail = availR.status === "fulfilled" ? availR.value : [];
    for (const r of results) if (r.status === "rejected") toast(r.reason.message, false);
    fillSelect(document.getElementById("asg-site"), tSites, siteLabel);
    fillSelect(document.getElementById("asg-room-block"), rbList, (b) => {
      const hn = getHotelsById()[b.hotel_id] ? getHotelsById()[b.hotel_id].name : "hotel " + b.hotel_id;
      return `${hn} (${b.rooms_remaining}/${b.room_count} left)`;
    });
    const availByOfficial = {};
    for (const r of avail) (availByOfficial[r.official_id] ||= []).push(r.available_date);
    // Surface availability in the official picker for this tournament.
    fillSelect(document.getElementById("asg-official"), Object.values(getOfficialsById()), (o) => {
      const n = (availByOfficial[o.id] || []).length;
      return `${officialLabel(o)} — ${n ? n + " avail day(s)" : "no availability"}`;
    }, false);
    // Reset the response-status filter when the active tournament changes, so a
    // 'declined' filter from tournament A doesn't strand tournament B's list
    // behind a now-empty, disabled-but-on chip. Persists across same-tournament
    // reloads (e.g. after an accept/decline) so an in-progress filter survives.
    if (_asgFilterTid !== getActive().id) { _asgRespFilter = "all"; _asgFilterTid = getActive().id; }
    // Unassigned-availability nudge: officials who declared availability but have
    // no assigned working day yet — surfaced HERE (where staffing happens) with a
    // jump to the Availability tab. Mirrors the Availability tab's gap callout.
    const assignedWithDays = new Set(list.filter((a) => a.days && a.days.length).map((a) => a.official_id));
    const availableUnassigned = Object.keys(availByOfficial)
      .map(Number)
      .filter((oid) => !assignedWithDays.has(oid));
    const nudge = document.getElementById("asg-avail-nudge");
    if (availableUnassigned.length) {
      const names = availableUnassigned
        .map((oid) => (getOfficialsById()[oid] ? officialLabel(getOfficialsById()[oid]) : `#${oid}`))
        .sort();
      nudge.hidden = false;
      nudge.innerHTML = `⚠ ${availableUnassigned.length} available official(s) not yet assigned: ` +
        `<strong>${names.map(esc).join("; ")}</strong>. ` +
        `<a href="#" id="asg-nudge-link">Open Availability →</a>`;
      const link = document.getElementById("asg-nudge-link");
      if (link) link.addEventListener("click", (e) => {
        e.preventDefault();
        const t = document.querySelector('[data-group="tournament"]');
        if (t) t.click();
        const tab = document.querySelector('[data-target="panel-t-availability"]');
        if (tab) tab.click();
      });
    } else { nudge.hidden = true; nudge.textContent = ""; }

    const box = document.getElementById("asg-list");
    box.innerHTML = "";
    // Audit P42: match the Tabulator placeholder styling so empty states across
    // the app look the same (✦ icon + centered muted text).
    if (list.length === 0) {
      document.getElementById("asg-respbar").hidden = true;
      box.innerHTML = '<div class="grid-empty"><span class="grid-empty-icon" aria-hidden="true">✦</span> No officials assigned yet — click <strong>+ Assign official</strong> above to start.</div>';
      return;
    }
    // Stash the list + availability so the response-status filter can re-render
    // without re-fetching, and so the TD can jump straight to declines to re-staff.
    _asgState = { list, availByOfficial };
    _renderBulkInvite(new Set(list.map((a) => a.official_id)), availByOfficial);
    _renderAsgList();
    _renderNoLogin();
  }

  // Assigned officials with no self-service login can't accept/decline, so their
  // assignments sit pending forever — flag them with a jump to Officials setup
  // (where the TD creates the login).
  async function _renderNoLogin() {
    const box = document.getElementById("asg-nologin");
    if (!box || !getActive()) return;
    let d;
    try { d = await api(`/tournaments/${getActive().id}/officials-without-login`); }
    catch (_) { box.hidden = true; return; }
    if (!d.count) { box.hidden = true; box.innerHTML = ""; return; }
    const names = d.officials.map((o) =>
      hstr`${o.official_name}${o.has_email ? "" : raw(' <span class="muted">(no email)</span>')}`).join("; ");
    box.hidden = false;
    box.innerHTML = html`<span class="asg-nologin-text">🔑 ${d.count} assigned official${d.count === 1 ? "" : "s"} can't accept/decline — no login: <strong>${raw(names)}</strong>.</span> <button type="button" id="asg-nologin-go" class="btn-small">Set up logins →</button>`;
    document.getElementById("asg-nologin-go")?.addEventListener("click", () =>
      _dashGo("setup", "panel-officials"));
  }

  // Bulk invite: pick several not-yet-assigned officials and create a pending
  // assignment for each in one call (POST .../assignments/bulk), then offer a
  // single mailto to everyone who was just invited. Officials already on the
  // tournament are excluded from the picker (they're already in the response loop).
  function _renderBulkInvite(assignedIds, availByOfficial) {
    const box = document.getElementById("asg-bulk-list");
    if (!box) return;
    const candidates = Object.values(getOfficialsById())
      .filter((o) => !assignedIds.has(o.id))
      .sort((a, b) => officialLabel(a).localeCompare(officialLabel(b)));
    const summary = document.querySelector("#asg-bulk > summary");
    if (summary) summary.textContent = `＋ Invite several officials at once (${candidates.length} available)`;
    if (!candidates.length) {
      box.innerHTML = '<p class="muted">Every official is already assigned to this tournament.</p>';
    } else {
      box.innerHTML = candidates.map((o) => {
        const n = (availByOfficial[o.id] || []).length;
        const avail = n ? `${n} avail day(s)` : "no availability";
        return hstr`<label class="bulk-row"><input type="checkbox" class="bulk-cb" value="${o.id}" data-label="${officialLabel(o).toLowerCase()}" /><span class="bulk-name">${officialLabel(o)}</span><span class="bulk-meta">${avail}</span></label>`;
      }).join("");
    }
    _bulkSyncCount();
  }

  function _bulkSyncCount() {
    const sel = document.querySelectorAll("#asg-bulk-list .bulk-cb:checked").length;
    const el = document.getElementById("asg-bulk-count");
    if (el) el.textContent = `${sel} selected`;
    const go = document.getElementById("asg-bulk-go");
    if (go) go.disabled = sel === 0;
  }

  // "✉ Invite all": fetch a personalised invite for every assigned official, copy
  // the combined document to the clipboard, and (when emails are on file) offer a
  // BCC-all mailto for the whole panel.
  document.getElementById("asg-invite-all")?.addEventListener("click", async () => {
    if (!getActive()) return;
    let d;
    try { d = await api(`/tournaments/${getActive().id}/invite-texts`); }
    catch (e) { toast(e.message, false); return; }
    if (!d.count) { toast("No officials assigned yet", false); return; }
    const combined = d.invites.map((i) =>
      `=== ${i.official_name}${i.official_email ? ` <${i.official_email}>` : " (no email on file)"} ===\n` +
      `Subject: ${i.subject}\n\n${i.body}`).join("\n\n----------------------------------------\n\n");
    try { await navigator.clipboard.writeText(combined); } catch (_) {}
    const action = d.emails.length ? {
      label: `BCC ${d.emails.length} →`,
      onClick: () => {
        const subj = encodeURIComponent(`Officiating assignment — ${getActive().name}`);
        window.open(`mailto:?bcc=${encodeURIComponent(d.emails.join(","))}&subject=${subj}`, "_blank");
      },
    } : null;
    toast(`Copied ${d.count} personalised invite${d.count === 1 ? "" : "s"} to the clipboard` +
      (d.emails.length ? "" : " (no emails on file)"), true, action);
  });

  // --- Bulk-invite controls (wired once; list is repopulated per loadAssignments) ---
  (() => {
    const list = document.getElementById("asg-bulk-list");
    const filter = document.getElementById("asg-bulk-filter");
    if (!list) return;
    list.addEventListener("change", (e) => { if (e.target.classList.contains("bulk-cb")) _bulkSyncCount(); });
    if (filter) filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      list.querySelectorAll(".bulk-row").forEach((r) => {
        const cb = r.querySelector(".bulk-cb");
        r.hidden = q.length > 0 && !cb.dataset.label.includes(q);
      });
    });
    document.getElementById("asg-bulk-all")?.addEventListener("click", () => {
      list.querySelectorAll(".bulk-row:not([hidden]) .bulk-cb").forEach((cb) => { cb.checked = true; });
      _bulkSyncCount();
    });
    document.getElementById("asg-bulk-none")?.addEventListener("click", () => {
      list.querySelectorAll(".bulk-cb").forEach((cb) => { cb.checked = false; });
      _bulkSyncCount();
    });
    document.getElementById("asg-bulk-go")?.addEventListener("click", async () => {
      if (!getActive()) return;
      const ids = [...list.querySelectorAll(".bulk-cb:checked")].map((cb) => Number(cb.value));
      if (!ids.length) return;
      const go = document.getElementById("asg-bulk-go");
      go.disabled = true;
      try {
        const r = await api(`/tournaments/${getActive().id}/assignments/bulk`, {
          method: "POST", body: JSON.stringify({ official_ids: ids }),
        });
        let msg = `Invited ${r.created_count} official${r.created_count === 1 ? "" : "s"}`;
        if (r.skipped_existing.length) msg += ` · ${r.skipped_existing.length} already assigned`;
        // Offer a single mailto to everyone who was just invited and has an email.
        if (r.invite_emails.length) {
          const subj = encodeURIComponent(`Officiating assignment — ${getActive().name}`);
          const bodyTxt = encodeURIComponent(`You've been assigned to ${getActive().name}. Please confirm (accept or decline) via your CourtOps self-service "My assignments" page. Thank you.`);
          const href = `mailto:?bcc=${encodeURIComponent(r.invite_emails.join(","))}&subject=${subj}&body=${bodyTxt}`;
          toast(msg, true, { label: `✉ Email ${r.invite_emails.length} invited`, onClick: () => window.open(href, "_blank") });
        } else {
          toast(msg, true);
        }
        document.getElementById("asg-bulk").open = false;
        if (filter) filter.value = "";
        loadAssignments();
      } catch (e) {
        setMsg("asg-bulk-msg", e.message, false);
        go.disabled = false;
      }
    });
  })();

  // Response-status filter ('all' | 'pending' | 'accepted' | 'declined') + the
  // fetched assignment list, kept module-level so toggling a filter re-renders
  // from memory (no refetch). Declines sort first within the active filter so the
  // TD sees what needs re-staffing without scrolling.
  let _asgRespFilter = "all";
  let _asgFilterTid = null;  // tournament the current filter applies to
  let _asgState = null;
  const _RESP_ORDER = { declined: 0, pending: 1, accepted: 2 };
  function _renderAsgList() {
    if (!_asgState) return;
    const { list, availByOfficial } = _asgState;
    const counts = { all: list.length, pending: 0, accepted: 0, declined: 0 };
    for (const a of list) counts[a.response_status] = (counts[a.response_status] || 0) + 1;
    // Summary line — declines highlighted as the actionable number. When there are
    // pending responders with an email on file, offer a one-click "chase" mailto
    // that BCCs all of them so the TD can nudge non-responders before the event.
    const pendingEmails = [...new Set(list
      .filter((a) => a.response_status === "pending" && a.official_email)
      .map((a) => a.official_email))];
    let chase = "";
    if (pendingEmails.length) {
      const subj = encodeURIComponent(`Assignment confirmation needed — ${getActive().name}`);
      const bodyTxt = encodeURIComponent(`Please confirm (accept or decline) your assignment for ${getActive().name} via your CourtOps self-service "My assignments" page. Thank you.`);
      const href = `mailto:?bcc=${encodeURIComponent(pendingEmails.join(","))}&subject=${subj}&body=${bodyTxt}`;
      chase = ` · <a href="${href}" class="chase-link">✉ Email ${pendingEmails.length} pending</a>`;
    }
    const sum = document.getElementById("asg-resp-summary");
    sum.innerHTML = `${counts.all} assigned · <span class="resp-ok">${counts.accepted} accepted</span> · ` +
      `${counts.pending} pending · <span class="${counts.declined ? "resp-bad" : ""}">${counts.declined} declined</span>` +
      (counts.declined ? " — needs re-staffing" : "") + chase;
    document.getElementById("asg-respbar").hidden = false;
    // Reflect counts on the filter chips + active state.
    document.querySelectorAll("#asg-respbar .chip-toggle").forEach((btn) => {
      const k = btn.dataset.resp;
      btn.classList.toggle("is-on", k === _asgRespFilter);
      const n = counts[k] ?? 0;
      btn.disabled = k !== "all" && n === 0;
    });
    const box = document.getElementById("asg-list");
    box.innerHTML = "";
    const shown = list
      .filter((a) => _asgRespFilter === "all" || a.response_status === _asgRespFilter)
      .sort((x, y) => (_RESP_ORDER[x.response_status] ?? 3) - (_RESP_ORDER[y.response_status] ?? 3));
    if (!shown.length) {
      box.innerHTML = hstr`<div class="grid-empty"><span class="grid-empty-icon" aria-hidden="true">✦</span> No ${_asgRespFilter} assignments.</div>`;
      return;
    }
    for (const a of shown) box.appendChild(renderAssignment(a, (availByOfficial[a.official_id] || []).sort()));
  }
  // Official accept/decline status → a colored chip (TD card + self-service).
  const _RESP_META = { pending: ["muted", "⏳ pending"], accepted: ["ok", "✓ accepted"], declined: ["bad", "✗ declined"] };
  function respChip(status) {
    const [cls, label] = _RESP_META[status] || ["muted", status || ""];
    return hstr`<span class="badge badge-${cls}" title="official's accept/decline">${label}</span>`;
  }
  function renderAssignment(a, availDates) {
    const card = document.createElement("div");
    card.className = "asg";
    // Structured header: name + actions on top; venue/hotel meta line; then
    // pay/mileage/total badges and any flags as colored chips (no run-on line).
    // Mileage = $0 with a distance ON FILE is legitimate (the first 50 round-trip
    // miles are free), but reads like a broken/missing calc — distinguish it from
    // the genuine "no distance" state with a hint (E2E finding F1).
    const mileage = a.missing_distance ? '<span class="warn">no distance</span>'
      : (a.mileage == null ? "—"
         : (a.mileage === 0 && a.one_way_miles != null
            ? hstr`$0.00 <span class="muted" title="${"Within the first 50 free round-trip miles (" + a.one_way_miles + " mi one-way) — no mileage owed."}">(free band)</span>`
            : "$" + a.mileage.toFixed(2)));
    // Cross-tournament double-booking (a warning, not a block — audit §3.4). A
    // different-site clash is impossible (badge-bad); same/no site is a soft
    // heads-up (badge-warn). Tooltip lists where else the official is booked.
    const conflictTitle = "Also booked the same day — " + (a.conflicts || []).map(
      (c) => `${c.work_date}${c.other_site ? ` @ ${c.other_site}` : ""} (${c.other_tournament})`
    ).join("; ");
    const flagChips = [
      a.has_conflict ? hstr`<span class="badge badge-${a.has_hard_conflict ? "bad" : "warn"}" title="${conflictTitle}">⚠ double-booked</span>` : "",
      a.hotel_date_mismatch ? '<span class="badge badge-warn">⚠ hotel dates</span>' : "",
      a.work_date_out_of_window ? '<span class="badge badge-warn">⚠ off-window day</span>' : "",
      (a.days_outside_availability && a.days_outside_availability.length)
        ? hstr`<span class="badge badge-warn" title="${"Worked on day(s) the official did not declare available: " + a.days_outside_availability.join(", ")}">⚠ not available</span>` : "",
      (a.uncertified_days && a.uncertified_days.length)
        ? hstr`<span class="badge badge-bad" title="${"Assigned a role the official isn't certified for: " + a.uncertified_days.map((u) => certLabel(u.working_as) + " on " + u.work_date).join("; ")}">⚠ not certified</span>` : "",
      a.missing_distance ? '<span class="badge badge-muted">no distance</span>' : "",
      // Day-of truth (P4-1): pay already excludes these days; the badge says why.
      a.no_show_days ? `<span class="badge badge-bad" title="No-show day(s) are excluded from pay">✗ ${a.no_show_days} no-show</span>` : "",
    ].filter(Boolean).join(" ");
    // Money audit (§5.3): a tooltip on the total badge showing the FROZEN calc
    // inputs (miles + rule constants) so the TD can see how a figure was reached.
    const pa = a.pay_audit;
    // Plain (unescaped) string; the title attribute is escaped where it's built
    // (hstr fragment in the head template below).
    const auditTip = pa
      ? `Frozen audit — ${pa.rule_version || ""} · ` +
        `miles ${pa.one_way_miles ?? "—"} · rate $${pa.constants?.mileage_rate}/mi · ` +
        `first ${pa.constants?.free_miles}mi free · cap $${pa.constants?.mileage_cap} · ` +
        `pay $${pa.pay} + mileage $${pa.mileage ?? 0} = $${pa.total}`
      : "";
    const head = document.createElement("div"); head.className = "asg-head";
    // Contact line — shown for pending responders so the TD can chase directly
    // (mailto/tel). Hidden once accepted/declined to keep the card uncluttered.
    let contact = "";
    if (a.response_status === "pending" && (a.official_email || a.official_phone)) {
      const parts = [];
      if (a.official_email) parts.push(hstr`<a href="mailto:${a.official_email}?subject=${encodeURIComponent("Assignment confirmation — " + (active ? getActive().name : ""))}">${a.official_email}</a>`);
      if (a.official_phone) parts.push(hstr`<a href="tel:${a.official_phone}">${a.official_phone}</a>`);
      contact = `<div class="asg-contact">awaiting response · ${parts.join(" · ")}</div>`;
    }
    // Built with the auto-escaping html`` helper (P2 #12): plain ${text} is
    // HTML-escaped, raw(...) marks already-trusted markup (badges, the contact
    // line, the pre-escaped audit-title attribute fragment, mileage's free-band
    // span). site_label/hotel_name fall back with `|| "—"` BEFORE interpolation
    // so the em-dash isn't escaped away.
    head.innerHTML = html`
      <div class="asg-name"><strong>${a.official_name}</strong></div>
      <div class="asg-meta">site: ${a.site_label || "—"} · hotel: ${a.hotel_name || "—"}${a.dietary_restrictions ? html` · diet: ${a.dietary_restrictions}` : ""}</div>
      ${raw(contact)}
      <div class="asg-badges">
        <span class="badge badge-info">pay $${a.pay.toFixed(2)}</span>
        <span class="badge badge-info">mileage ${raw(mileage)}</span>
        <span class="badge badge-ok"${auditTip ? raw(hstr` title="${auditTip}"`) : ""}>total $${a.total.toFixed(2)}${pa ? " ⓘ" : ""}</span>
        ${raw(respChip(a.response_status))}${flagChips ? raw(" " + flagChips) : ""}
      </div>`;
    const actions = document.createElement("span"); actions.className = "asg-actions";
    const ed = document.createElement("button"); ed.type = "button"; ed.className = "btn-link"; ed.textContent = "Edit";
    ed.addEventListener("click", () => {
      asgEditId = a.id; _reassignDays = null;   // editing is not a reassign
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
    // Reassign: only offered when the official DECLINED. Pre-fills the add-form
    // with the same site/hotel (NOT the official — that's the point) and stashes
    // the declined days so they copy onto the replacement on save. The declined
    // assignment is left in place as an audit trail (TD deletes it if desired).
    let ra = null;
    if (a.response_status === "declined") {
      ra = document.createElement("button"); ra.type = "button"; ra.className = "btn-link"; ra.textContent = "Reassign";
      ra.addEventListener("click", () => {
        asgReset();                                   // ensure create mode (clears edit id)
        _reassignDays = a.days.map((d) => ({ work_date: d.work_date, working_as: d.working_as }));
        asgForm.official_id.value = "";               // TD picks the replacement
        asgForm.site_id.value = a.site_id || "";
        asgForm.room_block_id.value = a.room_block_id || "";
        openForm(asgForm);
        if (typeof syncCombos === "function") syncCombos();
        asgForm.scrollIntoView({ block: "nearest" });
        const dn = _reassignDays.length;
        setMsg("asg-msg", `reassigning ${a.official_name}'s declined slot — pick a new official; ${dn} day(s) will be copied`, true);
        asgForm.official_id.focus();
      });
    }
    // ✉ Invite: compose a personalised assignment email (this official's days,
    // role, site, pay) — copy it to the clipboard and, if an email is on file,
    // offer to open a pre-filled message.
    const inv = document.createElement("button");
    inv.type = "button"; inv.className = "btn-link"; inv.textContent = "✉ Invite";
    inv.title = "Copy a ready-to-paste assignment email for this official";
    inv.addEventListener("click", async () => {
      let t;
      try { t = await api(`/assignments/${a.id}/invite-text`); }
      catch (e) { toast(e.message, false); return; }
      const full = `Subject: ${t.subject}\n\n${t.body}`;
      try { await navigator.clipboard.writeText(full); } catch (_) {}
      const action = t.official_email ? {
        label: "Open email →",
        onClick: () => window.open(
          `mailto:${encodeURIComponent(t.official_email)}?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(t.body)}`,
          "_blank"),
      } : null;
      toast(`Invite for ${a.official_name} copied to clipboard${t.official_email ? "" : " (no email on file)"}`, true, action);
    });
    // 📅 .ics: download this official's full schedule (all tournaments) as an
    // iCalendar file the TD can forward — same feed the official sees in the portal.
    const ics = document.createElement("a");
    ics.className = "btn-link"; ics.textContent = "📅 .ics";
    ics.href = `/api/officials/${a.official_id}/schedule.ics`;
    ics.setAttribute("download", "");
    ics.title = "Download this official's assignment days as an iCalendar (.ics) file";
    // P4-5: who/when/what trail for this assignment (audit table).
    const hist = document.createElement("button");
    hist.type = "button"; hist.className = "btn-link"; hist.textContent = "History";
    hist.title = "Change history: who did what, when";
    hist.addEventListener("click", () => showAssignmentHistory(a));
    actions.append(ed, inv, ...(ra ? [ra] : []), ics, hist, dl); head.appendChild(actions); card.appendChild(head);

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
      // Day-of truth (P4-1): the chip wears the actual status — no_show struck
      // through (and excluded from pay server-side), worked green, early dashed.
      const st = d.actual_status || "planned";
      if (st !== "planned") chip.classList.add("st-" + st);
      const oow = _outOfWindow(d.work_date);
      chip.innerHTML = html`${oow ? raw('<span class="warn" title="outside the play window">⚠ </span>') : ""}${
        d.conflict ? raw('<span class="warn" title="double-booked: this official is assigned elsewhere this day">⚠ </span>') : ""}${
        d.outside_availability ? raw('<span class="warn" title="official did not declare this day available">⚠ </span>') : ""}${
        d.uncertified ? raw('<span class="warn" title="official is not certified for this role">⚠ </span>') : ""}${fmtDOW(d.work_date)} · ${certLabel(d.working_as)} $${d.rate_applied.toFixed(2)} `;
      const setSt = async (status) => {
        try {
          await api(`/assignment-days/${d.id}/status`, { method: "PUT", body: JSON.stringify({ actual_status: status }) });
          toast(`${fmtDOW(d.work_date)}: ${status.replace("_", " ")}`, true);
          loadAssignments();
        } catch (e) { setMsg("asg-msg", e.message, false); }
      };
      const stGlyph = { planned: "○", worked: "✓", no_show: "✗", early_departure: "◔" }[st];
      const stMenu = makeMenuButton(stGlyph, [
        { label: "Worked ✓", title: "Showed and worked the day", onClick: () => setSt("worked") },
        { label: "Early departure ◔", title: "Worked part of the day", onClick: () => setSt("early_departure") },
        { label: "No-show ✗ (drops from pay)", danger: true, onClick: () => setSt("no_show") },
        { separator: true },
        { label: "Reset to planned ○", onClick: () => setSt("planned") },
      ], { className: "btn-icon chip-status", title: `Day-of status: ${st.replace("_", " ")}`, anchor: true, noCaret: true });
      chip.appendChild(stMenu);
      const x = document.createElement("button"); x.type = "button"; x.className = "chip-x"; x.textContent = "×";
      x.setAttribute("aria-label", `Remove ${fmtDOW(d.work_date)}`);
      x.addEventListener("click", async () => { try { await api(`/assignment-days/${d.id}`, { method: "DELETE" }); loadAssignments(); } catch (e) { setMsg("asg-msg", e.message, false); } });
      chip.appendChild(x); days.appendChild(chip);
    }
    if (!a.days.length) days.innerHTML = '<span class="muted">No days assigned yet.</span>';
    card.appendChild(days);

    // Add days: a labelled certification dropdown + the official's available days
    // (select all / individual), falling back to a manual date if no availability
    // is on file.
    const addRow = document.createElement("div"); addRow.className = "add-day";
    const addLbl = document.createElement("span"); addLbl.className = "add-day-label";
    addLbl.textContent = "Add day(s) as";
    addRow.appendChild(addLbl);
    const certSel = document.createElement("select");
    certSel.setAttribute("aria-label", "Role for the added day(s)");
    getCertPairs().forEach(([v, lbl]) => { const o = document.createElement("option"); o.value = v; o.textContent = lbl; certSel.appendChild(o); });
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
      manualIn.setAttribute("aria-label", "Work date to add");
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
        `${oow.length} day(s) fall outside the play window (${getActive().play_start_date} → ${getActive().play_end_date}). Add anyway?`,
        "Add anyway"))) return;
      // Double-booking pre-check: warn before adding a date this official already
      // works in another tournament (a warning, not a block — audit §3.4).
      const elsewhere = new Map((a.official_other_dates || []).map((c) => [c.work_date, c]));
      const clash = dates.filter((d) => elsewhere.has(d));
      if (clash.length && !(await confirmDialog(
        `${clash.length} day(s) double-book ${a.official_name} — already assigned elsewhere: ` +
        clash.map((d) => { const c = elsewhere.get(d); return `${d}${c.other_site ? ` @ ${c.other_site}` : ""} (${c.other_tournament})`; }).join("; ") +
        `. Add anyway?`, "Add anyway"))) return;
      // Certification pre-check: the backend hard-blocks adding a role the official
      // doesn't hold (409). Stop early with a friendly message + a pointer to fix
      // it, instead of letting the POST fail mid-loop.
      const held = a.held_certs || [];
      if (!held.includes(certSel.value)) {
        setMsg("asg-msg", `${a.official_name} is not certified for ${certLabel(certSel.value)} — add the certification on the Official record first, or pick a role they hold.`, false);
        return;
      }
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
  // Days stashed by a "Reassign" click, copied onto the replacement assignment on
  // the next create. Cleared on reset so a normal add never inherits them.
  let _reassignDays = null;
  function asgReset() {
    asgEditId = null; _reassignDays = null;
    asgForm.reset(); asgForm.querySelector('button[type="submit"]').textContent = "Add official";
  }
  onSubmit(asgForm, async (e) => {
    const b = formObj(asgForm);
    b.official_id = Number(b.official_id);
    b.site_id = b.site_id ? Number(b.site_id) : null;
    b.room_block_id = b.room_block_id ? Number(b.room_block_id) : null;
    try {
      if (asgEditId) {
        await api(`/assignments/${asgEditId}`, { method: "PUT", body: JSON.stringify(b) });
      } else {
        const created = await api(`/tournaments/${getActive().id}/assignments`, { method: "POST", body: JSON.stringify(b) });
        // Reassign-from-declined: copy the declined slot's days onto the new
        // official's assignment so the TD doesn't re-enter them by hand.
        if (_reassignDays && _reassignDays.length && created && created.id) {
          for (const d of _reassignDays) {
            try { await api(`/assignments/${created.id}/days`, { method: "POST", body: JSON.stringify(d) }); }
            catch (de) { toast(`couldn't copy ${d.work_date}: ${de.message}`, false); }
          }
        }
      }
      setMsg("asg-msg", asgEditId ? "saved" : "added", true); asgReset(); loadAssignments();
    } catch (err) { setMsg("asg-msg", err.message, false); markInvalid(asgForm, err.message); }
  });
  asgForm.querySelector(".cancel").addEventListener("click", asgReset);

  // --- Room blocks (tournament-scoped) ---
  const trbForm = document.getElementById("trb-form");
  let trbEditId = null;
  const trbGrid = makeListGrid("trb-table", [
    { title: "ID", field: "id", width: 64 },
    { title: "Hotel", field: "hotel_id", formatter: (c) => { const b = c.getData(); return hstr`${getHotelsById()[b.hotel_id] ? getHotelsById()[b.hotel_id].name : b.hotel_id}`; },
      headerFilter: "input", headerFilterFunc: (term, _v, b) => String(getHotelsById()[b.hotel_id] ? getHotelsById()[b.hotel_id].name : b.hotel_id).toLowerCase().includes(String(term).toLowerCase()) },
    { title: "Type", field: "kind", cssClass: "editable-cell", formatter: (c) => (c.getData().kind === "official" ? "Officials comp" : "Player rate"),
      editor: "list", editorParams: { values: { player: "Player rate", official: "Officials comp" } } },
    { title: "Rooms", field: "room_count", hozAlign: "right", width: 90, cssClass: "editable-cell", editor: "number", editorParams: { min: 0 } },
    { title: "Left", field: "rooms_remaining", hozAlign: "right", width: 80 },
    { title: "Check-in", field: "check_in", cssClass: "editable-cell", editor: "date" },
    { title: "Check-out", field: "check_out", cssClass: "editable-cell", editor: "date" },
  ], "room-blocks", "No room blocks for this tournament yet.",
    async (b) => { if (!(await confirmDialog("Delete room block?"))) return; try { await api(`/room-blocks/${b.id}`, { method: "DELETE" }); loadRoomBlocks(); } catch (e) { setMsg("trb-msg", e.message, false); } },
    (b) => {
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
    },
    // In-grid edit: PUT the whole row (RoomBlockOut carries every required field).
    async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const b = cell.getRow().getData();
      try {
        const body = { ...b }; delete body._act;
        body.hotel_id = Number(body.hotel_id);
        body.room_count = body.room_count == null ? 0 : Number(body.room_count);
        body.tournament_id = getActive().id;
        await api(`/room-blocks/${b.id}`, { method: "PUT", body: JSON.stringify(body) });
        setMsg("trb-msg", "saved", true);
        loadRoomBlocks();  // refresh rooms_remaining
      } catch (e) { setMsg("trb-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadRoomBlocks(); }
    });
  async function loadRoomBlocks() {
    if (!getActive()) return;
    prereqCallout("panel-t-roomblocks", !Object.keys(hotelsById).length,
      "No hotels in the catalog yet — add them before creating room blocks.",
      "tab-panel-hotels");
    trbGrid.setData(await api(`/room-blocks?tournament_id=${getActive().id}`));
  }
  function trbReset() { trbEditId = null; trbForm.reset(); trbForm.querySelector('button[type="submit"]').textContent = "Add block"; }
  onSubmit(trbForm, async (e) => {
    const b = formObj(trbForm);
    b.hotel_id = Number(b.hotel_id);
    b.tournament_id = getActive().id;
    b.room_count = b.room_count == null ? 0 : Number(b.room_count);
    try {
      if (trbEditId) await api(`/room-blocks/${trbEditId}`, { method: "PUT", body: JSON.stringify(b) });
      else await api(`/room-blocks`, { method: "POST", body: JSON.stringify(b) });
      setMsg("trb-msg", trbEditId ? "saved" : "added", true); trbReset(); loadRoomBlocks();
    } catch (err) { setMsg("trb-msg", err.message, false); markInvalid(trbForm, err.message); }
  });
  trbForm.querySelector(".cancel").addEventListener("click", trbReset);


  /** Dashboard deep-link: filter assignment cards by response status. */
  function filterByResponse(status) {
    _asgRespFilter = status || "all";
    _renderAsgList();
  }

  return { loadAssignments, respChip, filterByResponse };
}
