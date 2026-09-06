// Auth / session / role-view wiring (plan P2 #11b) — extracted from app.js.
//
// Owns: applyAuth (the login/admin/official view toggle), the login + logout +
// change-password form wiring, account overflow menu, and the one-shot
// "session expired" listener.
// What to LOAD when the role resolves (admin vs official init, nav-history,
// breadcrumbs) is app-specific, so it stays in app.js and is injected as the
// onRoleResolved / onLogout callbacks — the same dependency-injection seam
// grids.js uses.
import { makeMenuButton } from "./ui.js";
import { syncSkipLink } from "./skip_link.js";

export function createAuth(ctx) {
  const { api, setMsg, toast, onSubmit, onRoleResolved, onLogout } = ctx;

  const _cpwModal = document.getElementById("change-pw-modal");
  const _trashBtn = document.getElementById("trash-btn");
  const _cpwBtn = document.getElementById("change-pw-btn");
  const _logoutBtn = document.getElementById("logout-btn");

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

  // Toolbar P1: collapse Trash / Change password / Log out into username ▾.
  // Hidden buttons keep existing listeners (trash.js, logout below).
  function _installAccountMenu() {
    const host = document.getElementById("account-menu-host");
    if (!host || host.dataset.ready === "1") return;
    const menu = makeMenuButton(
      `<span id="username-label"></span>`,
      [
        {
          label: "Trash",
          title: "Restore trashed tournaments or incidents",
          onClick: () => _trashBtn?.click(),
        },
        {
          label: "Change password",
          onClick: () => _cpwBtn?.click(),
        },
        {
          label: "Notices",
          title: "Review recent toasts and alerts from this session",
          onClick: () => document.getElementById("notices-btn")?.click(),
        },
        { separator: true },
        {
          label: "Log out",
          danger: true,
          onClick: () => _logoutBtn?.click(),
        },
      ],
      {
        className: "hdr-btn account-menu-btn",
        title: "Account menu",
        anchor: true,
      },
    );
    menu.classList.add("account-menu-wrap");
    host.replaceWith(menu);
    // mark so we don't double-install if createAuth is ever re-entered
    menu.dataset.ready = "1";
  }
  _installAccountMenu();

  // Role-based view switch. The pure DOM show/hide lives here; the app-specific
  // reactions (nav history, breadcrumbs, adminInit/officialInit) run via the
  // injected onRoleResolved so this module stays free of those dependencies.
  function applyAuth(who) {
    const logged = !!who;
    const mustChange = !!(who && who.must_change_password);
    // Hard lock only when the API will 403 (prod / COURTOPS_FORCE_PASSWORD_CHANGE).
    // Local docker still gets a nudge on the account menu so admin/admin can run the desk.
    const forced = !!(who && who.password_change_required);
    const isAdmin = logged && who && who.role === "admin" && !forced;
    const isOfficial = logged && who && who.role === "official" && !forced;
    document.body.classList.toggle("is-signed-out", !logged);
    document.body.classList.toggle("is-admin", isAdmin);
    document.body.classList.toggle("is-official", isOfficial);
    document.getElementById("login-view").hidden = logged;
    document.getElementById("user-box").hidden = !logged;
    const label = document.getElementById("username-label");
    if (label) {
      const roleLabel = who?.role === "admin" ? "TD" : who?.role === "official" ? "Official" : (who?.role || "");
      label.textContent = who ? `${who.username} · ${roleLabel}` : "";
      if (label.parentElement) {
        label.parentElement.title = mustChange
          ? "Change password recommended (demo default)"
          : "Account menu";
      }
    }
    document.getElementById("menu").hidden = !isAdmin;
    document.getElementById("menu-groups").hidden = !isAdmin;
    document.querySelector("main:not(#official-app)").hidden = !isAdmin;
    document.getElementById("context-bar").hidden = !isAdmin;
    document.getElementById("official-app").hidden = !isOfficial;
    syncSkipLink(document.querySelector(".skip-link"), isOfficial ? "official" : "admin");
    const officialBar = document.getElementById("official-bar");
    if (officialBar) officialBar.hidden = !isOfficial;

    const cancel = document.getElementById("cpw-cancel");
    if (_cpwModal) {
      if (forced) {
        _cpwModal.dataset.forced = "1";
        if (cancel) cancel.hidden = true;
        queueMicrotask(() => {
          _openChangePw();
          const el = document.getElementById("cpw-msg");
          if (el) {
            el.textContent = "Set a new password before using CourtOps. The demo default is not allowed on shared hosts.";
            el.className = "msg bad";
            el.setAttribute("role", "alert");
          }
        });
      } else {
        _cpwModal.dataset.forced = "";
        if (cancel) cancel.hidden = false;
      }
    }

    onRoleResolved({ who, logged, isAdmin, isOfficial, mustChange, forced });
  }

  // Audit F3: one-shot listener so a stray flood of expired-session 401s
  // doesn't trigger a toast storm.
  let _authExpiredFired = false;
  document.addEventListener("auth-expired", () => {
    if (_authExpiredFired) return;
    _authExpiredFired = true;
    const alreadyOut = document.body.classList.contains("is-signed-out");
    if (!alreadyOut) toast("Session expired — please sign in again", false, { sticky: true });
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
  _logoutBtn.addEventListener("click", async () => {
    try { await api("/auth/logout", { method: "POST" }); } catch (e) { /* ignore */ }
    onLogout();
    applyAuth(null);
  });

  _cpwBtn.addEventListener("click", _openChangePw);
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
