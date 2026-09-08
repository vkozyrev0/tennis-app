// Session notice log — keeps timed-out toasts reviewable without a DB table.
// UI chrome ("saved", validation) is not operational audit; assignment /
// access / export trails already cover durable events.

const MAX = 100;
const KEY = "courtops-notices";

function _read(store) {
  if (!store || typeof store.getItem !== "function") return [];
  try {
    const rows = JSON.parse(store.getItem(KEY) || "[]");
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  }
}

export function createNoticeLog({ storage } = {}) {
  const store = storage !== undefined
    ? storage
    : (typeof sessionStorage !== "undefined" ? sessionStorage : null);
  let items = _read(store);

  function persist() {
    if (!store || typeof store.setItem !== "function") return;
    try { store.setItem(KEY, JSON.stringify(items.slice(0, MAX))); } catch (_) { /* quota */ }
  }

  function record(entry) {
    const text = String(entry?.text || "").trim();
    if (!text) return null;
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: entry.at || new Date().toISOString(),
      ok: entry.ok !== false,
      sticky: !!entry.sticky,
      text: text.slice(0, 2000),
    };
    items = [row, ...items].slice(0, MAX);
    persist();
    if (typeof document !== "undefined") {
      document.dispatchEvent(new CustomEvent("courtops-notice", { detail: row }));
    }
    return row;
  }

  function list() { return items.slice(); }
  function clear() { items = []; persist(); }

  return { record, list, clear };
}

/**
 * Notifications → Notices page. `notices` is the createNoticeLog() instance from shell.
 */
export function createNoticesPanel(ctx) {
  const { notices, html, activateGroup } = ctx;

  function _fmt(iso) {
    try {
      return new Date(iso).toLocaleString([], {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch (_) { return iso || ""; }
  }

  function loadNotices() {
    const body = document.querySelector("#notices-table tbody");
    if (!body) return;
    const rows = notices.list();
    body.innerHTML = rows.length
      ? rows.map((r) => html`<tr class="${r.ok ? "" : "notice-bad"}">
          <td>${_fmt(r.at)}</td>
          <td>${r.ok ? "OK" : "Error"}</td>
          <td>${r.text}</td>
        </tr>`).join("")
      : `<tr><td class="empty" colspan="3">No notices yet — toasts from this session appear here after they time out.</td></tr>`;
    const n = document.getElementById("notices-count");
    if (n) {
      const bad = rows.filter((r) => !r.ok).length;
      n.hidden = !bad;
      n.textContent = bad ? String(bad) : "";
    }
  }

  function openNotices() {
    if (typeof activateGroup === "function") activateGroup("notifications");
    const tab = document.querySelector('.tab[data-target="panel-notices"]');
    if (tab) tab.click();
    else loadNotices();
  }

  document.getElementById("notices-btn")?.addEventListener("click", openNotices);
  document.getElementById("notices-clear")?.addEventListener("click", () => {
    notices.clear();
    loadNotices();
  });
  document.addEventListener("courtops-notice", () => {
    const panel = document.getElementById("panel-notices");
    if (panel && panel.classList.contains("active")) loadNotices();
    const n = document.getElementById("notices-count");
    if (n) {
      const bad = notices.list().filter((r) => !r.ok).length;
      n.hidden = !bad;
      n.textContent = bad ? String(bad) : "";
    }
  });

  return { loadNotices, openNotices };
}
