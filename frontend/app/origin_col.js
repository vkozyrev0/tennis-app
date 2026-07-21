// Origin column for Part B lists — filed-from-email vs manual (shared D11).

/**
 * @param {{ hstr: Function }} ctx
 * @returns {{ title: string, field: string, headerSort: boolean, width: number, formatter: Function }}
 */
export function makeOriginCol({ hstr }) {
  function originCell(c) {
    const r = c.getData();
    if (r.source_email_id) {
      const subj = r.source_subject || `email #${r.source_email_id}`;
      return hstr`<span class="origin-email" title="${"Filed from email: " + subj}">✉ email</span>`;
    }
    return '<span class="muted">manual</span>';
  }
  return {
    title: "Origin", field: "source_email_id", headerSort: false,
    width: 100, formatter: originCell,
  };
}
