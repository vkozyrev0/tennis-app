// Form required-field markers + inbox/roster toolbar consolidation — D11.
// Chrome Issues → Improvements flags two Autofill gaps: a control with no
// id/name, and a control whose id/name looks like an Autofill token but has
// no autocomplete attribute. Catalog fields are other people's data, so we
// mark them autocomplete=off; only login + the official's own profile use
// real Autofill tokens.

let _fieldSeq = 0;

const AUTOCOMPLETE_BY_NAME = {
  first_name: "given-name",
  last_name: "family-name",
  email: "email",
  username: "username",
  password: "current-password",
  phone: "tel",
  street: "address-line1",
  city: "address-level2",
  state: "address-level1",
  zip: "postal-code",
  website: "url",
  birthdate: "bday",
};

/** Own-profile / login forms where Autofill should fill the signed-in person. */
function _isPersonalForm(el) {
  return !!(el.closest && el.closest("#login-form, #me-form, #change-pw-form"));
}

export function suggestedAutocomplete(el) {
  if (!el || el.nodeType !== 1) return "off";
  const tag = el.tagName;
  if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return "off";
  const type = String(el.type || "").toLowerCase();
  if (type === "hidden" || type === "file" || type === "submit" || type === "button"
      || type === "reset" || type === "image") {
    return null;
  }
  if (type === "checkbox" || type === "radio" || type === "range" || type === "color"
      || type === "search") {
    return "off";
  }
  if (el.classList.contains("filter") || el.classList.contains("combo-input")
      || el.classList.contains("ag-input-field-input")
      || el.classList.contains("ag-floating-filter-input")) {
    return "off";
  }
  const key = String(el.name || el.id || "").toLowerCase().replace(/-/g, "_");
  if (_isPersonalForm(el) && AUTOCOMPLETE_BY_NAME[key]) {
    if (key === "password" && type === "password") {
      const existingHint = (el.getAttribute("autocomplete") || "");
      if (existingHint === "new-password" || existingHint === "current-password") return existingHint;
      return el.id && /new|confirm/i.test(el.id) ? "new-password" : "current-password";
    }
    return AUTOCOMPLETE_BY_NAME[key];
  }
  if (type === "password") return el.getAttribute("autocomplete") || "new-password";
  return "off";
}

/** Give a control an id when it has neither id nor name (Chrome Autofill). */
export function ensureFieldIdentity(el) {
  if (!el || el.nodeType !== 1) return el;
  if (el.id || (el.getAttribute && el.getAttribute("name"))) return el;
  const type = String(el.type || el.tagName || "field").toLowerCase().replace(/[^a-z0-9]+/g, "");
  el.id = `fc-${type || "field"}-${++_fieldSeq}`;
  return el;
}

export function stampFormControls(root = (typeof document !== "undefined" ? document : null)) {
  if (!root || !root.querySelectorAll) return 0;
  let n = 0;
  root.querySelectorAll("input, select, textarea").forEach((el) => {
    const beforeId = el.id;
    const beforeName = el.getAttribute("name");
    ensureFieldIdentity(el);
    if ((!beforeId && !beforeName) && (el.id || el.getAttribute("name"))) n++;
    if (!el.hasAttribute("autocomplete")) {
      const ac = suggestedAutocomplete(el);
      if (ac) el.setAttribute("autocomplete", ac);
    }
    ignorePasswordManagers(el);
  });
  return n;
}

/** LastPass/1Password/Bitwarden treat CourtOps combos as login fields. */
function ignorePasswordManagers(el) {
  if (!el || el.nodeType !== 1) return;
  const tag = String(el.tagName || "").toUpperCase();
  const type = String(el.type || "").toLowerCase();
  const isCombo = el.classList && el.classList.contains("combo-input");
  const isSelect = tag === "SELECT";
  const isDate = type === "date";
  if (!isCombo && !isSelect && !isDate) return;
  el.setAttribute("data-lpignore", "true");
  el.setAttribute("data-1p-ignore", "true");
  el.setAttribute("data-bwignore", "true");
  if (isCombo || isSelect) el.setAttribute("data-form-type", "other");
}

export function watchFormControls(root = (typeof document !== "undefined" ? document : null)) {
  if (!root || typeof MutationObserver === "undefined") return () => {};
  let t = 0;
  const mo = new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(() => stampFormControls(root), 40);
  });
  mo.observe(root, { childList: true, subtree: true });
  return () => { clearTimeout(t); mo.disconnect(); };
}

export function installFormA11y(ctx) {
  const { makeMenuButton, gotoImport } = ctx;

  /** Keep native calendar datepickers. Do not convert them to text. */
  function enhanceDateFields() {
    document.querySelectorAll('input[type="date"]').forEach((el) => {
      el.setAttribute("autocomplete", "off");
      ignorePasswordManagers(el);
    });
  }

  function enhanceContactFields() {
    document.querySelectorAll('input[name="phone"]').forEach((el) => {
      if (el.type === "text" || el.type === "") {
        el.type = "tel";
      }
      if (!el.getAttribute("autocomplete")) el.setAttribute("autocomplete", "tel");
      if (!el.getAttribute("inputmode")) el.setAttribute("inputmode", "tel");
    });
    document.querySelectorAll(
      'input[type="email"], input[type="password"], input[name="username"], input[autocomplete="username"]',
    ).forEach((el) => {
      el.setAttribute("spellcheck", "false");
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

  // Put "+ Add email", the Import menu, and CSV into the Inbox Add cluster
  // (#inbox-entry-row). The trigger and CSV button are injected by other init
  // code; this runs after both. Falls back to a generated row if the slot is
  // missing (older markup).
  function _consolidateInboxToolbar() {
    const trigger = document.querySelector('#panel-t-inbox .add-trigger');
    const importBtn = document.getElementById("inbox-import-pdf-btn");
    const importInput = document.getElementById("inbox-import-pdf-input");
    const importMsg = document.getElementById("inbox-import-pdf-msg");
    const csv = [...document.querySelectorAll('#panel-t-inbox .export-btn')]
      .find((b) => /CSV/.test(b.textContent) && b.id !== "inbox-import-pdf-btn"
        && !b.classList.contains("menu-btn-trigger"));
    if (!trigger || !importBtn) return;
    if (document.getElementById("inbox-import-menu")) return;  // idempotent
    const slot = document.getElementById("inbox-entry-row");
    const row = slot || document.createElement("div");
    if (!slot) {
      row.id = "inbox-toolbar-row"; row.className = "actions-row mb-half";
      trigger.parentNode.insertBefore(row, trigger);
    }
    // design-crit I-8: a single "⬆ Import ▾" menu replaces the separate
    // "Import PDF" + auto-injected "Import…" buttons. The original PDF button is
    // hidden but kept wired (its hidden file input does the upload); the menu's
    // first item just delegates to that input.
    importBtn.hidden = true;
    const importMenu = makeMenuButton(`<span aria-hidden="true">⬆</span> Import`, [
      { label: "PDF email thread", title: "Upload a printed email-thread PDF directly into this inbox", onClick: () => importInput.click() },
      { label: "Staged import…", title: "Open the Import page to preview + merge", onClick: () => gotoImport("emails_pdf") },
    ], { className: "export-btn no-print" });
    importMenu.id = "inbox-import-menu";
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
    enhanceContactFields,
    stampFormControls,
    watchFormControls,
    consolidateInboxToolbar: _consolidateInboxToolbar,
    consolidateRosterToolbar: _consolidateRosterToolbar,
  };
}
