// Pairing avoidances + doubles pairing panels — D11.
import { makeOriginCol } from './origin_col.js';

export function createPairingDoublesPanel(ctx) {
  const {
    api,
    setMsg,
    confirmDialog,
    markInvalid,
    formObj,
    onSubmit,
    hstr,
    chip,
    makeListGrid,
    fillPlayerRef,
    enhanceSelect,
    divisionListParams,
    rowGender,
    playerCell,
    getActive,
    getPlayersById,
    loadInbox
  } = ctx;
  const _ORIGIN_COL = makeOriginCol({ hstr });

  // --- Pairing avoidances (juniors; group of 2+ players) ---
  const pairingForm = document.getElementById("pairing-form");
  const pairingMembersBox = document.getElementById("pairing-members");
  function pairingMemberRow() {
    const div = document.createElement("div"); div.className = "row pmember";
    const lbl = document.createElement("label"); lbl.textContent = "Player ";
    const sel = document.createElement("select"); sel.className = "pm-player player-ref";
    lbl.appendChild(sel); div.appendChild(lbl);
    const del = document.createElement("button"); del.type = "button"; del.className = "btn-link danger"; del.textContent = "×";
    del.addEventListener("click", () => { div.remove(); if (!pairingMembersBox.children.length) pairingMemberRow(); });
    div.appendChild(del); pairingMembersBox.appendChild(div);
    fillPlayerRef(sel);     // reference the existing Players list
    enhanceSelect(sel);     // type-in searchable dropdown
  }
  function pairingReset() { pairingForm.reset(); pairingForm.source_email_id.value = ""; pairingMembersBox.innerHTML = ""; pairingMemberRow(); pairingMemberRow(); }
  document.getElementById("pairing-add-member").addEventListener("click", pairingMemberRow);
  const pairingGrid = makeListGrid("pairing-table", [
    { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell", editorParams: (cell) => divisionListParams({ gender: rowGender(cell.getData()) }) },
    { title: "Relationship", field: "relationship", editor: "list", cssClass: "editable-cell",
      editorParams: { values: ["same_club", "siblings"] } },
    { title: "Players", field: "_players",
      formatter: (c) => hstr`${(c.getData().members || []).map((m) => [m.last_name, m.first_name].filter(Boolean).join(", ") || m.usta_number).join(" & ")}` },
    _ORIGIN_COL,
  ], "pairing-avoidances", "No pairing avoidances yet.",
    async (g) => { if (!(await confirmDialog("Delete group?"))) return; try { await api(`/pairing-avoidances/${g.id}`, { method: "DELETE" }); loadPairing(); } catch (e) { setMsg("pairing-msg", e.message, false); } },
    undefined,
    async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const g = cell.getRow().getData();
      try {
        await api(`/pairing-avoidances/${g.id}`, { method: "PUT", body: JSON.stringify({
          age_division: g.age_division || null, relationship: g.relationship || null,
        }) });
        setMsg("pairing-msg", "saved", true); loadPairing();
      } catch (err) { setMsg("pairing-msg", err.message, false); try { cell.restoreOldValue(); } catch (_) {} loadPairing(); }
    },
    // Fifth-pass #2: wide-format columns matching importer.TYPES["pairing_avoidances"].
    // Emit up to 6 USTA #s + division + relationship so the CSV round-trips.
    [
      { header: "usta_1", key: "_u1", fmt: (r) => (r.members?.[0]?.usta_number) || "" },
      { header: "usta_2", key: "_u2", fmt: (r) => (r.members?.[1]?.usta_number) || "" },
      { header: "usta_3", key: "_u3", fmt: (r) => (r.members?.[2]?.usta_number) || "" },
      { header: "usta_4", key: "_u4", fmt: (r) => (r.members?.[3]?.usta_number) || "" },
      { header: "usta_5", key: "_u5", fmt: (r) => (r.members?.[4]?.usta_number) || "" },
      { header: "usta_6", key: "_u6", fmt: (r) => (r.members?.[5]?.usta_number) || "" },
      { header: "age_division", key: "age_division" },
      { header: "relationship", key: "relationship" },
      { header: "source_email_id", key: "source_email_id" },
    ]);
  async function loadPairing() {
    if (!getActive()) return;
    pairingGrid.setData(await api(`/tournaments/${getActive().id}/pairing-avoidances`));
  }
  onSubmit(pairingForm, async (e) => {
    if (!getActive()) return;
    const members = [...pairingMembersBox.querySelectorAll(".pmember")].map((r) => {
      const p = getPlayersById()[r.querySelector(".pm-player").value];
      return p ? { usta_number: p.usta_number, first_name: p.first_name || null, last_name: p.last_name || null } : null;
    }).filter(Boolean);
    if (members.length < 2) { setMsg("pairing-msg", "select at least two players", false); return; }
    const body = {
      age_division: pairingForm.age_division.value || null,
      relationship: pairingForm.relationship.value,
      members,
      source_email_id: pairingForm.source_email_id.value ? Number(pairingForm.source_email_id.value) : null,
    };
    try { await api(`/tournaments/${getActive().id}/pairing-avoidances`, { method: "POST", body: JSON.stringify(body) }); setMsg("pairing-msg", "added", true); pairingReset(); loadPairing(); loadInbox(); }
    catch (err) { setMsg("pairing-msg", err.message, false); markInvalid(pairingForm, err.message); }
  });
  pairingForm.querySelector(".cancel").addEventListener("click", pairingReset);
  pairingReset();

  // --- Doubles pairing (mutual two-sided verification + random FIFO queue) ---
  const doublesForm = document.getElementById("doubles-form");
  function doublesSyncRandom() {
    document.getElementById("doubles-partner-wrap").style.display =
      document.getElementById("doubles-random").checked ? "none" : "";
  }
  document.getElementById("doubles-random").addEventListener("change", doublesSyncRandom);
  function doublesReset() { doublesForm.reset(); doublesForm.source_email_id.value = ""; doublesSyncRandom(); }
  const doublesReqGrid = makeListGrid("doubles-req-table", [
    { title: "Player", field: "last_name", formatter: playerCell },
    { title: "USTA #", field: "usta_number" },
    { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell", editorParams: (cell) => divisionListParams({ gender: rowGender(cell.getData()) }) },
    { title: "Type", field: "_type", formatter: (c) => chip(c.getData().wants_random ? "random" : "mutual") },
    { title: "Partner status", field: "_info",
      formatter: (c) => {
        const r = c.getData();
        if (r.status === "paired") return "paired";
        if (r.wants_random) return "queued (waiting)";
        // Show the partner's name (looked up by USTA #) instead of the raw code,
        // since the TD reads names, not USTA numbers, when scanning the queue.
        const partner = r.partner_usta ? Object.values(getPlayersById()).find((p) => p.usta_number === r.partner_usta) : null;
        const label = partner ? [partner.last_name, partner.first_name].filter(Boolean).join(", ") || partner.usta_number : (r.partner_usta || "?");
        return hstr`→ ${label} (awaiting partner)`;
      } },
    _ORIGIN_COL,
  ], "doubles-requests", "No doubles requests yet.",
    async (r) => { if (!(await confirmDialog("Delete request?"))) return; try { await api(`/doubles-requests/${r.id}`, { method: "DELETE" }); loadDoubles(); } catch (e) { setMsg("doubles-msg", e.message, false); } },
    undefined,
    async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const r = cell.getRow().getData();
      try { await api(`/doubles-requests/${r.id}`, { method: "PUT", body: JSON.stringify({ age_division: r.age_division || null }) }); setMsg("doubles-msg", "saved", true); loadDoubles(); }
      catch (e) { setMsg("doubles-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadDoubles(); }
    },
    // Fifth-pass #2: re-importable columns for doubles requests.
    [
      { header: "usta_number", key: "usta_number" },
      { header: "first_name", key: "first_name" },
      { header: "last_name", key: "last_name" },
      { header: "age_division", key: "age_division" },
      { header: "wants_random", key: "wants_random" },
      { header: "partner_usta", key: "partner_usta" },
      { header: "source_email_id", key: "source_email_id" },
    ]);
  const doublesPairGrid = makeListGrid("doubles-pair-table", [
    { title: "Division", field: "age_division", editor: "list", cssClass: "editable-cell", editorParams: (cell) => divisionListParams({ gender: rowGender(cell.getData()) }) },
    { title: "Type", field: "pairing_type", formatter: (c) => chip(c.getData().pairing_type) },
    { title: "Player 1", field: "player1" },
    { title: "Player 2", field: "player2" },
  ], "doubles-pairs", "No verified pairs yet.",
    async (d) => { if (!(await confirmDialog("Delete pair?"))) return; try { await api(`/doubles-pairs/${d.id}`, { method: "DELETE" }); loadDoubles(); } catch (e) { setMsg("doubles-msg", e.message, false); } },
    undefined,
    async (cell) => {
      if (cell.getValue() === cell.getOldValue()) return;
      const d = cell.getRow().getData();
      try { await api(`/doubles-pairs/${d.id}`, { method: "PUT", body: JSON.stringify({ age_division: d.age_division || null }) }); setMsg("doubles-msg", "saved", true); loadDoubles(); }
      catch (e) { setMsg("doubles-msg", e.message, false); try { cell.restoreOldValue(); } catch (_) {} loadDoubles(); }
    },
    // Fifth-pass #2: pairs are derived (no importer), but emit a snake_case
    // CSV anyway so downstream tooling has stable headers; no source_email_id
    // (pairs aren't filed individually).
    [
      { header: "age_division", key: "age_division" },
      { header: "pairing_type", key: "pairing_type" },
      { header: "player1", key: "player1" },
      { header: "player2", key: "player2" },
      { header: "verified", key: "verified" },
    ]);
  async function loadDoubles() {
    if (!getActive()) return;
    const data = await api(`/tournaments/${getActive().id}/doubles`);
    doublesReqGrid.setData(data.requests);
    doublesPairGrid.setData(data.pairs);
  }
  onSubmit(doublesForm, async (e) => {
    if (!getActive()) return;
    const me = getPlayersById()[doublesForm.player_ref.value];
    if (!me) { setMsg("doubles-msg", "select a player", false); return; }
    const partner = doublesForm.partner_ref.value ? getPlayersById()[doublesForm.partner_ref.value] : null;
    const b = {
      usta_number: me.usta_number,
      first_name: me.first_name || null,
      last_name: me.last_name || null,
      age_division: doublesForm.age_division.value.trim() || null,
      wants_random: doublesForm.wants_random.checked,
      partner_usta: partner ? partner.usta_number : null,
      source_email_id: doublesForm.source_email_id.value ? Number(doublesForm.source_email_id.value) : null,
    };
    try {
      const res = await api(`/tournaments/${getActive().id}/doubles-requests`, { method: "POST", body: JSON.stringify(b) });
      setMsg("doubles-msg", res.paired ? "paired!" : (b.wants_random ? "queued" : "filed — awaiting partner"), true);
      doublesReset(); loadDoubles(); loadInbox();
    } catch (err) { setMsg("doubles-msg", err.message, false); markInvalid(doublesForm, err.message); }
  });
  doublesForm.querySelector(".cancel").addEventListener("click", doublesReset);

  return { loadPairing, loadDoubles };
}
