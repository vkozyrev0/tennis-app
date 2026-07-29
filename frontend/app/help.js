// In-app Help center — app structure, workflows, and keyboard shortcuts.
// Open via header "?" or the ? key (wired from shortcuts.js).

import { INBOX_SHORTCUTS } from "./inbox_ui.js";

/** @typedef {{ id: string, label: string, html: string }} HelpSection */

const SECTIONS = /** @type {HelpSection[]} */ ([
  {
    id: "overview",
    label: "Overview",
    html: `
      <h3>What CourtOps is</h3>
      <p>Back-office tool for a USTA <strong>Tournament Director (TD)</strong>.
      Two halves share tournaments and players:</p>
      <ul class="help-list">
        <li><strong>Officials &amp; staffing</strong> — certifications, day assignments,
          lodging, pay + mileage, coverage reports, payroll.</li>
        <li><strong>Player operations</strong> — a human-reviewed <strong>inbox</strong>
          that files parent/player email into structured lists (late entries,
          withdrawals, doubles, hotels, …).</li>
      </ul>
      <p>Not in scope: draw generation, live scoring, or moving money. The product
      stops at auditable lists and a staffing plan.</p>

      <h3>Two layers of data</h3>
      <div class="help-cards">
        <div class="help-card">
          <strong>Setup</strong>
          <p>Durable <em>catalog</em> data that lives across events: sites, officials,
          players, rates, hotels, divisions, events, users, bulk import.</p>
        </div>
        <div class="help-card">
          <strong>Tournament workspace</strong>
          <p>Everything scoped to the event in the <em>Working on</em> picker:
            roster, assignments, inbox, player lists, day-of, payroll.</p>
        </div>
      </div>
      <p class="help-tip"><strong>Tip:</strong> Always set <em>Working on</em> before
      using Inbox, Roster, or Staffing. Tabs that need a tournament stay disabled
      until one is selected.</p>
    `,
  },
  {
    id: "navigate",
    label: "Getting around",
    html: `
      <h3>Navigation map</h3>
      <ol class="help-steps">
        <li><strong>L1 section bar</strong> (under the header) — Home, Day-of, Setup,
          Tournament, Staffing, Inbox, Player lists.</li>
        <li><strong>L2 tabs</strong> — pages inside that section. Single-tab sections
          (Home, Day-of, Inbox) skip the second bar so one click opens the page.</li>
        <li><strong>Working on</strong> — active tournament in the context bar.
          Scopes every tournament-dependent page.</li>
        <li><strong>Find player or official</strong> — global search in the context bar;
          jumps into the right record.</li>
        <li><strong>Account menu</strong> (your username ▾) — Trash, Change password,
          Log out.</li>
      </ol>

      <h3>Header chips</h3>
      <ul class="help-list">
        <li><strong>Health pill</strong> — API/DB status (green when healthy).</li>
        <li><strong>Dark / Light</strong> — theme toggle.</li>
        <li><kbd>?</kbd> — this Help center.</li>
      </ul>

      <h3>Breadcrumbs</h3>
      <p>Recent places you visited appear under the menus. Use ← or clear history
      when the trail gets long. <kbd>Alt</kbd>+<kbd>←</kbd> steps back one crumb
      when the bar is visible.</p>

      <p class="help-tip"><strong>Keyboard:</strong> <kbd>1</kbd>–<kbd>9</kbd> jump to
      the Nth visible tab in the current L2 menu. <kbd>/</kbd> focuses the page filter.</p>
    `,
  },
  {
    id: "setup",
    label: "Setup catalog",
    html: `
      <h3>Setup (not tied to one event)</h3>
      <p>Master data you maintain once and reuse. Open any of these without selecting
      a tournament.</p>
      <table class="help-table">
        <thead><tr><th>Tab</th><th>What lives here</th></tr></thead>
        <tbody>
          <tr><td>Tournaments</td><td>Create/edit events, dates, deadlines, ingest address</td></tr>
          <tr><td>Sites</td><td>Venues (clubs/parks) used by many tournaments</td></tr>
          <tr><td>Officials</td><td>Official people, certs, contact; portal accounts</td></tr>
          <tr><td>Players</td><td>Master player identities (USTA #, name history)</td></tr>
          <tr><td>Rates</td><td>Per-day pay by certification</td></tr>
          <tr><td>Hotels</td><td>Hotel properties (room blocks attach per tournament)</td></tr>
          <tr><td>Distances</td><td>Official ↔ site one-way miles (manual or auto estimate)</td></tr>
          <tr><td>Divisions / Events</td><td>Junior/adult division catalog and event types</td></tr>
          <tr><td>T-shirts</td><td>Cumulative shirt inventory across tournaments</td></tr>
          <tr><td>Users</td><td>Admin/TD logins (not official portal accounts)</td></tr>
          <tr><td>Import</td><td>Stage CSV/XLSX/PDF rows, validate, then merge into catalogs</td></tr>
        </tbody>
      </table>
      <p class="help-tip"><strong>Catalog vs event:</strong> Setup → Sites is the master
      venue list. Tournament → Event sites is which of those venues this event uses.</p>
    `,
  },
  {
    id: "tournament",
    label: "Tournament & Day-of",
    html: `
      <h3>Tournament group</h3>
      <p>Requires an active tournament in <em>Working on</em>.</p>
      <table class="help-table">
        <thead><tr><th>Tab</th><th>Use it for</th></tr></thead>
        <tbody>
          <tr><td>Event sites</td><td>Which venues host this event</td></tr>
          <tr><td>Roster</td><td>Players entered this year (entries, alternates, completeness)</td></tr>
          <tr><td>Availability</td><td>When officials said they can work (heatmap + editor)</td></tr>
          <tr><td>Shirt order</td><td>Per-tournament t-shirt order snapshot</td></tr>
        </tbody>
      </table>

      <h3>Day-of</h3>
      <p><strong>Venue view</strong> is the on-site front door during play: who’s
      working, player check-in style status, and day-of operational focus.
      Promote it when the event starts — it sits near the top of L1 on purpose.</p>

      <h3>Home → Dashboard</h3>
      <p>Cross-cutting readiness: coverage gaps, pending accept/decline, declined
      slots to re-staff, incomplete roster, deadline nudges. Start each planning
      session here after picking the tournament.</p>
    `,
  },
  {
    id: "staffing",
    label: "Staffing",
    html: `
      <h3>Staffing group</h3>
      <p>Officials plan for the active tournament — assign days, lodging, non-official
      staff, incidents, freeze pay, export reports.</p>
      <table class="help-table">
        <thead><tr><th>Tab</th><th>Use it for</th></tr></thead>
        <tbody>
          <tr><td>Assignments</td><td>Invite/assign officials, per-day roles, pay + mileage cards</td></tr>
          <tr><td>Room blocks</td><td>Official vs player hotel blocks for this event</td></tr>
          <tr><td>Staff</td><td>Non-official roles (site director, trainer, stringer, …)</td></tr>
          <tr><td>Incidents</td><td>Day-of log (weather, injury, dispute, facility, conduct)</td></tr>
          <tr><td>Payroll</td><td>Finalize pay, mark paid, payment batches, CSV export</td></tr>
          <tr><td>Reports</td><td>Staffing plan, coverage, schedule, rooming list, dietary, …</td></tr>
        </tbody>
      </table>

      <h3>Pay &amp; mileage (short version)</h3>
      <ul class="help-list">
        <li>Pay = sum of per-day rates for roles worked.</li>
        <li>Mileage uses one-way miles on file: first 50 round-trip miles free,
          then rate with a hard cap. Missing distance → flag, not silent $0.</li>
        <li>Problems (uncertified day, double-booking, hotel date mismatch) are
          usually <em>flags</em> so the TD decides — only full room blocks hard-block.</li>
      </ul>
    `,
  },
  {
    id: "inbox",
    label: "Inbox triage",
    html: `
      <h3>Why Inbox is its own section</h3>
      <p>Parent and player email is the input stream for player operations.
      Nothing auto-files without you. Workflow is always:</p>
      <ol class="help-steps help-steps--flow">
        <li><strong>Classify</strong> — what kind of request (withdrawal, late entry, doubles, …)</li>
        <li><strong>Detect</strong> — match player(s) on the roster (USTA #, name layers)</li>
        <li><strong>File</strong> — write the structured row and mark the email filed</li>
      </ol>
      <p><strong>Triage</strong> runs those three in one pass on a selection.</p>

      <h3>Status lifecycle</h3>
      <p class="help-flow-line">
        <span class="help-pill">new</span>
        <span class="help-arrow">→</span>
        <span class="help-pill">triaged</span>
        <span class="help-arrow">→</span>
        <span class="help-pill">filed</span>
        <span class="help-arrow">/</span>
        <span class="help-pill">ignored</span>
      </p>
      <p>Use filters and <strong>Unmatched only</strong> to work the queue. Count
      badges on L1 show where work is waiting.</p>

      <h3>Getting mail in</h3>
      <ul class="help-list">
        <li><strong>Paste / create</strong> a message in the Inbox UI (POC default).</li>
        <li><strong>Webhook ingest</strong> — providers POST to
          <code>/api/ingest/email</code> with <code>INGEST_TOKEN</code>; optional
          per-tournament ingest address for routing.</li>
        <li><strong>PDF import</strong> — stage a tournament-emails PDF via Setup → Import.</li>
      </ul>
      <p class="help-tip"><strong>Provenance:</strong> every filed list row can point
      back to its source email so you can re-open the original wording later.</p>
    `,
  },
  {
    id: "playerlists",
    label: "Player lists",
    html: `
      <h3>Where filed work lands</h3>
      <p>After Inbox files a message, the structured row appears on the matching
      list under <strong>Player lists</strong>. Same active tournament as Inbox.</p>
      <table class="help-table">
        <thead><tr><th>List</th><th>Typical source classification</th></tr></thead>
        <tbody>
          <tr><td>Late entries</td><td>late_entry</td></tr>
          <tr><td>Withdrawals</td><td>withdrawal</td></tr>
          <tr><td>Scheduling</td><td>scheduling_avoidance (can’t play certain days/times)</td></tr>
          <tr><td>Div. flex</td><td>division_flex</td></tr>
          <tr><td>Pairing avoid.</td><td>pairing_avoidance (group of players)</td></tr>
          <tr><td>Doubles</td><td>doubles (player + partner)</td></tr>
          <tr><td>Player hotels</td><td>hotel / lodging request</td></tr>
        </tbody>
      </table>
      <p>Badges on the L1 <strong>Player lists</strong> button and each tab show
      row counts so you know which lists have data without opening every tab.</p>
    `,
  },
  {
    id: "shortcuts",
    label: "Keyboard",
    html: `
      <h3>Global</h3>
      <table class="shortcuts"><tbody>
        <tr><th><kbd>/</kbd></th><td>Focus the page filter / search on the active panel</td></tr>
        <tr><th><kbd>n</kbd></th><td>Add a new record (clicks the primary New control)</td></tr>
        <tr><th><kbd>1</kbd>–<kbd>9</kbd></th><td>Jump to the Nth visible tab in the current menu</td></tr>
        <tr><th><kbd>Esc</kbd></th><td>Close the open dialog or this Help</td></tr>
        <tr><th><kbd>?</kbd></th><td>Open Help</td></tr>
      </tbody></table>

      <h3>Inbox (when the Inbox panel is active and you’re not typing in a field)</h3>
      <table class="shortcuts"><tbody>
        ${INBOX_SHORTCUTS.map(
          (s) => `<tr><th><kbd>${s.key}</kbd></th><td>${s.help}</td></tr>`,
        ).join("")}
      </tbody></table>
      <p class="help-tip">Shortcuts ignore keystrokes while focus is in an input,
      textarea, or select (so typing a subject doesn’t fire commands).</p>
    `,
  },
  {
    id: "tips",
    label: "Tips & workflow",
    html: `
      <h3>Suggested order for a new event</h3>
      <ol class="help-steps">
        <li><strong>Setup → Tournaments</strong> — create the event and set dates/deadlines.</li>
        <li>Set <em>Working on</em> to that tournament.</li>
        <li><strong>Tournament → Event sites</strong> — attach venues.</li>
        <li><strong>Tournament → Roster</strong> — import or add entries.</li>
        <li><strong>Setup → Officials / Distances / Rates</strong> — ensure people and miles exist.</li>
        <li><strong>Staffing → Assignments</strong> — invite and assign days; watch flags.</li>
        <li><strong>Inbox</strong> — triage parent mail into player lists as it arrives.</li>
        <li><strong>Home</strong> — clear readiness blockers before play week.</li>
        <li><strong>Day-of → Venue view</strong> during the event; <strong>Payroll</strong> after.</li>
      </ol>

      <h3>Design habits that show up everywhere</h3>
      <ul class="help-list">
        <li><strong>Manual-first</strong> — every integration (maps, mail, USTA) has a
          path that works without the third party.</li>
        <li><strong>Flag, don’t block</strong> — data quality issues warn; you decide.</li>
        <li><strong>Minors’ PII</strong> — export of sensitive player data is gated;
          erase is hard-delete where COPPA requires it.</li>
      </ul>

      <h3>Where to read more</h3>
      <p class="muted">Repo docs: <code>docs/design.md</code> (architecture),
      <code>docs/email-ingest.md</code> (webhooks), <code>docs/deploy.md</code> (hosting),
      <code>docs/roadmap.md</code> (what’s open).</p>
    `,
  },
]);

function sectionNavHtml(activeId) {
  return SECTIONS.map((s) => {
    const on = s.id === activeId ? " is-active" : "";
    return `<button type="button" class="help-nav-item${on}" data-help-section="${s.id}" role="tab" aria-selected="${s.id === activeId}">${s.label}</button>`;
  }).join("");
}

function findSection(id) {
  return SECTIONS.find((s) => s.id === id) || SECTIONS[0];
}

function renderBody(m, sectionId) {
  const sec = findSection(sectionId);
  const nav = m.querySelector(".help-nav");
  const body = m.querySelector(".help-body");
  const title = m.querySelector("#help-title");
  if (nav) nav.innerHTML = sectionNavHtml(sec.id);
  if (body) {
    body.innerHTML = sec.html;
    body.dataset.section = sec.id;
    body.scrollTop = 0;
  }
  if (title) title.textContent = `Help · ${sec.label}`;
  m._helpSection = sec.id;
  // Wire nav clicks after replace
  nav?.querySelectorAll("[data-help-section]").forEach((btn) => {
    btn.addEventListener("click", () => renderBody(m, btn.getAttribute("data-help-section")));
  });
}

export function showHelp(sectionId) {
  let m = document.getElementById("help-modal");
  if (!m) {
    m = document.createElement("div");
    m.id = "help-modal";
    m.className = "modal";
    m.innerHTML = `
      <div class="modal-box modal-box--help" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div class="help-header">
          <h2 id="help-title" class="help-title">Help</h2>
          <button type="button" class="help-close hdr-btn" id="help-close" aria-label="Close help">×</button>
        </div>
        <p class="help-lede">How CourtOps is organized — pick a topic, or jump to Keyboard for shortcuts.</p>
        <div class="help-layout">
          <nav class="help-nav" role="tablist" aria-label="Help topics"></nav>
          <div class="help-body" role="tabpanel" tabindex="0"></div>
        </div>
        <div class="actions-row help-footer">
          <button type="button" class="btn btn--secondary" id="help-close-footer">Close</button>
        </div>
      </div>`;
    document.body.appendChild(m);

    const close = () => {
      m.hidden = true;
      if (m._invoker && typeof m._invoker.focus === "function") m._invoker.focus();
    };
    m.querySelector("#help-close").addEventListener("click", close);
    m.querySelector("#help-close-footer").addEventListener("click", close);
    m.addEventListener("click", (e) => { if (e.target === m) close(); });
    m.addEventListener("keydown", (e) => {
      if (m.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      // Arrow keys move between help topics when focus is in the nav
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = [...m.querySelectorAll(".help-nav-item")];
        const i = items.indexOf(document.activeElement);
        if (i < 0 && !m.querySelector(".help-nav")?.contains(document.activeElement)) return;
        e.preventDefault();
        const next = e.key === "ArrowDown"
          ? items[Math.min(items.length - 1, Math.max(0, i) + 1)]
          : items[Math.max(0, (i < 0 ? 0 : i) - 1)];
        next?.focus();
        next?.click();
      }
    });
  }

  m._invoker = document.activeElement;
  m.hidden = false;
  renderBody(m, sectionId || m._helpSection || "overview");
  requestAnimationFrame(() => {
    const active = m.querySelector(".help-nav-item.is-active");
    (active || m.querySelector("#help-close")).focus();
  });
}

/** @deprecated alias — older call sites / muscle memory */
export function showShortcuts() {
  showHelp("shortcuts");
}
