// Auth / session / role-view wiring (plan P2 #11b) — extracted from app.js.
//
// Owns: applyAuth (the login/admin/official view toggle), the login + logout +
// change-password form wiring, and the one-shot "session expired" listener.
// What to LOAD when the role resolves (admin vs official init, nav-history,
// breadcrumbs) is app-specific, so it stays in app.js and is injected as the
// onRoleResolved / onLogout callbacks — the same dependency-injection seam
// grids.js uses. The bodies are otherwise unchanged from the in-app version.
export function createAuth(ctx) {
  const { api, setMsg, toast, onSubmit, onRoleResolved, onLogout } = ctx;

  // Role-based view switch. The pure DOM show/hide lives here; the app-specific
  // reactions (nav history, breadcrumbs, adminInit/officialInit) run via the
  // injected onRoleResolved so this module stays free of those dependencies.
  function applyAuth(who) {
    const logged = !!who;
    const isAdmin = logged && who.role === "admin";
    const isOfficial = logged && who.role === "official";
    document.getElementById("login-view").hidden = logged;
    document.getElementById("user-box").hidden = !logged;
    document.getElementById("username-label").textContent = who ? `${who.username} (${who.role})` : "";
    document.getElementById("menu").hidden = !isAdmin;
    document.getElementById("menu-groups").hidden = !isAdmin;
    document.querySelector("main:not(#official-app)").hidden = !isAdmin;
    document.getElementById("context-bar").hidden = !isAdmin;
    document.getElementById("official-app").hidden = !isOfficial;
    onRoleResolved({ who, logged, isAdmin, isOfficial });
  }

  // Audit F3: one-shot listener so a stray flood of expired-session 401s
  // doesn't trigger a toast storm.
  let _authExpiredFired = false;
  document.addEventListener("auth-expired", () => {
    if (_authExpiredFired) return;
    _authExpiredFired = true;
    toast("Session expired — please sign in again", false);
    applyAuth(null);
    setTimeout(() => { _authExpiredFired = false; }, 1000);
  });

  onSubmit(document.getElementById("login-form"), async (e) => {
    const f = e.target;
    try {
      const who = await api("/auth/login", { method: "POST", body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
      f.reset();
      applyAuth(who);
    } catch (err) { setMsg("login-msg", err.message, false); }
  });
  document.getElementById("logout-btn").addEventListener("click", async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    onLogout();
    applyAuth(null);
  });

  // --- Change own password (admin or official; available from the header) ---
  const _cpwModal = document.getElementById("change-pw-modal");
  function _openChangePw() {
    document.getElementById("change-pw-form").reset();
    setMsg("cpw-msg", "", true);
    _cpwModal.hidden = false;
    document.getElementById("cpw-current").focus();
  }
  function _closeChangePw() { _cpwModal.hidden = true; }
  document.getElementById("change-pw-btn").addEventListener("click", _openChangePw);
  document.getElementById("cpw-cancel").addEventListener("click", _closeChangePw);
  _cpwModal.addEventListener("click", (e) => { if (e.target.id === "change-pw-modal") _closeChangePw(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !_cpwModal.hidden) _closeChangePw(); });
  onSubmit(document.getElementById("change-pw-form"), async () => {
    const cur = document.getElementById("cpw-current").value;
    const nw = document.getElementById("cpw-new").value;
    const cf = document.getElementById("cpw-confirm").value;
    if (nw !== cf) { setMsg("cpw-msg", "new passwords don't match", false); return; }
    if (nw.length < 8) { setMsg("cpw-msg", "new password must be at least 8 characters", false); return; }
    if (nw === cur) { setMsg("cpw-msg", "new password must differ from the current one", false); return; }
    try {
      await api("/auth/change-password", { method: "POST", body: JSON.stringify({ current_password: cur, new_password: nw }) });
      _closeChangePw();
      toast("Password updated — other devices were signed out", true);
    } catch (e) { setMsg("cpw-msg", e.message, false); }
  });

  return { applyAuth };
}
