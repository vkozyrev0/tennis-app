/** Client inactivity timer: warn, then expire. Injectable clock for tests.

Server cookies last days and slide on API calls, so this idle window (not
cookie TTL) drives the continue prompt. Continue may ping `/api/auth/me`.
Expire should use the same signed-out path as `auth-expired`.
*/

export const IDLE_MS = 15 * 60 * 1000;
export const WARN_BEFORE_MS = 2 * 60 * 1000;

/**
 * @param {{
 *   now?: () => number,
 *   setTimeout?: (fn: Function, ms: number) => any,
 *   clearTimeout?: (id: any) => void,
 *   idleMs?: number,
 *   warnBeforeMs?: number,
 *   onWarn?: () => void,
 *   onExpire?: () => void,
 *   ping?: () => Promise<unknown>|unknown,
 * }} [opts]
 */
export function createInactivityGuard(opts = {}) {
  const now = opts.now || (() => Date.now());
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const warnBeforeMs = opts.warnBeforeMs ?? WARN_BEFORE_MS;
  const onWarn = typeof opts.onWarn === "function" ? opts.onWarn : () => {};
  const onExpire = typeof opts.onExpire === "function" ? opts.onExpire : () => {};
  const ping = opts.ping;

  let state = "stopped";
  let lastActivity = 0;
  let warnTimer = null;
  let expireTimer = null;

  function clearTimers() {
    if (warnTimer != null) clearT(warnTimer);
    if (expireTimer != null) clearT(expireTimer);
    warnTimer = null;
    expireTimer = null;
  }

  function expire() {
    if (state === "stopped" || state === "expired") return;
    state = "expired";
    clearTimers();
    onExpire();
  }

  function warn() {
    if (state !== "idle") return;
    state = "warn";
    onWarn();
  }

  function arm() {
    clearTimers();
    if (state === "stopped" || state === "expired") return;
    const t = now();
    const expireAt = lastActivity + idleMs;
    const warnAt = expireAt - Math.min(warnBeforeMs, idleMs);
    if (t >= expireAt) {
      expire();
      return;
    }
    if (state !== "warn") {
      if (t >= warnAt) warn();
      else warnTimer = setT(() => warn(), warnAt - t);
    }
    expireTimer = setT(() => expire(), expireAt - t);
  }

  return {
    start() {
      lastActivity = now();
      state = "idle";
      arm();
    },
    stop() {
      state = "stopped";
      clearTimers();
    },
    /** User activity. Ignored while the continue prompt is showing. */
    activity() {
      if (state !== "idle") return;
      lastActivity = now();
      arm();
    },
    /** Continue on the warn modal: stay signed in and reset the idle window. */
    async continue() {
      if (state !== "warn") return false;
      lastActivity = now();
      state = "idle";
      arm();
      if (typeof ping === "function") {
        try { await ping(); } catch (_) { /* offline: local session still extended */ }
      }
      return true;
    },
    getState() {
      return state;
    },
  };
}
