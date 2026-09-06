// Role-aware skip-to-content target. A single static href="#main-app" hides
// the official portal (the visible <main> when role=official).

export function skipHrefForRole(role) {
  return role === "official" ? "#official-app" : "#main-app";
}

/** Point the skip link at the visible app. Returns the href applied. */
export function syncSkipLink(skipEl, role) {
  const href = skipHrefForRole(role);
  if (skipEl && typeof skipEl.setAttribute === "function") {
    skipEl.setAttribute("href", href);
  }
  return href;
}
