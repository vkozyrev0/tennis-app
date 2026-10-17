// Setup → Admin users (multi-user TD access, D8) — D11.

export function installAdminUsers(ctx) {
  const { api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit, hstr, raw } = ctx;

  // Masked new-password dialog. window.prompt showed the password on screen and
  // had no confirmation or length check.
  function _promptPassword(username) {
    return new Promise((resolve) => {
      const m = document.createElement("div"); m.className = "modal";
      m.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="upw-title">' +
        '<h3 class="detail-title" id="upw-title">Reset password</h3>' +
        hstr`<p class="muted">Set a new password for ${username}.</p>` +
        '<div class="row"><label>New password <input id="upw-new" type="password" autocomplete="new-password" minlength="8" /></label></div>' +
        '<div class="row"><label>Confirm password <input id="upw-confirm" type="password" autocomplete="new-password" minlength="8" /></label></div>' +
        '<p class="msg bad" id="upw-msg" hidden></p>' +
        '<div class="modal-actions"><button type="button" id="upw-ok">Reset password</button>' +
        '<button type="button" id="upw-cancel" class="cancel">Cancel</button></div></div>';
      document.body.appendChild(m);
      const close = (v) => { m.remove(); resolve(v); };
      const input = m.querySelector("#upw-new");
      const confirm = m.querySelector("#upw-confirm");
      const msg = m.querySelector("#upw-msg");
      const ok = () => {
        if (input.value.length < 8) {
          msg.hidden = false; msg.textContent = "Password must be at least 8 characters."; input.focus(); return;
        }
        if (input.value !== confirm.value) {
          msg.hidden = false; msg.textContent = "Passwords do not match."; confirm.focus(); return;
        }
        close(input.value);
      };
      m.querySelector("#upw-ok").addEventListener("click", ok);
      m.querySelector("#upw-cancel").addEventListener("click", () => close(null));
      m.addEventListener("click", (e) => { if (e.target === m) close(null); });
      m.addEventListener("keydown", (e) => { if (e.key === "Escape") close(null); });
      confirm.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } });
      input.focus();
    });
  }

  // --- Admin users (Setup; multi-user TD access, D8) ---
  const userForm = document.getElementById("user-form");
  async function loadUsers() {
    let me = null;
    try { me = await api("/auth/me"); } catch (_) {}
    const rows = await api("/admin/users");
    const tb = document.querySelector("#user-table tbody");
    tb.innerHTML = "";
    if (!rows.length) {
      tb.innerHTML = hstr`<tr><td class="empty" colspan="3">No admin users.</td></tr>`;
      return;
    }
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
        const pw = await _promptPassword(u.username);
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
