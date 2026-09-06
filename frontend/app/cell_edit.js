// In-grid cell-edit success path: apply the PUT body onto the edited row
// instead of reloading the whole grid (server normalization + updated_at
// must land or the next edit can stale).

/** Merge a successful PUT body onto the edited row. Does not reload the grid. */
export function applySavedRow(cell, savedRow, items) {
  if (!savedRow || typeof savedRow !== "object") return false;
  const row = cell && typeof cell.getRow === "function" ? cell.getRow() : null;
  if (!row || typeof row.update !== "function") return false;
  const patch = { ...savedRow };
  delete patch._act;
  row.update(patch);
  if (Array.isArray(items) && savedRow.id != null) {
    const idx = items.findIndex((it) => it && it.id === savedRow.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...patch };
  }
  return true;
}

/**
 * PUT the edited row and apply the server-normalized body in place.
 * On no-op (value unchanged) returns `{ ok: true, noop: true }` without calling api.
 * Callers restore the old value themselves on throw.
 */
export async function saveInGridCell({ cell, api, path, transform, headers = {}, items } = {}) {
  if (!cell || typeof cell.getRow !== "function") {
    throw new Error("cell is required");
  }
  const data = cell.getRow().getData() || {};
  if (cell.getValue() === cell.getOldValue()) return { ok: true, noop: true };
  let body = { ...data };
  delete body._act;
  if (typeof transform === "function") body = transform(body);
  const saved = await api(path, {
    method: "PUT",
    body: JSON.stringify(body),
    headers,
  });
  applySavedRow(cell, saved, items);
  return { ok: true, saved, reloaded: false };
}
