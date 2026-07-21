// Global player/official search (top bar) — D11.

export function installGlobalSearch(ctx) {
  const { api, hstr, getActive, openPlayer360, openOfficial360 } = ctx;

  const input = document.getElementById("player-search");
  const box = document.getElementById("player-search-results");
  if (!input || !box) return;
  let timer = null;
  const close = () => { box.hidden = true; box.innerHTML = ""; input.setAttribute("aria-expanded", "false"); };
  const render = (rows, q) => {
    if (!rows.length) {
      box.innerHTML = hstr`<div class="ps-empty">No players or officials match “${q}”.</div>`;
    } else {
      box.innerHTML = rows.map((r) =>
        hstr`<button type="button" class="ps-item" role="option" data-type="${r.type}" data-id="${r.id}"><span class="ps-name">${r.name} <span class="ps-tag ps-tag-${r.type}">${r.type === "official" ? "Official" : "Player"}</span></span><span class="ps-meta">${r.meta}</span></button>`).join("");
      box.querySelectorAll(".ps-item").forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.type === "official") openOfficial360(Number(b.dataset.id));
        else openPlayer360(Number(b.dataset.id), getActive() ? getActive().id : null);
        input.value = ""; close();
      }));
    }
    box.hidden = false; input.setAttribute("aria-expanded", "true");
  };
  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      try {
        const [players, officials] = await Promise.all([
          api(`/players/search?q=${encodeURIComponent(q)}`).catch(() => []),
          api(`/officials/search?q=${encodeURIComponent(q)}`).catch(() => []),
        ]);
        const loc = (x) => [x.city, x.state].filter(Boolean).join(", ");
        const rows = [
          ...players.map((p) => ({ type: "player", id: p.id,
            name: [p.last_name, p.first_name].filter(Boolean).join(", "),
            meta: `USTA #${p.usta_number || "—"}${loc(p) ? " · " + loc(p) : ""}` })),
          ...officials.map((o) => ({ type: "official", id: o.id,
            name: [o.last_name, o.first_name].filter(Boolean).join(", "),
            meta: loc(o) || "official" })),
        ];
        render(rows, q);
      } catch (_) { close(); }
    }, 200);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; close(); } });
  document.addEventListener("click", (e) => { if (!e.target.closest("#player-search-wrap")) close(); });
}
