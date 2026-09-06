// Form required-field markers + inbox/roster toolbar consolidation — D11.

export function installFormA11y(ctx) {
  const { makeMenuButton, gotoImport } = ctx;

  /** Native date inputs reject typed MM/DD/YYYY. Use a text field + hint. */
  function enhanceDateFields() {
    document.querySelectorAll('input[type="date"]').forEach((el) => {
      if (el.dataset.dateLocale) return;
      el.dataset.dateLocale = "1";
      el.type = "text";
      el.classList.add("date-locale");
      el.placeholder = el.placeholder || "MM/DD/YYYY";
      el.setAttribute("inputmode", "numeric");
      el.setAttribute("autocomplete", "off");
      el.title = "MM/DD/YYYY or YYYY-MM-DD";
      if (!el.parentElement) return;
      if (el.parentElement.querySelector(".date-hint")) return;
      const hint = document.createElement("span");
      hint.className = "date-hint";
      hint.textContent = "MM/DD/YYYY";
      el.insertAdjacentElement("afterend", hint);
    });
  }

  function markRequiredFields() {
    document.querySelectorAll("form .row label").forEach((label) => {
      if (!label.querySelector("[required]") || label.querySelector(".req")) return;
      const tn = [...label.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!tn) return;
      const wrap = document.createElement("span");
      wrap.className = "label-text";
      wrap.textContent = tn.textContent.replace(/\s+$/, "");
      const star = document.createElement("span");
      star.className = "req"; star.textContent = " *"; star.title = "required";
      wrap.appendChild(star);
      tn.replaceWith(wrap);
    });
  }

  // Consolidate the Inbox panel's top toolbar so "+ Add email", "⬆ Import PDF"
  // and "⬇ CSV" sit inline on the same row. The trigger and the CSV button
  // are both injected by other init code; this runs after both so it can wrap
  // all three into a shared flex container.
  function _consolidateInboxToolbar() {
    const trigger = document.querySelector('#panel-t-inbox .add-trigger');
    const importBtn = document.getElementById("inbox-import-pdf-btn");
    const importInput = document.getElementById("inbox-import-pdf-input");
    const importMsg = document.getElementById("inbox-import-pdf-msg");
    const csv = [...document.querySelectorAll('#panel-t-inbox .export-btn')]
      .find((b) => /CSV/.test(b.textContent) && b.id !== "inbox-import-pdf-btn"
        && !b.classList.contains("menu-btn-trigger"));
    if (!trigger || !importBtn) return;
    if (document.getElementById("inbox-toolbar-row")) return;  // idempotent
    const row = document.createElement("div");
    row.id = "inbox-toolbar-row"; row.className = "actions-row mb-half";
    trigger.parentNode.insertBefore(row, trigger);
    // design-crit I-8: a single "⬆ Import ▾" menu replaces the separate
    // "Import PDF" + auto-injected "Import…" buttons. The original PDF button is
    // hidden but kept wired (its hidden file input does the upload); the menu's
    // first item just delegates to that input.
    importBtn.hidden = true;
    const importMenu = makeMenuButton(`<span aria-hidden="true">⬆</span> Import`, [
      { label: "PDF email thread", title: "Upload a printed email-thread PDF directly into this inbox", onClick: () => importInput.click() },
      { label: "Staged import…", title: "Open the Import page to preview + merge", onClick: () => gotoImport("emails_pdf") },
    ], { className: "export-btn no-print" });
    row.append(trigger, importMenu, importBtn);
    if (importInput) row.append(importInput);
    if (importMsg) row.append(importMsg);
    if (csv) row.append(csv);
  }

  // design-crit R-1: collapse the Roster's three download buttons (CSV /
  // Sign-in / Sign-in template) into a single "⬇ Download ▾" menu so the
  // toolbar stops truncating with "…". The originals stay in the DOM (hidden)
  // so their existing by-id click handlers keep working; the menu delegates.
  function _consolidateRosterToolbar() {
    const toolbar = document.querySelector("#panel-t-roster .list-toolbar");
    if (!toolbar || toolbar.querySelector(".roster-download-menu")) return;
    const csv = document.getElementById("roster-csv");
    const signin = document.getElementById("roster-signin-csv");
    const template = document.getElementById("roster-signin-template");
    if (!csv || !signin || !template) return;
    const menu = makeMenuButton(`<span aria-hidden="true">⬇</span> Download`, [
      { label: "Roster CSV", title: "Full roster as CSV", onClick: () => csv.click() },
      { label: "Sign-in sheet", title: "Sign-in sheet (status, events, size, hotel, lodging)", onClick: () => signin.click() },
      { label: "Sign-in template (blank)", title: "Empty sign-in sheet template", onClick: () => template.click() },
    ], { className: "export-btn no-print roster-download-menu" });
    csv.parentNode.insertBefore(menu, csv);
    [csv, signin, template].forEach((b) => { b.hidden = true; });
  }

  return {
    markRequiredFields,
    enhanceDateFields,
    consolidateInboxToolbar: _consolidateInboxToolbar,
    consolidateRosterToolbar: _consolidateRosterToolbar,
  };
}
