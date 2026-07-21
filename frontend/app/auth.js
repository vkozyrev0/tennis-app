// Auth / session / role-view wiring (plan P2 #11b) — extracted from app.js.
//
// Owns: applyAuth (the login/admin/official view toggle), the login + logout +
// change-password form wiring, and the one-shot "session expired" listener.
// What to LOAD when the role resolves (admin vs official init, nav-history,
// breadcrumbs) is app-specific, so it stays in app.js and is injected as the
// onRoleResolved / onLogout callbacks — the same dependency-injection seam
// grids.js uses.
export function createAuth(ctx) {
  const { api, setMsg, toast, onSubmit, onRoleResolved, onLogout } = ctx;

  const _cpwModal = document.getElementById("change-pw-modal");

  function _openChangePw() {
    document.getElementById("change-pw-form").reset();
    setMsg("cpw-msg", "", true);
    _cpwModal.hidden = false;
    document.getElementById("cpw-current").focus();
  }

  function _closeChangePw() {
    // D3: refuse dismiss while a forced change is pending.
    if (_cpwModal.dataset.forced === "1") return;
    _cpwModal.hidden = true;
  }

  // Role-based view switch. The pure DOM show/hide lives here; the app-specific
  // reactions (nav history, breadcrumbs, adminInit/officialInit) run via the
  // injected onRoleResolved so this module stays free of those dependencies.
  function applyAuth(who) {
    const logged = !!who;
    const mustChange = !!(who && who.must_change_password);
    // D3: until password is rotated, keep chrome minimal and force the modal.
    // Full admin/official init still runs only when not forced; prod API 403s.
    const isAdmin = logged && who && who.role === "admin" && !mustChange;
    const isOfficial = logged && who && who.role === "official" && !mustChange;
    document.getElementById("login-view").hidden = logged;
    document.getElementById("user-box").hidden = !logged;
    document.getElementById("username-label").textContent = who
      ? `${who.username} (${who.role})${mustChange ? " — change password" : ""}`
      : "";
    document.getElementById("menu").hidden = !isAdmin;
    document.getElementById("menu-groups").hidden = !isAdmin;
    document.querySelector("main:not(#official-app)").hidden = !isAdmin;
    document.getElementById("context-bar").hidden = !isAdmin;
    document.getElementById("official-app").hidden = !isOfficial;

    const cancel = document.getElementById("cpw-cancel");
    if (_cpwModal) {
      if (mustChange) {
        _cpwModal.dataset.forced = "1";
        if (cancel) cancel.hidden = true;
        queueMicrotask(() => {
          _openChangePw();
          setMsg(
            "cpw-msg",
            "You must set a new password before using CourtOps (the POC default is not allowed on shared hosts).",
            false,
          );
        });
      } else {
        _cpwModal.dataset.forced = "";
        if (cancel) cancel.hidden = false;
      }
    }

    onRoleResolved({ who, logged, isAdmin, isOfficial, mustChange });
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
      const who = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: f.username.value, password: f.password.value }),
      });
      f.reset();
      applyAuth(who);
    } catch (err) { setMsg("login-msg", err.message, false); }
  });
  document.getElementById("logout-btn").addEventListener("click", async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    onLogout();
    applyAuth(null);
  });

  document.getElementById("change-pw-btn").addEventListener("click", _openChangePw);
  document.getElementById("cpw-cancel").addEventListener("click", _closeChangePw);
  _cpwModal.addEventListener("click", (e) => {
    if (e.target.id === "change-pw-modal") _closeChangePw();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !_cpwModal.hidden) _closeChangePw();
  });
  onSubmit(document.getElementById("change-pw-form"), async () => {
    const cur = document.getElementById("cpw-current").value;
    const nw = document.getElementById("cpw-new").value;
    const cf = document.getElementById("cpw-confirm").value;
    if (nw !== cf) { setMsg("cpw-msg", "new passwords don't match", false); return; }
    if (nw.length < 8) { setMsg("cpw-msg", "new password must be at least 8 characters", false); return; }
    if (nw === cur) { setMsg("cpw-msg", "new password must differ from the current one", false); return; }
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ current_password: cur, new_password: nw }),
      });
      _cpwModal.dataset.forced = "";
      _cpwModal.hidden = true;
      toast("Password updated — other devices were signed out", true);
      try {
        const who = await api("/auth/me");
        applyAuth(who);
      } catch (_) { /* ignore */ }
    } catch (e) { setMsg("cpw-msg", e.message, false); }
  });

  return { applyAuth };
}
