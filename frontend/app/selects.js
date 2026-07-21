// Shared <select> refresh + Part B player-ref helpers (D11 slice from app.js).
import { fillSelect } from "./ui.js";
import { officialLabel, siteLabel, playerLabel } from "./labels.js";
import { hstr } from "./html.js";

/**
 * @param {{
 *   getOfficialsById: () => Record<string|number, object>,
 *   getSitesById: () => Record<string|number, object>,
 *   getPlayersById: () => Record<string|number, object>,
 *   getHotelsById: () => Record<string|number, object>,
 *   getPlayersCrud: () => { refresh?: () => Promise<any> } | undefined,
 * }} ctx
 */
export function createSelectRefresh(ctx) {
  const {
    getOfficialsById, getSitesById, getPlayersById, getHotelsById, getPlayersCrud,
  } = ctx;

  let _refreshAllSelectsScheduled = false;
  function refreshAllSelects() {
    // Setup CRUDs each call this from onLoad — coalesce via rAF (5+ fires per paint).
    if (_refreshAllSelectsScheduled) return;
    _refreshAllSelectsScheduled = true;
    requestAnimationFrame(() => {
      _refreshAllSelectsScheduled = false;
      _refreshAllSelectsImpl();
    });
  }

  function _refreshAllSelectsImpl() {
    const officialsById = getOfficialsById();
    const sitesById = getSitesById();
    const playersById = getPlayersById();
    const hotelsById = getHotelsById();
    fillSelect(document.getElementById("dist-official"), Object.values(officialsById), officialLabel, false);
    fillSelect(document.getElementById("dist-site"), Object.values(sitesById), siteLabel, false);
    fillSelect(document.getElementById("roster-player"), Object.values(playersById), playerLabel, false);
    fillSelect(document.getElementById("asg-official"), Object.values(officialsById), officialLabel, false);
    // asg-site is filled per-tournament in loadAssignments() — not here.
    fillSelect(document.getElementById("trb-hotel"), Object.values(hotelsById), (h) => h.name, false);
    fillPlayerRefs();
    const dl = document.getElementById("known-hotels");
    if (dl) {
      dl.innerHTML = Object.values(hotelsById)
        .map((h) => hstr`<option value="${h.name}"></option>`).join("");
    }
  }

  // Part B: fill any select.player-ref from the Players catalog.
  function fillPlayerRef(sel) {
    if (!sel) return;
    const playersById = getPlayersById();
    const cur = sel.value;
    const blank = sel.name === "partner_ref" ? "— none —" : "— select player —";
    sel.innerHTML = `<option value="">${blank}</option>`;
    for (const p of Object.values(playersById)) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = playerLabel(p);
      sel.appendChild(o);
    }
    sel.value = cur;
  }
  function fillPlayerRefs() {
    document.querySelectorAll("select.player-ref").forEach(fillPlayerRef);
  }

  // Expand chosen player id into usta_number/first_name/last_name on body `b`.
  function expandPlayerRef(b, field = "player_ref") {
    const playersById = getPlayersById();
    const id = b[field];
    delete b[field];
    if (!id) return b;
    const p = playersById[id];
    if (!p) {
      // Audit M21 + N10: stale cache — kick refresh; fail this submit cleanly.
      const playersCrud = getPlayersCrud();
      if (playersCrud && playersCrud.refresh) {
        playersCrud.refresh().catch(() => {});
      }
      throw new Error(
        "selected player isn't loaded — refreshing the player list, try again in a moment",
      );
    }
    b.usta_number = p.usta_number;
    b.first_name = p.first_name || null;
    b.last_name = p.last_name || null;
    return b;
  }

  return { refreshAllSelects, fillPlayerRef, fillPlayerRefs, expandPlayerRef };
}
