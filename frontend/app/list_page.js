// Shared q / limit / offset query for tournament-scoped list GETs.
// Matches the GET /api/players + GET /api/emails contract: omit limit to
// request the full match set; SPA grids send a page size so they don't load
// every row.

export const LIST_PAGE_SIZE = 500;

export function listPageQuery({ q = "", limit = LIST_PAGE_SIZE, offset = 0 } = {}) {
  const params = new URLSearchParams();
  if (limit != null && limit !== "") params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));
  const term = String(q ?? "").trim();
  if (term) params.set("q", term);
  return params.toString();
}

export function listPagePath(path, opts) {
  const qs = listPageQuery(opts);
  if (!qs) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${qs}`;
}
