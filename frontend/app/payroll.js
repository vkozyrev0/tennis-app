// Payroll panel — finalize / mark-paid / payment batches (D11 slice from app.js).
// Backend: backend/app/routers/payroll.py (P4-4).

/**
 * @param {{
 *   api: Function,
 *   setMsg: Function,
 *   confirmDialog: Function,
 *   markInvalid: Function,
 *   money: Function,
 *   html: Function,
 *   hstr: Function,
 *   raw: Function,
 *   makeReadGrid: Function,
 *   printDoc: Function,
 *   fmtMDY: Function,
 *   getActive: () => any,
 * }} ctx
 * @returns {{ loadPayroll: () => Promise<void> }}
 */
export function createPayrollPanel(ctx) {
  const {
    api, setMsg, confirmDialog, markInvalid, money, html, hstr, raw,
    makeReadGrid, printDoc, fmtMDY: _fmtMDY, getActive,
  } = ctx;

  // =================== Payroll (P4-4 finalize/lock + settle) ===================
  // Live numbers recompute from current rows; "Finalize" freezes one official's
  // computed summary into payroll_record so later day/rate edits can't move
  // money the TD already approved. Drift = finalized ≠ live (re-finalize or
  // investigate). Mark paid tracks settlement; paid records refuse unfinalize.
  const _PAID_METHODS = ["check", "ach", "cash", "venmo", "zelle", "other"];
  // record_ids checked for the next "New batch…". Reset on every payroll reload
  // (record states change) and after a batch is created.
  const _batchSel = new Set();
  async function _payrollMarkPaid(row) {
    const method = await (async () => {
      // tiny inline picker via prompt-less confirm flow: build a one-off dialog
      return new Promise((resolve) => {
        const m = document.createElement("div"); m.className = "modal";
        m.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true">' +
          hstr`<h3 class="detail-title">Mark paid — ${row.official_name}</h3>` +
          '<div class="row"><label>Method <select id="pay-method">' +
          _PAID_METHODS.map((v) => `<option value="${v}">${v}</option>`).join("") +
          '</select></label>' +
          '<label>Note <input id="pay-note" maxlength="500" placeholder="check #1042 / batch 7" /></label></div>' +
          '<div class="modal-actions"><button type="button" id="pay-ok">Mark paid</button>' +
          '<button type="button" id="pay-cancel" class="cancel">Cancel</button></div></div>';
        document.body.appendChild(m);
        m.querySelector("#pay-ok").addEventListener("click", () => {
          const v = { method: m.querySelector("#pay-method").value,
                      note: m.querySelector("#pay-note").value.trim() || null };
          m.remove(); resolve(v);
        });
        m.querySelector("#pay-cancel").addEventListener("click", () => { m.remove(); resolve(null); });
        m.addEventListener("click", (e) => { if (e.target === m) { m.remove(); resolve(null); } });
      });
    })();
    if (!method) return;
    try {
      await api(`/payroll/${row.finalized.record_id}/paid`, { method: "PUT",
        body: JSON.stringify({ paid: true, paid_method: method.method, paid_note: method.note }) });
      setMsg("payroll-msg", `paid — ${row.official_name}`, true);
      loadPayroll();
    } catch (e) { setMsg("payroll-msg", e.message, false); }
  }
  const payrollGrid = makeReadGrid("payroll-table", [
    { title: "", field: "_sel", headerSort: false, width: 36, hozAlign: "center",
      titleFormatter: () => '<span title="Tick finalized, unpaid rows to batch just those (else New batch settles all eligible)">✓</span>',
      formatter: (cell) => {
        const m = cell.getData();
        // only finalized, not-yet-paid, un-batched records can join a new batch
        if (!m.finalized || m.finalized.paid || m.finalized.batch_id) return "";
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.className = "batch-pick";
        cb.checked = _batchSel.has(m.finalized.record_id);
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", () => {
          if (cb.checked) _batchSel.add(m.finalized.record_id);
          else _batchSel.delete(m.finalized.record_id);
        });
        return cb;
      } },
    { title: "Official", field: "official_name", headerFilter: "input", responsive: 0,  // identity — keep visible when collapsed
      formatter: (c) => hstr`${c.getValue()}${c.getData().orphaned
        ? raw(' <span class="badge badge-warn" title="the assignment was deleted after finalization — the money trail remains">assignment gone</span>') : ""}` },
    { title: "Days", field: "days_worked", width: 80, hozAlign: "right",
      formatter: (c) => {
        const m = c.getData();
        return hstr`${String(c.getValue())}${m.no_show_days
          ? raw(` <span class="badge badge-warn" title="no-show days (unpaid)">−${m.no_show_days}</span>`) : ""}`;
      } },
    { title: "Pay", field: "pay", width: 100, hozAlign: "right", formatter: (c) => money(c.getValue()) },
    { title: "Mileage", field: "mileage", width: 100, hozAlign: "right",
      formatter: (c) => c.getData().missing_distance
        ? '<span class="badge badge-warn" title="no distance on file — mileage can\'t compute">no dist.</span>'
        : money(c.getValue()) },
    { title: "Total (live)", field: "total", width: 110, hozAlign: "right", bottomCalc: "sum",
      bottomCalcFormatter: (c) => money(c.getValue()),
      formatter: (c) => `<strong>${money(c.getValue())}</strong>` },
    { title: "Finalized", field: "_fin", width: 130, hozAlign: "right",
      formatter: (c) => {
        const m = c.getData();
        if (!m.finalized) return '<span class="muted">—</span>';
        const tip = `by ${m.finalized.finalized_by} · ${new Date(m.finalized.finalized_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
        return hstr`<span title="${tip}">${money(m.finalized.total)}</span>${
          m.drift ? raw(' <span class="badge badge-bad" title="live total no longer matches the finalized amount — unfinalize + re-finalize, or investigate">drift</span>') : ""}`;
      } },
    { title: "Status", field: "_status", width: 120,
      // open / finalized / paid is the field a TD settling pay scans most — let
      // them filter to "everything still open" or "finalized but unpaid" in one
      // click. The bucket is derived from finalized/paid, so a headerFilterFunc.
      headerFilter: "list",
      headerFilterParams: { values: { "": "All", open: "open", finalized: "finalized", paid: "paid" } },
      headerFilterFunc: (sel, _v, data) => !sel
        || (!data.finalized ? "open" : (data.finalized.paid ? "paid" : "finalized")) === sel,
      formatter: (c) => {
        const m = c.getData();
        if (!m.finalized) return '<span class="muted">open</span>';
        if (!m.finalized.paid) return '<span class="badge badge-info">finalized</span>';
        const tip = [m.finalized.paid_at, m.finalized.paid_method, m.finalized.paid_note,
                     m.finalized.batch_id ? `batch #${m.finalized.batch_id}` : null]
          .filter(Boolean).join(" · ");
        return hstr`<span class="badge badge-ok" title="${tip}">paid${m.finalized.batch_id ? raw(" <span class=\"muted\">⛁</span>") : ""}</span>`;
      } },
    { title: "", field: "_act", headerSort: false, width: 170, cssClass: "grid-actions-cell",
      formatter: (cell) => {
        const m = cell.getData();
        const wrap = document.createElement("div"); wrap.className = "grid-actions";
        const btn = (label, title, fn) => {
          const b = document.createElement("button");
          b.type = "button"; b.className = "btn-link"; b.textContent = label; b.title = title;
          b.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
          wrap.appendChild(b);
        };
        if (!m.finalized) {
          btn("Finalize", "Freeze this official's computed pay into a payroll record", async () => {
            try { await api(`/assignments/${m.assignment_id}/finalize`, { method: "POST" });
                  setMsg("payroll-msg", `finalized — ${m.official_name}`, true); loadPayroll(); }
            catch (e) { setMsg("payroll-msg", e.message, false); }
          });
        } else if (!m.finalized.paid) {
          btn("Mark paid", "Record settlement (date/method/note)", () => _payrollMarkPaid(m));
          btn("Unfinalize", "Re-open this record so pay recomputes from current rows", async () => {
            if (!(await confirmDialog(`Unfinalize ${m.official_name}? The frozen amount is discarded.`))) return;
            try { await api(`/payroll/${m.finalized.record_id}`, { method: "DELETE" });
                  setMsg("payroll-msg", `re-opened — ${m.official_name}`, true); loadPayroll(); }
            catch (e) { setMsg("payroll-msg", e.message, false); }
          });
        } else {
          btn("Unmark paid", "Walk the payment back (needed before unfinalizing)", async () => {
            if (!(await confirmDialog(`Unmark ${m.official_name} as paid?`))) return;
            try { await api(`/payroll/${m.finalized.record_id}/paid`, { method: "PUT",
                    body: JSON.stringify({ paid: false }) });
                  setMsg("payroll-msg", `payment walked back — ${m.official_name}`, true); loadPayroll(); }
            catch (e) { setMsg("payroll-msg", e.message, false); }
          });
        }
        return wrap;
      } },
  ], "payroll", "No assignments yet — staff the tournament first.", { index: "assignment_id" });
  async function loadPayroll() {
    if (!getActive()) return;
    _batchSel.clear();   // record states change on reload — drop stale ticks
    const rows = await api(`/tournaments/${getActive().id}/payroll`);
    payrollGrid.setData(rows);
    const fin = rows.filter((r) => r.finalized);
    const paid = fin.filter((r) => r.finalized.paid);
    const sum = (xs, f) => xs.reduce((n, r) => n + (f(r) || 0), 0);
    document.getElementById("payroll-totals").textContent =
      `${fin.length}/${rows.length} finalized (${money(sum(fin, (r) => r.finalized.total))})` +
      ` · ${paid.length} paid (${money(sum(paid, (r) => r.finalized.total))})`;
    // Payment batches ride below the grid; supplemental, so don't block on them.
    try { _renderBatches(await api(`/tournaments/${getActive().id}/payroll/batches`)); }
    catch { /* leave the prior batch list in place on a transient fetch error */ }
  }
  document.getElementById("payroll-finalize-all").addEventListener("click", async () => {
    if (!getActive()) return;
    if (!(await confirmDialog("Finalize every open assignment's pay at the current computed amounts?"))) return;
    try {
      const out = await api(`/tournaments/${getActive().id}/payroll/finalize-all`, { method: "POST" });
      setMsg("payroll-msg", `finalized ${out.finalized} (now ${out.total_finalized} total)`, true);
      loadPayroll();
    } catch (e) { setMsg("payroll-msg", e.message, false); }
  });
  document.getElementById("payroll-export").addEventListener("click", async () => {
    if (!getActive()) return;
    // Only finalized (frozen) records export. Guard with a fetch so an empty
    // export tells the TD to finalize first instead of downloading a header row.
    try {
      const rows = await api(`/tournaments/${getActive().id}/payroll`);
      if (!rows.some((r) => r.finalized)) { setMsg("payroll-msg", "nothing finalized yet — finalize records first", false); return; }
      // Same-origin GET carries the session cookie; the attachment disposition
      // makes the browser download rather than navigate.
      const a = document.createElement("a");
      a.href = `/api/tournaments/${getActive().id}/payroll/export.csv`;
      a.download = "";
      document.body.appendChild(a); a.click(); a.remove();
      setMsg("payroll-msg", "CSV exported", true);
    } catch (e) { setMsg("payroll-msg", e.message, false); }
  });
  document.getElementById("payroll-audit-csv").addEventListener("click", () => {
    if (!getActive()) return;
    // Same-origin GET carries the session cookie; the attachment disposition
    // downloads rather than navigates. No pre-fetch guard — the trail is rarely
    // empty (creating an assignment already logs), and a header-only CSV is fine.
    const a = document.createElement("a");
    a.href = `/api/tournaments/${getActive().id}/assignment-audit.csv`;
    a.download = "";
    document.body.appendChild(a); a.click(); a.remove();
    setMsg("payroll-msg", "audit CSV exported", true);
  });
  document.getElementById("payroll-batch-new").addEventListener("click", _payrollNewBatch);

  // Create one payment batch from every finalized, not-yet-paid, un-batched record
  // (the "pay everyone who's ready in one check run" case). A dialog collects the
  // shared reference/method/date/note; the POST marks all members paid at once.
  async function _payrollNewBatch() {
    if (!getActive()) return;
    let eligible;
    try {
      const rows = await api(`/tournaments/${getActive().id}/payroll`);
      eligible = rows.filter((r) => r.finalized && !r.finalized.paid && !r.finalized.batch_id);
    } catch (e) { setMsg("payroll-msg", e.message, false); return; }
    if (!eligible.length) {
      setMsg("payroll-msg", "no finalized, unpaid record to batch — finalize first", false); return;
    }
    // honor row ticks if any eligible row is selected; otherwise batch them all
    const picked = eligible.filter((r) => _batchSel.has(r.finalized.record_id));
    const targets = picked.length ? picked : eligible;
    const scope = picked.length ? "selected" : "finalized, unpaid";
    const today = new Date().toISOString().slice(0, 10);
    const info = await new Promise((resolve) => {
      const m = document.createElement("div"); m.className = "modal";
      m.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true">' +
        hstr`<h3 class="detail-title">New payment batch</h3>` +
        hstr`<p class="muted">${String(targets.length)} ${scope} record(s) will be settled together.</p>` +
        '<div class="row"><label>Reference <input id="batch-ref" maxlength="200" placeholder="Check run 2026-06-15" /></label>' +
        '<label>Method <select id="batch-method">' +
        _PAID_METHODS.map((v) => `<option value="${v}">${v}</option>`).join("") + '</select></label></div>' +
        `<div class="row"><label>Paid on <input id="batch-date" type="date" value="${today}" /></label>` +
        '<label>Note <input id="batch-note" maxlength="500" placeholder="optional" /></label></div>' +
        '<div class="modal-actions"><button type="button" id="batch-ok">Create batch</button>' +
        '<button type="button" id="batch-cancel" class="cancel">Cancel</button></div></div>';
      document.body.appendChild(m);
      const close = (v) => { m.remove(); resolve(v); };
      m.querySelector("#batch-ok").addEventListener("click", () => {
        const reference = m.querySelector("#batch-ref").value.trim();
        const paid_on = m.querySelector("#batch-date").value;
        if (!reference || !paid_on) { markInvalid(m.querySelector("#batch-ref"), "reference and date are required"); return; }
        close({ reference, method: m.querySelector("#batch-method").value, paid_on,
                note: m.querySelector("#batch-note").value.trim() || null });
      });
      m.querySelector("#batch-cancel").addEventListener("click", () => close(null));
      m.addEventListener("click", (e) => { if (e.target === m) close(null); });
    });
    if (!info) return;
    try {
      const out = await api(`/tournaments/${getActive().id}/payroll/batches`, { method: "POST",
        body: JSON.stringify({ ...info, record_ids: targets.map((r) => r.finalized.record_id) }) });
      _batchSel.clear();
      setMsg("payroll-msg", `batch created — ${out.record_count} record(s), ${money(out.total)}`, true);
      loadPayroll();
    } catch (e) { setMsg("payroll-msg", e.message, false); }
  }

  // Render the payment-batch list below the grid. Each batch shows reference,
  // method, date, member count + summed total, and a Dissolve action (walks its
  // records back to unpaid — they stay finalized).
  function _renderBatches(batches) {
    const wrap = document.getElementById("payroll-batches");
    if (!batches.length) { wrap.innerHTML = ""; return; }
    const rows = batches.map((b) => hstr`<tr>
      <td>${b.reference}</td><td>${b.method}</td><td>${b.paid_on}</td>
      <td class="num">${String(b.record_count)}</td><td class="num">${money(b.total)}</td>
      <td class="actions"><button type="button" class="btn-link" data-receipt="${String(b.batch_id)}">Receipt</button><button type="button" class="btn-link" data-dissolve="${String(b.batch_id)}">Dissolve</button></td></tr>`).join("");
    wrap.innerHTML = hstr`<h4 class="batch-h">Payment batches</h4>
      <table class="list-table batch-table"><thead><tr><th>Reference</th><th>Method</th><th>Paid on</th><th class="num">Records</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>${raw(rows)}</tbody></table>`;
    wrap.querySelectorAll("[data-receipt]").forEach((btn) => {
      btn.addEventListener("click", () => _printBatchReceipt(btn.dataset.receipt));
    });
    wrap.querySelectorAll("[data-dissolve]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const b = batches.find((x) => String(x.batch_id) === btn.dataset.dissolve);
        if (!(await confirmDialog(`Dissolve batch "${b.reference}"? Its ${b.record_count} record(s) go back to unpaid (they stay finalized).`))) return;
        try { await api(`/payroll/batches/${btn.dataset.dissolve}`, { method: "DELETE" });
              setMsg("payroll-msg", "batch dissolved", true); loadPayroll(); }
        catch (e) { setMsg("payroll-msg", e.message, false); }
      });
    });
  }

  // Printable batch receipt — the paper the TD files with the checks. Reuses the
  // shared printDoc() scaffold; one row per official with the frozen total.
  async function _printBatchReceipt(batchId) {
    let d;
    try { d = await api(`/payroll/batches/${batchId}`); }
    catch (e) { setMsg("payroll-msg", e.message, false); return; }
    const rows = d.members.length ? d.members.map((m) =>
      hstr`<tr><td>${m.official_name}</td><td class="num">${String(m.days_worked)}</td><td class="num">${money(m.total)}</td></tr>`).join("")
      : `<tr><td colspan="3" class="muted">No records in this batch.</td></tr>`;
    printDoc({
      title: `Payment batch — ${d.reference}`,
      styleExtra: `
        .grand { margin-top: 1rem; padding: 0.5rem 0.7rem; background: #e7f1ea; border: 1px solid #2e6f40; border-radius: 6px; font-size: 13px; }`,
      body: hstr`
      <h1>Payment batch receipt</h1>
      <div class="sub">${d.reference} · ${d.method} · paid ${d.paid_on}${d.note ? ` · ${d.note}` : ""} · generated ${_fmtMDY(new Date().toISOString().slice(0, 10))}</div>
      <table><thead><tr><th>Official</th><th class="num">Days</th><th class="num">Total</th></tr></thead><tbody>${raw(rows)}</tbody></table>
      <div class="grand"><strong>Batch total: ${money(d.total)}</strong> · ${String(d.record_count)} official(s)</div>`,
    });
  }


  return { loadPayroll };
}
