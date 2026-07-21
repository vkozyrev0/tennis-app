// Display labels for officials, sites, players, and cert types (D11 slice).

export function officialLabel(o) {
  return `${o.last_name}, ${o.first_name}`;
}

export function siteLabel(s) {
  return (s.code ? s.code + " — " : "") + s.name;
}

export function playerLabel(p) {
  return `${[p.last_name, p.first_name].filter(Boolean).join(", ") || "?"} (${p.usta_number})`;
}

/** Default cert list — overwritten from GET /api/enums at adminInit (Audit F23). */
export const DEFAULT_CERTS = [
  ["roving_official", "Roving official"],
  ["chair_umpire", "Chair umpire"],
  ["tournament_referee", "Tournament referee"],
  ["deputy_referee", "Deputy referee"],
  ["referee_in_training", "Referee in training"],
];

/**
 * Mutable cert catalog: `pairs` is [[value, label], ...]; assignment rebuilds the map.
 * @param {string[][]} [initial]
 */
export function createCertCatalog(initial = DEFAULT_CERTS) {
  let pairs = initial.map((row) => row.slice());
  let byValue = Object.fromEntries(pairs);

  return {
    get pairs() { return pairs; },
    set pairs(next) {
      pairs = next.map((row) => row.slice());
      byValue = Object.fromEntries(pairs);
    },
    certLabel(v) {
      return byValue[v] || v;
    },
  };
}
