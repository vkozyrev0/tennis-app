// Setup → Admin users (multi-user TD access, D8) — D11.

export function installAdminUsers(ctx) {
  const { api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit, hstr, raw } = ctx;

  // --- Admin users (Setup; multi-user TD access, D8) ---
  const userForm = document.getElementById("user-form");
  async function loadUsers() {
    let me = null;
    try { me = await api("/auth/me"); } catch (_) {}
    const rows = await api("/admin/users");
    const tb = document.querySelector("#user-table tbody");
    tb.innerHTML = "";
    if (!rows.length) { tb.innerHTML = '<tr><td class="empty" colspan="3">No admin users.</td></tr>'; return; }
    for (const u of rows) {
      const isSelf = me && u.username === me.username;
      const tr = document.createElement("tr");
      const nameCell = document.createElement("td");
      nameCell.innerHTML = hstr`${u.username}${isSelf ? raw(' <span class="badge badge-info">you</span>') : ""}`;
      const dateCell = document.createElement("td");
      dateCell.textContent = (u.created_at || "").slice(0, 10);
      const actCell = document.createElement("td"); actCell.className = "grid-actions-cell";
      const reset = document.createElement("button");
      reset.type = "button"; reset.className = "btn-link"; reset.textContent = "Reset password";
      reset.addEventListener("click", async () => {
        const pw = window.prompt(`New password for ${u.username}:`);
        if (!pw) return;
        try {
          await api(`/admin/users/${u.id}/password`, { method: "POST", body: JSON.stringify({ password: pw }) });
          toast(`Password reset — ${u.username} must sign in again`, true);
        } catch (e) { toast(e.message, false); }
      });
      actCell.appendChild(reset);
      if (!isSelf) {  // can't delete your own account (the backend also guards this)
        const del = document.createElement("button");
        del.type = "button"; del.className = "btn-link danger"; del.textContent = "Delete";
        del.addEventListener("click", async () => {
          if (!(await confirmDialog(`Delete admin "${u.username}"?`))) return;
          try { await api(`/admin/users/${u.id}`, { method: "DELETE" }); loadUsers(); }
          catch (e) { toast(e.message, false); }
        });
        actCell.append(" ", del);
      }
      tr.append(nameCell, dateCell, actCell);
      tb.appendChild(tr);
    }
  }
  onSubmit(userForm, async () => {
    try {
      await api("/admin/users", { method: "POST", body: JSON.stringify(formObj(userForm)) });
      setMsg("user-msg", "admin added", true); userForm.reset(); loadUsers();
    } catch (err) { setMsg("user-msg", err.message, false); markInvalid(userForm, err.message); }
  });

  return { loadUsers };
}
