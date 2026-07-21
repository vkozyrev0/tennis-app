// T-shirts: cumulative list, inventory/order, by-site report — D11.
import { SHIRT_CODES, SHIRT_LABEL, SIZE_TOKEN } from "./shirts.js";

/**
 * @returns {{
 *   loadTshirts: () => Promise<void>,
 *   loadTshirtOrder: () => Promise<void>,
 *   loadTshirtsBySite: () => Promise<void>,
 * }}
 */
export function createTshirtsPanel(ctx) {
  const {
    api, setMsg, toast, confirmDialog, html, hstr,
    makeReadGrid, _csvDownload, playerCell, getActive,
  } = ctx;

  // --- T-shirts (Setup: cumulative cross-tournament list) ---
  let tshirtRows = [];
  // Map any stored size (full name OR legacy code like "YM") to a canonical code,
  // so mixed historical data aggregates into one line; unknowns return as-is.
  function shirtCode(v) {
    if (!v) return null;
    const s = String(v).toLowerCase().replace(/[^a-z]/g, "");
    let group, rest;
    if (/^(youth|yth|junior|jr)/.test(s) || (s[0] === "y" && s.length <= 4)) {
      group = "Y"; rest = s.replace(/^(youth|yth|junior|jr|y)/, "");
    } else if (/^adult/.test(s) || (s[0] === "a" && s.length <= 4)) {
      group = "A"; rest = s.replace(/^(adult|a)/, "");
    } else { group = "A"; rest = s; }
    const sz = SIZE_TOKEN[rest];
    const code = sz && group + sz;
    return SHIRT_CODES.includes(code) ? code : String(v).trim();
  }
  function _shirtRank(code) { const i = SHIRT_CODES.indexOf(code); return i < 0 ? 999 : i; }
  let tshirtOrderRows = [];  // [["Size","Qty"], ...] smallest→largest, for the vendor CSV
  function renderTshirtSummary() {
    // Order quantities = the latest size per player (rows arrive newest-first per
    // player), counted by canonical size. Backend excludes withdrawals/alternates.
    const latest = {};
    for (const r of tshirtRows) if (!(r.player_id in latest)) latest[r.player_id] = r.t_shirt_size;
    const counts = {};
    for (const sz of Object.values(latest)) { const c = shirtCode(sz); counts[c] = (counts[c] || 0) + 1; }
    const keys = Object.keys(counts).sort((a, b) => _shirtRank(a) - _shirtRank(b) || a.localeCompare(b));
    const players = Object.keys(latest).length;
    const label = (c) => SHIRT_LABEL[c] || c;
    tshirtOrderRows = [["Size", "Quantity"], ...keys.map((c) => [label(c), counts[c]]), ["Total", players]];
    const el = document.getElementById("tshirt-summary");
    if (!el) return;
    el.innerHTML = keys.length
      ? `<span class="muted">Order quantities — latest size per player (${players} player${players === 1 ? "" : "s"}):</span> `
        + keys.map((c) => hstr`<span class="badge badge-info">${label(c)}: ${counts[c]}</span>`).join(" ")
      : "";
  }
  async function tshirtOrderExport() {
    await loadTshirts();  // ensure the cumulative data + order rows are computed
    if (tshirtOrderRows.length > 1) _csvDownload(tshirtOrderRows, "tshirt-order");
    else toast("No t-shirt sizes recorded yet", false);
  }
  const tshirtGrid = makeReadGrid("tshirt-table", [
    { title: "Player", field: "last_name", formatter: playerCell },
    { title: "USTA #", field: "usta_number" },
    { title: "Division", field: "age_division" },
    { title: "Tournament", field: "tournament_name" },
    { title: "Size", field: "t_shirt_size" },
  ], "tshirts", "No t-shirt sizes recorded yet.");
  function tshirtMatches(data) {
    const q = document.getElementById("tshirt-filter")?.value.trim().toLowerCase() || "";
    if (!q) return true;
    const hay = [data.first_name, data.last_name, data.usta_number,
      data.age_division, data.tournament_name, data.t_shirt_size]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }
  function renderTshirts() {
    renderTshirtSummary();
    tshirtGrid.setData(tshirtRows);
    tshirtGrid.setFilter(tshirtMatches);
  }
  async function loadTshirts() { tshirtRows = await api("/tshirts"); renderTshirts(); }
  document.getElementById("tshirt-filter")?.addEventListener("input", () => tshirtGrid.setFilter(tshirtMatches));
  document.getElementById("tshirt-order-csv")?.addEventListener("click", tshirtOrderExport);

  // --- T-shirt inventory + order tracking (per-tournament) ---
  // One row per canonical size (smallest to largest). Each row's On-hand cell is
  // an inline number input; Save inventory PUTs all 7 in one call. "Place order"
  // freezes today's requested counts as a snapshot so later roster drift is
  // visible in the Δ column.
  let _tshirtOrderState = null;
  function _renderTshirtOrder(data) {
    _tshirtOrderState = data;
    const tbody = document.querySelector("#tshirt-order-table tbody");
    if (!tbody) return;
    const hasSnapshot = !!data.ordered_at;
    // Toggle the snapshot columns on/off (CSS class show/hide).
    document.querySelectorAll("#tshirt-order-table .order-snapshot")
      .forEach((el) => { el.style.display = hasSnapshot ? "" : "none"; });
    tbody.innerHTML = data.rows.map((r) => {
      const snap = r.snapshot;
      const delta = (snap != null) ? (r.requested - snap) : null;
      const dCls = (delta == null || delta === 0) ? "" : (delta > 0 ? "warn" : "muted");
      const dStr = (delta == null) ? "—" : (delta > 0 ? `+${delta}` : `${delta}`);
      return html`<tr>
      <td><strong>${r.size}</strong> <span class="muted">${r.label}</span></td>
      <td class="num">${r.requested}</td>
      <td class="num"><input type="number" min="0" step="1" data-size="${r.size}" value="${r.on_hand}" style="width:5rem;text-align:right" /></td>
      <td class="num">${r.to_order}</td>
      <td class="num order-snapshot" style="${hasSnapshot ? "" : "display:none"}">${snap == null ? "—" : snap}</td>
      <td class="num order-snapshot ${dCls}" style="${hasSnapshot ? "" : "display:none"}">${dStr}</td>
    </tr>`;
    }).join("");
    const t = data.totals;
    document.getElementById("tshirt-order-totals").innerHTML =
      `<th>Totals</th><th class="num">${t.requested}</th><th class="num">${t.on_hand}</th><th class="num">${t.to_order}</th>` +
      `<th class="num order-snapshot" style="${hasSnapshot ? "" : "display:none"}">${t.snapshot == null ? "—" : t.snapshot}</th>` +
      `<th class="num order-snapshot" style="${hasSnapshot ? "" : "display:none"}"></th>`;
    const status = document.getElementById("tshirt-order-status");
    if (data.ordered_at) {
      status.innerHTML = hstr`Order placed <strong>${data.ordered_at}</strong> — the Snapshot column shows what was requested at that moment.`;
    } else {
      status.innerHTML = `<em>No order placed yet.</em> Set inventory below, then click "Place order" to snapshot today's requested counts.`;
    }
    document.getElementById("tshirt-order-cancel").hidden = !data.ordered_at;
    document.getElementById("tshirt-order-place").textContent = data.ordered_at
      ? "Re-snapshot (replace order date)" : "Place order (snapshot today)";
  }
  async function loadTshirtOrder() {
    const active = getActive();
    if (!active) return;
    try { _renderTshirtOrder(await api(`/tournaments/${active.id}/tshirt-order`)); }
    catch (e) { setMsg("tshirt-order-msg", e.message, false); }
  }
  async function saveTshirtInventory() {
    const active = getActive();
    if (!active) return;
    const inputs = document.querySelectorAll("#tshirt-order-table tbody input[data-size]");
    const on_hand = {}; for (const i of inputs) on_hand[i.dataset.size] = Math.max(0, parseInt(i.value, 10) || 0);
    try {
      _renderTshirtOrder(await api(`/tournaments/${active.id}/tshirt-inventory`, { method: "PUT", body: JSON.stringify({ on_hand }) }));
      setMsg("tshirt-order-msg", "inventory saved", true);
    } catch (e) { setMsg("tshirt-order-msg", e.message, false); }
  }
  async function placeTshirtOrder() {
    const active = getActive();
    if (!active) return;
    const already = _tshirtOrderState && _tshirtOrderState.ordered_at;
    const msg = already
      ? `Re-snapshot the t-shirt order with today's requested counts? (replaces the existing snapshot from ${already})`
      : "Place the t-shirt order? Today's requested counts will be saved as the order snapshot.";
    if (!(await confirmDialog(msg, already ? "Re-snapshot" : "Place order"))) return;
    try {
      _renderTshirtOrder(await api(`/tournaments/${active.id}/tshirt-order`, { method: "POST" }));
      setMsg("tshirt-order-msg", "order snapshotted", true);
    } catch (e) { setMsg("tshirt-order-msg", e.message, false); }
  }
  async function cancelTshirtOrder() {
    const active = getActive();
    if (!active) return;
    if (!(await confirmDialog("Cancel the t-shirt order (clear date + snapshot)? Inventory stays."))) return;
    try {
      await api(`/tournaments/${active.id}/tshirt-order`, { method: "DELETE" });
      // Audit N21: clear the cached snapshot synchronously — otherwise a quick
      // "Cancel" → "Place" sequence within the same RAF reads the stale order.
      _tshirtOrderState = null;
      await loadTshirtOrder();
      setMsg("tshirt-order-msg", "order cancelled", true);
    } catch (e) { setMsg("tshirt-order-msg", e.message, false); }
  }
  document.getElementById("tshirt-order-save")?.addEventListener("click", saveTshirtInventory);
  document.getElementById("tshirt-order-place")?.addEventListener("click", placeTshirtOrder);
  document.getElementById("tshirt-order-cancel")?.addEventListener("click", cancelTshirtOrder);

  // ---- B1: T-shirts by site (per-tournament) -------------------------------
  // Pulls the grouped report from the API, renders one row per (site, division,
  // size) with a quantity. Site filter narrows to one site; CSV mirrors the
  // visible grid. Players in unassigned divisions show under "Unassigned".
  let _tshirtBySiteRows = [];
  async function loadTshirtsBySite() {
    const active = getActive();
    if (!active) return;
    const tbody = document.querySelector("#tshirt-by-site-table tbody");
    const status = document.getElementById("tshirt-by-site-status");
    if (!tbody) return;
    let rows;
    try { rows = await api(`/tournaments/${active.id}/tshirts-by-site`); }
    catch (e) { tbody.innerHTML = hstr`<tr><td colspan="4" class="muted">${e.message}</td></tr>`; return; }
    _tshirtBySiteRows = rows;
    // Populate the site filter with the actual sites that appear (so the TD
    // doesn't see sites with zero shirts).
    const sel = document.getElementById("tshirt-by-site-filter");
    const sites = [...new Set(rows.map((r) => r.site_name))].sort();
    const prev = sel.value;
    sel.innerHTML = `<option value="">— all sites —</option>` +
      sites.map((s) => hstr`<option value="${s}">${s}</option>`).join("");
    sel.value = sites.includes(prev) ? prev : "";
    _renderTshirtsBySite();
    status.textContent = rows.length ? `${rows.length} selected players with t-shirts` : "No selected players with a t-shirt size yet.";
  }
  function _renderTshirtsBySite() {
    const sel = document.getElementById("tshirt-by-site-filter").value;
    const tbody = document.querySelector("#tshirt-by-site-table tbody");
    // Bucket: site → division → size → count
    const counts = new Map();
    for (const r of _tshirtBySiteRows) {
      if (sel && r.site_name !== sel) continue;
      const key = `${r.site_name}\t${r.age_division || ""}\t${r.t_shirt_size}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const entries = [...counts.entries()].sort();  // tab-delimited keys sort by site, then div, then size
    tbody.innerHTML = entries.map(([k, n]) => {
      const [site, div, size] = k.split("\t");
      return hstr`<tr><td>${site}</td><td>${div}</td><td>${size}</td><td class="num">${n}</td></tr>`;
    }).join("") || `<tr><td colspan="4" class="muted">Nothing to show for this site.</td></tr>`;
    const tot = [...counts.values()].reduce((a, b) => a + b, 0);
    document.getElementById("tshirt-by-site-totals").innerHTML =
      `<th colspan="3">Total shirts (filtered)</th><th class="num">${tot}</th>`;
  }
  document.getElementById("tshirt-by-site-filter")?.addEventListener("change", _renderTshirtsBySite);
  document.getElementById("tshirt-by-site-csv")?.addEventListener("click", () => {
    const active = getActive();
    const sel = document.getElementById("tshirt-by-site-filter").value;
    const filtered = sel ? _tshirtBySiteRows.filter((r) => r.site_name === sel) : _tshirtBySiteRows;
    const counts = new Map();
    for (const r of filtered) {
      const key = `${r.site_name}\t${r.age_division || ""}\t${r.t_shirt_size}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const matrix = [["Site", "Division", "Size", "Quantity"]];
    for (const [k, n] of [...counts.entries()].sort()) {
      const [site, div, size] = k.split("\t");
      matrix.push([site, div, size, n]);
    }
    _csvDownload(matrix, `tshirts-by-site-${active ? active.id : "t"}${sel ? "-" + sel.replace(/\W+/g, "_") : ""}`);
  });

  return { loadTshirts, loadTshirtOrder, loadTshirtsBySite };
}
