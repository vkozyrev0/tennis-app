// Active-tournament state event (plan P2 #11c) — a single declared place for
// "the active tournament changed" so the cascade of reactions (UI refresh,
// dashboard sync, …) is registered in one list of subscribers instead of being
// hardcoded inline in setActive/updateActiveUI.
//
// `active` itself stays a module-global in app.js (it's read by hundreds of
// `if (!active) return` guards that can't all take an import), so this module
// owns only the EVENT, not the value: setActive() calls emit({active, prev})
// after it mutates the global, and subscribers registered via onChange() react.
export function createTournamentState() {
  const target = new EventTarget();
  return {
    // Register a reaction to an active-tournament change. detail = {active, prev}.
    onChange(fn) { target.addEventListener("active-changed", (e) => fn(e.detail)); },
    // Fire after the active tournament is set/cleared/switched.
    emit(detail) { target.dispatchEvent(new CustomEvent("active-changed", { detail })); },
  };
}
