// Admin workspace boot: enums + refresh all Setup CRUD caches — D11.

export function createAdminBoot(ctx) {
  const {
    api, certs, tournamentsById, setActive, updateActiveUI, getCruds,
  } = ctx;

  let adminLoaded = false;

  // =================== Auth + role-based views ===================
  async function adminInit() {
    if (adminLoaded) return;
    adminLoaded = true;
    // Audit M28/M29: populate every <select data-enum="…"> from /api/enums so
    // there's one source of truth for cert / gender / status / shirt options.
    // Audit F23: also seed the JS-side cert label map from the same payload so
    // certLabel() never drifts from what the dropdowns show.
    try {
      const enums = await api("/enums");
      populateEnumSelects(enums);
      if (Array.isArray(enums.cert_type)) {
        certs.pairs = enums.cert_type.map((c) => [c.value, c.label]);
      }
    } catch (_) {}
    for (const c of Object.values(getCruds())) {
      try { await c.refresh(); } catch (e) { /* health pill surfaces DB issues */ }
    }
    const saved = localStorage.getItem("activeTid");
    if (saved && tournamentsById[saved]) setActive(saved);
    else updateActiveUI();
  }
  function populateEnumSelects(enums) {
    for (const sel of document.querySelectorAll("select[data-enum]")) {
      const key = sel.getAttribute("data-enum");
      const values = enums[key] || [];
      const frag = document.createDocumentFragment();
      for (const v of values) {
        const o = document.createElement("option");
        if (typeof v === "string") { o.value = v; o.textContent = v; }
        else { o.value = v.value; o.textContent = v.label; }
        frag.appendChild(o);
      }
      sel.replaceChildren(frag);
    }
  }

  function resetAdminLoaded() { adminLoaded = false; }
  return { adminInit, populateEnumSelects, resetAdminLoaded, isAdminLoaded: () => adminLoaded };
}
