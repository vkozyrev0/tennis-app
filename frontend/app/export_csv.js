// Client CSV download with H4.1 audit + H4.2 minors-PII gate (D11 slice).
import {
  csvDownload as csvDownloadRaw,
  redactCsvMatrix,
  isMinorsPiiResource,
} from "./util.js";

/**
 * @param {{
 *   api: (path: string, options?: RequestInit) => Promise<any>,
 *   toast: (text: string, ok?: boolean) => void,
 *   confirmDialog: (message: string, okLabel?: string, okKind?: string) => Promise<boolean>,
 *   getAuthUser: () => { can_export_pii?: boolean } | null,
 *   getActive: () => { id?: number } | null,
 * }} ctx
 */
export function createCsvExport(ctx) {
  const { api, toast, confirmDialog, getAuthUser, getActive } = ctx;

  async function logClientExport(resource, detail = {}) {
    const active = getActive();
    const body = {
      resource: String(resource || "csv").slice(0, 120),
      tournament_id: active ? active.id : null,
      detail,
    };
    await api("/export-audit", { method: "POST", body: JSON.stringify(body) });
  }

  /**
   * Download a CSV matrix with H4.2 minors-PII gate.
   * @param {any[][]} matrix
   * @param {string} filename  base name without .csv
   * @param {{ resource?: string, redacted?: boolean, pii?: boolean }} [opts]
   * @returns {Promise<boolean>} true if a file was produced
   */
  async function csvDownload(matrix, filename, opts = {}) {
    const resource = opts.resource || filename || "csv";
    const minors = opts.pii === true || (opts.pii !== false && isMinorsPiiResource(resource));
    let redacted = !!opts.redacted;
    let data = matrix;
    const authUser = getAuthUser();

    if (minors) {
      const can = !authUser || authUser.can_export_pii !== false;
      if (!can) {
        toast("Full PII CSV export is disabled for your account", false);
        return false;
      }
      if (redacted) {
        data = redactCsvMatrix(matrix);
      } else {
        const ok = await confirmDialog(
          "This CSV may include minors' personal data (names, USTA #, contact, birthdate). " +
          "Export only when needed and store the file securely.",
          "Export PII CSV",
          "danger",
        );
        if (!ok) return false;
      }
    }

    const rows = Array.isArray(data) && data.length ? Math.max(0, data.length - 1) : 0;
    try {
      await logClientExport(resource, {
        filename: `${filename || "export"}.csv`,
        row_count: rows,
        confirmed: !!(minors && !redacted),
        redacted: !!redacted,
      });
    } catch (e) {
      toast(e.message || "export not allowed", false);
      return false;
    }
    csvDownloadRaw(data, filename);
    return true;
  }

  return { csvDownload, logClientExport };
}
