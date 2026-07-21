// Per-tab + Inbox group count badges (D11 slice from app.js).

export const NAV_COUNT_TABS = {
  "panel-t-inbox": "inbox_unfiled",
  "panel-t-late": "late_entries",
  "panel-t-withdrawals": "withdrawals",
  "panel-t-sched": "scheduling",
  "panel-t-divflex": "div_flex",
  "panel-t-pairing": "pairing",
  "panel-t-doubles": "doubles",
  "panel-t-photels": "player_hotels",
};

function setNavBadge(el, n) {
  if (!el) return;
  let b = el.querySelector(":scope > .tab-badge");
  if (!n) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement("span");
    b.className = "tab-badge";
    el.appendChild(b);
  }
  b.textContent = n > 99 ? "99+" : String(n);
}

/**
 * @param {{
 *   api: (path: string) => Promise<any>,
 *   getActive: () => { id: number } | null,
 *   getGroupsEl: () => HTMLElement | null,
 * }} ctx
 */
export function createNavCounts(ctx) {
  const { api, getActive, getGroupsEl } = ctx;

  async function refreshNavCounts() {
    const groupsEl = getGroupsEl();
    const inboxBtn = groupsEl?.querySelector('.gbtn[data-group="inbox"]');
    const active = getActive();
    if (!active) {
      Object.keys(NAV_COUNT_TABS).forEach((pid) =>
        setNavBadge(document.querySelector(`.tab[data-target="${pid}"]`), 0));
      setNavBadge(inboxBtn, 0);
      return;
    }
    let counts;
    try { counts = await api(`/tournaments/${active.id}/nav-counts`); }
    catch (_) { return; }
    for (const [pid, key] of Object.entries(NAV_COUNT_TABS)) {
      setNavBadge(document.querySelector(`.tab[data-target="${pid}"]`), counts[key] || 0);
    }
    setNavBadge(inboxBtn, counts.inbox_unfiled || 0);
  }

  return { refreshNavCounts, NAV_COUNT_TABS, setNavBadge };
}
