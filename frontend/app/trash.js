// Trash modal — soft-deleted tournaments / incidents restore (P2 #13) — D11.

export function installTrash(ctx) {
  const { api, toast, html, getActive, tournamentsCrud, loadIncidents } = ctx;

  // --- Trash (P2 #13): list + restore soft-deleted tournaments / incidents ---
  const _trashModal = document.getElementById("trash-modal");
  function _closeTrash() { _trashModal.hidden = true; }
  function _trashWhen(iso) {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function _renderTrash(data) {
    const body = document.getElementById("trash-body");
    const tRows = (data.tournaments || []).map((t) => html`
      <tr><td>${t.name}</td><td class="muted">${t.type} · ${t.play_start_date}→${t.play_end_date}</td>
      <td class="muted">${_trashWhen(t.deleted_at)}</td>
      <td><button type="button" class="btn-link" data-restore="tournament" data-id="${t.id}">Restore</button></td></tr>`);
    const iRows = (data.incidents || []).map((i) => html`
      <tr><td>${i.description}</td><td class="muted">${i.tournament_name} · ${i.category}/${i.severity}</td>
      <td class="muted">${_trashWhen(i.deleted_at)}</td>
      <td><button type="button" class="btn-link" data-restore="incident" data-id="${i.id}">Restore</button></td></tr>`);
    if (!tRows.length && !iRows.length) { body.innerHTML = '<p class="muted">Trash is empty — nothing to restore.</p>'; return; }
    body.innerHTML = html`
      ${tRows.length ? html`<h4>Tournaments</h4><table class="list-table"><thead><tr><th>Name</th><th>When</th><th>Trashed</th><th></th></tr></thead><tbody>${tRows}</tbody></table>` : ""}
      ${iRows.length ? html`<h4>Incidents</h4><table class="list-table"><thead><tr><th>What happened</th><th>Tournament</th><th>Trashed</th><th></th></tr></thead><tbody>${iRows}</tbody></table>` : ""}`;
  }
  async function _openTrash() {
    const body = document.getElementById("trash-body");
    body.innerHTML = '<p class="muted">Loading…</p>';
    _trashModal.hidden = false;
    try { _renderTrash(await api("/trash")); }
    catch (e) { body.innerHTML = html`<p class="msg-err">${e.message}</p>`; }
  }
  document.getElementById("trash-btn").addEventListener("click", _openTrash);
  document.getElementById("trash-close").addEventListener("click", _closeTrash);
  _trashModal.addEventListener("click", (e) => { if (e.target.id === "trash-modal") _closeTrash(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !_trashModal.hidden) _closeTrash(); });
  document.getElementById("trash-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-restore]");
    if (!btn) return;
    const { restore: kind, id } = btn.dataset;
    try {
      if (kind === "tournament") {
        await api(`/tournaments/${id}/restore`, { method: "POST" });
        tournamentsCrud.refresh();        // back into the Setup list + active picker
      } else {
        await api(`/incidents/${id}/restore`, { method: "POST" });
        if (getActive()) loadIncidents();
      }
      toast("Restored", true);
      _openTrash();                       // refresh the trash list in place
    } catch (err) { toast(err.message, false); }
  });
}
