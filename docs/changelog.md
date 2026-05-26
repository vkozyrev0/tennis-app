# CourtOps Tennis — UI/UX & polish changelog

Detailed, per-pass record of the UI/UX and polish work. The high-level plan
and status live in [roadmap.md](roadmap.md); this file is the granular log.

---

## Post-audit improvements (2026-05-25) — applied
After the code+docs audit (see "Audit follow-ups" below), a further in-scope batch:
- **✅ Part B PUT + in-grid editing** (phase 13) — added PUT endpoints to the
  Part B routers (`late_entries`, `withdrawals`, `adult_lists` for sched + div
  flex, `player_hotels`) with small `*Update` models limited to the editable
  fields (player identity / tournament are not changeable on edit). The
  withdrawal §2.4 reason rule is enforced on PUT too. Player-hotel edits run
  through `upsert_hotel` so the hotel name stays canonical and the FK points at
  the right Hotels row. The frontend grids (Late entries, Withdrawals, Scheduling,
  Division flex, Player hotels) now have **editors on the editable columns**;
  `makeListGrid` already wired `cellEdited`, and `wirePlayerList` gained an
  `editFields` config that drives a generic PUT-on-edit handler. Player / USTA #
  columns stay read-only — those identify the row. Backend tests cover all five
  PUTs plus the reason-rule path (40 → 42 passing).
  Left untouched: **Pairing** (group of members) and **Doubles** (mutual
  verification) — those don't map to a clean per-cell edit and stay add/delete.
- **✅ In-grid editing on single click** (phase 12) — in-place editing existed but
  was bound to **double-click** (a holdover from when single click selected a row
  for the side form). Now that the detail form opens from the **Edit** button, the
  grids use `editTriggerEvent: "click"` so a **single click opens the cell editor**
  — far more discoverable. Applies to the Setup grids, Roster, and Room blocks
  (the Inbox classification editor already used single click). Editable columns
  keep their hover affordance; the commit-on-change → PUT path is unchanged.
- **✅ Workspace pages → full-width grid + modal forms** (phase 11) — the same
  treatment now covers the tournament workspace. **Roster** is a true
  master/detail like the Setup pages: full-width grid, **Edit** opens the entry
  form as a modal overlay, single click only highlights (double-click still edits
  in place), Prev/Next nav in the modal header. The other workspace **add-forms**
  (late entries, withdrawals, scheduling, division flex, player hotels, pairing,
  doubles, room blocks, assignments, inbox email) replace the old collapsible
  `<details>` with a **"＋ Add X" button that opens the form as a modal** — closing
  is driven by the form's `reset` event (every submit handler resets on success
  and Cancel resets too, so both close the overlay while a validation error keeps
  it open). **File-from-email** opens the target form's modal (verified: jumps to
  the tab, opens the form, carries `source_email_id`). One shared backdrop serves
  every panel; Esc / backdrop / tab-switch all close.
- **✅ Setup master/detail → full-width grid + modal edit form** (phase 10) — the
  Setup pages (Tournaments, Sites, Officials, Players, Rates, Hotels, Distances)
  no longer split the page into list + side form. The **grid now spans the full
  page width**, and the **detail form opens as a centered modal overlay** (with a
  dimmed backdrop) when you click a row's **Edit** button or **+ New**. Close via
  the × button, **Cancel**, **Esc**, clicking the backdrop, switching tabs, or a
  successful Save/Delete. **In-grid (double-click) editing is unchanged** — single
  click only highlights a row (so it never pre-empts a double-click to edit a
  cell); Prev/Next record nav lives in the modal header. (`wireEntity` gained
  `openModal`/`closeModal`; a single shared backdrop serves whichever panel is
  active.)
- **✅ Grid dropdown theming + Room-block in-grid edit** (phase 9) — two fixes:
  (1) the list editor / list header-filter **dropdown is appended to `<body>`**, so
  the `.tabulator` theme rules never reached it — it now has explicit light/dark
  styling (card background, readable text, hover/active highlight), `white-space:
  nowrap` so long options aren't clipped in a narrow column, a 260px max-height
  with its own scrollbar, and a z-index above app overlays (verified in dark mode:
  card-coloured background, not white). (2) **Room blocks** gains **in-grid
  editing** — `makeListGrid` now takes a `cellEdited` handler; Type (dropdown),
  Rooms (number), Check-in/out (date) edit in place and PUT the row (the Edit
  button still opens the form for the off-grid confirmation/cancellation fields).
  Note: the **Part B** lists (late entries, withdrawals, scheduling, division flex,
  player hotels, pairing, doubles) stay add/delete-only — they're POST/DELETE in
  the API (human-review, filed-from-email); in-grid edit there needs new PUT
  endpoints, tracked as a follow-up.
- **✅ Auto-fit column widths** (phase 8) — grids switch from `fitColumns`
  (even stretch) to **`fitDataFill`**, so each column sizes to its content while
  the table still fills the container (verified: no right-side gap, no horizontal
  scroll). `columnDefaults` now set `minWidth: 80`, `maxWidth: 440`, **per-cell
  tooltips** (so clipped long values show on hover), and `resizable: true` so a
  user can still nudge a column. Header filters and sorting are unaffected.
- **✅ Per-column header filters** (phase 7) — every grid now has a filter box
  under each meaningful column header. A shared `_autoHeaderFilters` helper gives
  `makeListGrid` / `makeReadGrid` / `wirePlayerList` columns an `input` filter,
  skipping synthetic (`_…`) and raw-key (`id` / `*_id`) columns; the Setup grids
  (`wireEntity`) build theirs inline (computed columns filter via the `fmt` text;
  list-editable columns — type, cert_type — get a **dropdown** filter). Roster
  (Status), Inbox (Classification) use dropdown filters; the Room-block **Hotel**
  column filters by hotel name. Filters combine (AND) with the existing global
  search box. Switched the grids to `renderVertical:"basic"` (small POC lists) to
  avoid Tabulator's virtual-render resize loop that a row-count change could trip.
- **✅ Tabulator grid — Inbox** (phase 6) — the review Inbox, previously kept as a
  custom table for its interactive per-row controls, is now a grid too:
  **Classification** is an inline `list` editor (click to change, persists on edit),
  **Status** shows the colour badge, and the actions column keeps the File-target
  picker + **Suggest** / **File →** / **Delete** buttons (Suggest re-formats the row
  so the classification + target default refresh). This makes **every list in the
  app** a Tabulator grid — the only remaining hand-built table is the **print
  report** (a weekday-matrix artifact with its own print CSS), which stays by design.
- **✅ Tabulator grid — Room blocks, Availability & Name history** (phase 5) —
  the remaining workspace/sub-detail tables convert: **Room blocks** (via
  `makeListGrid`, now extended with an optional **Edit** action alongside Delete —
  Edit opens the existing form; right-aligned Rooms/Left), the **Availability**
  summary (read grid, one row per official with their dates joined), and the player
  **Name history** sub-table (read grid in the collapsible box — it builds hidden,
  so it `redraw()`s once shown). The only non-grid surfaces left are the **Inbox**
  and the print **report** (incl. its lodging roster), both by design.
- **✅ Tabulator grid — summaries, T-shirts & tournament Sites** (phase 4) — the
  last hand-built tables move to a new read-only `makeReadGrid` helper (sortable +
  native ⬇ CSV, registered for redraw-on-tab-show): the **T-shirts** Setup list
  (keeps its order-summary badges + filter, now via `setFilter`), the three
  **Player-hotels** aggregates (**Hotel summary**, **Lodging-plan summary**, **CVB
  totals** — right-aligned counts), and the tournament **Sites** membership grid
  (the Add / ✓ In toggle lives in an action column; members keep the row highlight
  via a `rowFormatter`). With that, **every list/summary is a Tabulator grid except
  the Inbox** (interactive per-row File/Suggest/classify controls) and the print
  **report**. Dead CSV-scrape plumbing (`EXPORTABLE` down to just the Inbox,
  `templateTable`/`TEMPLATE_HEADERS`) removed.
- **✅ In-grid inline editing** (phase 3) — Tabulator cells now edit in place
  (**double-click** to edit; single-click still selects the row / drives Prev-Next),
  committing straight to the API. `wireEntity` columns opt in via `edit: { editor,
  params }` and a generic `cellEdited` handler **PUTs the whole row** (each `*Out`
  record already carries every field the create model needs; Pydantic ignores
  extras) then refreshes to reflect any server normalization; on error the cell
  reverts. Wired on **Tournaments** (name, type), **Sites** (code/name/city),
  **Players** (USTA #), **Rates** (cert type, $/day, effective-from), **Hotels**
  (name/city), **Distances** (one-way miles) and the **Roster** (division, status,
  shirt size, dietary — backend re-normalizes the shirt size). Composite/FK columns
  (official & player names, distance's official/site) stay form-only. Edited cells
  get a hover outline + focused-editor styling (light/dark).
- **✅ Tabulator grid — Pairing avoidances & Doubles** (phase 2d) — the last
  workspace lists move off hand-built tables onto `makeListGrid`: Pairing
  avoidances (Division / Relationship / Players-joined), Doubles **requests**
  (Player / USTA # / Division / Type chip / Partner status) and verified
  **pairs** (Division / Type chip / Player 1 / Player 2). Both Doubles grids share
  one panel, so `GRIDS[panelId]` holds an **array** and redraw-on-tab-show fans out
  to each. Add-forms, file-from-email and `loadInbox` refresh unchanged. (**Inbox**
  and the **report/summary** tables stay custom — interactive per-row controls and a
  print artifact, respectively.)
- **✅ Tabulator grid — Late entries & Withdrawals** (phase 2c) — a generic
  `makeListGrid` helper (delete-only list: Tabulator grid + Delete action + per-grid
  CSV download) now backs both: Late entries (with the ⚠ past-deadline flag) and
  Withdrawals (Alt?/Reason/Notes). Sortable, themed, redraw-on-tab-show; add-forms
  and file-from-email unchanged.
- **✅ Tabulator grid — Roster** (phase 2b) — the roster master-detail list is now a
  Tabulator grid: sortable columns, status **chip** formatter, themed light/dark,
  row-click → edit form, filter, Prev/Next over active rows, Edit/Delete actions,
  selection highlight; **⬇ CSV** via Tabulator download and the **Sign-in sheet**
  export unchanged (still built from the roster data array).
- **✅ Tabulator grid — workspace player lists** (phase 2a) — the `wirePlayerList`
  trio (Scheduling avoidances, Division flexibility, Player hotels) now render as
  Tabulator grids (sortable, themed, per-grid ⬇ CSV via Tabulator's native download,
  Delete action). The static tables are swapped for a mount in place (parent card
  untouched); grids redraw on tab-show. Add/delete/`after`-hook flows preserved.
- **✅ Tabulator grid for the Setup lists** (phase 1) — vendored **Tabulator 6.3.1**
  locally (`frontend/vendor/`, offline) and switched the 7 Setup master-detail lists
  (`wireEntity`) from hand-built `<table>`s to a Tabulator grid: **column sorting**
  (new), themed to the app palette for light **and** dark, row-click → detail form,
  external filter, Edit/Delete + "Work on →" actions, selection highlight, and
  Prev/Next stepping the grid's active (filtered+sorted) rows. Hidden panels redraw
  on tab-show. Workspace lists still use plain tables (phase 2 to follow).
- **✅ Player hotels reference the Hotels table** (migration `0023`) — `player_hotel_stay`
  gains a `hotel_id` FK; recording a hotel **upserts one canonical hotel row per name**
  (case-insensitive, whitespace-collapsed) and stores the canonical name, so the same
  hotel typed differently (`hilton` / `Hilton `) is **one hotel, counted once**. Existing
  rows backfilled. Applies to both the form and staged imports (`upsert_hotel`).
- **✅ T-shirt size constrained** (migration `0022`) — existing values normalized
  (codes + full forms → the canonical 7), anything off-list nulled, then a `CHECK`
  added so `tournament_entry.t_shirt_size` can only be NULL or one of the 7 sizes.
  Staged imports surface a non-canonical size as a per-row error (per-row savepoint);
  manual entry already uses the dropdown.
- **✅ Performance indexes** (migration `0021`) — added `IF NOT EXISTS` indexes on the
  per-tournament / foreign-key columns the hot queries filter on (assignment,
  room_block, availability, email_message, late_entry, withdrawal, scheduling/
  division, pairing, doubles, player_hotel_stay(tournament,player), certification,
  official_site_distance) — addresses the design-critique DB item.
- **✅ Import pipeline with staging** (migration `0020`) — the **Data → Import** page
  imports each data type from **CSV or Excel** through a **staging area**: upload →
  rows land in `import_batch`/`import_row` (parsed + per-row validated, *nothing written
  to the main tables yet*) → review the valid/invalid summary → **Merge** the valid rows.
  Six importable types (roster, late entries, withdrawals, scheduling avoidances,
  division flexibility, player hotels), each with a **template in both CSV and Excel**
  and tolerant header matching. Backend: `app/importer.py` registry (columns/aliases +
  per-type merge mirroring the routers, t-shirt size normalized) + `routers/imports.py`
  (`/types`, `/template/{type}?fmt=`, upload, `/batches/{id}`, `/merge`, discard) with a
  per-row SAVEPOINT so one bad row can't abort the batch.
  - **Conflicts surfaced**: merge proceeds but reports rows that hit existing data
    (e.g. "already on the roster — entry overwritten", "already has a late entry —
    another was added"); the response carries `conflicts[]` and the Import page lists
    them as a ⚠ note under the merge result.
- **✅ Design-critique fixes (moderate, non-security)** — from the `design-critique`
  review:
  - **Accessibility**: field labels bumped 0.68→0.72rem (~11.5px) and light `--muted`
    darkened `#647280`→`#556070` (~6:1) so small helper/label text clears WCAG AA.
  - **Combobox ARIA**: the type-in dropdowns now expose `role=combobox/listbox/option`
    with `aria-expanded / controls / haspopup / activedescendant / selected` and an
    `aria-label` (honors an explicit one on the select, e.g. "Active tournament") —
    usable by screen readers.
  - **Hotel-name drift**: `hotel_name`/`lodging_plan` whitespace-normalized on write,
    and the player-hotel field offers a **datalist of known hotels** (free text still
    allowed) so entries stay consistent without a rigid FK.
  - *(CSRF, Secure-cookie, default DB creds deferred as security/hardening.)*
- **✅ Data → Import page + exports on their pages** (reworked) — the central **Data**
  page is now an **Import** aggregation page: the roster CSV/Excel upload plus a
  **Download templates** list (10 blank, headers-only CSVs — roster is re-importable).
  **Exports moved back to each list's own page** (⬇ CSV above every list/summary
  table; roster gets ⬇ CSV + ⬇ Sign-in on its toolbar; T-shirts keeps ⬇ Order CSV;
  the report keeps Print + ⬇ CSV). *(Supersedes the earlier single Export page.)*
- **✅ Roster → master/detail** — the Tournament → Roster tab now uses the same
  master/detail layout as the Setup entities: a wide filterable list (own scrollbar)
  on the left, a sticky edit form with **Prev/Next** record nav on the right, row-
  click-to-edit + **+ New**, and a selected-row highlight. Bulk-data actions (Import /
  Template / CSV / Sign-in sheet) sit in one row above the grid. Replaces the old
  add-form-on-top + table layout for consistency.
- **✅ Player City/State** — migration `0019` adds `city`/`state` to `player`
  (not name-history-tracked); the Players form has City/State fields and the sign-in
  sheet now includes them, fully matching the workbook's columns.
- **✅ Sign-in sheet export** — the Roster tab has a **⬇ Sign-in sheet (CSV)** button
  that emits the workbook's sign-in format (Status / Events / Player / USTA # / City /
  State / Division / T-shirt / Hotel / Lodging plan / Dietary), joining the roster
  with this tournament's player-hotel rows, sorted by last name, including all statuses.
- **🔒 PII purged from git history** — the two sample workbooks (Officials Mileage +
  Full Tournament Data, which held officials'/minors' data) were committed earlier
  and pushed. History was rewritten (`git filter-branch`) to remove them from all
  refs and force-pushed (`app-poc`, `main`); `*.xlsx` stays gitignored. *(GitHub may
  retain cached commit views by old SHA and any forks/clones still have copies —
  out-of-band GitHub steps may be needed for full remediation.)*
- **✅ Player lodging plan** (matches the workbook's "Lodging Plans" column) —
  migration `0018` adds `lodging_plan` to `player_hotel_stay`; the Player-hotels form
  gains a **Lodging plan** dropdown (Hotel / Commuter / Commuter 1-2 hrs / Commuter
  2+ hrs / Local-family), the list shows it, and a new per-tournament **Lodging plan
  summary** (players per plan, selected only) sits beside the hotel summary — both
  CSV-exportable.
- **✅ Workspace layout consistency** (validation follow-up). After auditing all 22
  panels (the 7 Setup list/detail panels were already 100% consistent): (1) the
  **Inbox** and **Assignments** add-forms are now **collapsible** like the other 9
  workspace add-forms (Assignments' Edit auto-expands it); (2) **every workspace list
  table gets its own scrollbar** (`.tbl-scroll`, sticky header) like the Setup lists
  — long rosters/inboxes scroll within the card, not the page. The cap is
  `min(48vh, calc(100vh - 16rem))` so the heading + add-form + table don't push the
  whole page into a scrollbar (and short screens stay bounded). A print override
  keeps wrapped tables un-clipped when printing the report.
- **✅ T-shirt summary merges mixed size formats** — the order summary now keys each
  size by a canonical code (`shirtCode()` maps both legacy codes like `YM` and the
  dropdown's full names like `Youth Medium` to the same `YM`), so historical/imported
  data aggregates into one line per size instead of duplicate rows. Displayed as the
  full label, ordered YS→YM→YL→AS→AM→AL→AXL; unknown values pass through.
- **✅ T-shirt & hotel summaries — selected players only** (per the TD's workbook).
  Both the **t-shirt** order summary and the **hotel** summary now **exclude
  withdrawals and alternates** (`selection_status = 'selected'`).
  - T-shirts: order quantities sort smallest→largest (YS, YM, YL, AS, AM, AL, AXL),
    with a new **⬇ Order CSV (size → qty)** export for the vendor.
  - Hotels: a new per-tournament **Hotel summary** (players per hotel) on the Player-
    hotels tab — names **alphabetical** and grouped **case-insensitively** (consistent
    spelling), blanks excluded, with CSV export. The cross-tournament CVB totals get
    the same selected-only + consistent-name treatment.
- **✅ T-shirt size is a dropdown** — the roster's free-text T-shirt field is now a
  fixed-option select (combobox-enhanced): Youth Small/Medium/Large, Adult
  Small/Medium/Large/Extra Large (+ none). The T-shirts order-quantity summary sorts
  by this canonical apparel order.
- **✅ Roster import normalizes T-shirt sizes** — the CSV/XLSX importer maps both
  **abbreviated** (`YM`, `AL`, `XL`, `AS`, …) and **full** (`youth medium`,
  `Adult Large`, …) forms to the canonical labels (`_norm_shirt`); unrecognized
  values pass through unchanged so nothing is lost. Verified by a test covering YM /
  Adult Large / xl / youth small / AS.
- **✅ Report = TD "Staffing Plan" format** — the officials report was reshaped to the
  layout the TD uses: **Name · Position · Dietary · Hotel? · Check-in · Check-out ·
  one column per play-day weekday (✓) · Pay · Mileage**, titled "<Tournament> —
  Staffing Plan". Weekday columns are generated from the tournament's play window;
  ✓ marks the days each official works; flags (no-distance / off-window / hotel-date)
  collapse into a ⚠ next to the name. **CSV export** emits the same columns (X marks,
  Excel-openable) and the **Template** matches. Backend now exposes the room block's
  check-in/out on the assignment summary. *(Non-official staff — Site Director, Trainer,
  Operations, Stringer — aren't modeled yet, so only assigned officials appear.)*
- **✅ Dark-mode date picker** — the calendar icon was invisible on dark fields.
  Set `color-scheme: light/dark` per theme, and in dark mode **replace the
  `::-webkit-calendar-picker-indicator` with an explicit light SVG calendar** (the
  earlier `invert()` cancelled `color-scheme`'s already-light glyph, hence "almost
  invisible"). The SVG approach doesn't depend on the UA's faint glyph.
- **✅ Assignment Edit fixed (bug)** — the Assignments "Edit" button set the native
  `<select>` values but, since those fields are now comboboxes, the visible inputs
  didn't update — so Edit looked dead and you couldn't change site/hotel after adding
  cert/days. Edit now **resyncs the comboboxes**, scrolls the form into view, and shows
  an "editing #N" hint; updating site/hotel keeps the existing days.
- **✅ Inbox forwarding-address note** — the Review inbox now states plainly that a
  live forwarding address / auto-ingest isn't wired in the POC (deferred, needs mail
  infra) and that messages are pasted manually — answering "where do I send email?".
- **✅ Print forces light** — printing the officials report while the dark theme is
  active now overrides the palette to white/black in `@media print` (saves ink, stays
  legible), regardless of the on-screen theme.
- **✅ Dark theme** — a header **🌙 Dark / ☀ Light** toggle (persisted in
  `localStorage`, applied before first paint to avoid a flash). The palette is driven
  entirely by CSS variables; introduced `--field-bg / --zebra / --elev` and pointed the
  remaining hardcoded light backgrounds (inputs, zebra rows, cards, dropdowns,
  add-boxes, invalid fields) at them, with a full `:root[data-theme="dark"]` override.
  Verified: body bg + ink invert, toggle label flips, choice persists.
- **✅ Report buttons compacted + template** — the Reports toolbar buttons were
  oversized (1rem); now compact (0.8rem, `⬇ CSV`) and joined by a **⬇ Template**
  button that downloads the report's column headers. Also normalized the one remaining
  oversized button (`#work-on-btn`) to the standard compact size.
- **✅ "Work on →" from the tournament row** — the Setup → Tournaments list now has a
  per-row **Work on →** action (via a new `wireEntity` `rowAction` hook) that sets the
  active tournament, switches to the **Tournament** group, and opens its workspace in
  one click — no need to open the detail and use the form's "Work on this" button.
- **✅ Structured assignment card** — the dense run-on line (`name · site · hotel ·
  pay · mileage · total · flags`) is replaced by a small layout: **name** + Edit/Delete
  (top-right), a muted **meta** line (site / hotel / dietary), then **pay / mileage /
  total badges** and any **flags as colored chips** (hotel-date, off-window day,
  no-distance). Easier to scan at a glance.
- **✅ Required-field affordance + validation styling** — required inputs now show a
  red **`*`** inline with the label (added at load via `markRequiredFields()`, works
  for combobox-wrapped selects too), and controls turn red **only after interaction**
  (`:user-invalid`, incl. the combobox input via `:has()`) rather than on a pristine
  form. Verified: 3 stars on the tournament form, red `#c62828`, no console errors.
- **✅ T-shirts page completed** — the cumulative t-shirt list was just a flat
  per-tournament table. Added an **"Order quantities" summary** — the **latest size
  per player** (the rows arrive newest-first per player) counted by size and shown as
  badges in proper size order (YXS…3XL), with a player count. That's the actionable
  number a TD hands to the supplier; the per-row list remains below for detail.
- **✅ Late-entry deadline flag** — the previously-dead `late_entry_deadline` is now
  used: the late-entries list returns `past_deadline` (request date after the
  tournament's deadline) and the UI shows a **⚠ past deadline** marker. Surfaced,
  not blocked (consistent with the other date flags). Backend + model + test.
- **✅ Inline "add distance" on assignments** — when an assignment's venue site has
  no mileage on file, the card shows an inline **one-way miles + add distance**
  control that POSTs to `/api/distances` and refreshes, instead of making the TD
  switch to the Distances tab.
- **✅ Deferred items documented** — the four external-dependency/decision items
  (Maps geocoding, email auto-ingest, LLM triage/D5, PII-at-rest + DB hardening)
  are now an explicit **"On hold"** table in the roadmap with blockers + unblock
  steps.

---

## Audit follow-ups (2026-05-25) — applied
A full code + docs audit produced these fixes (backend + tests + docs):
- **Security** — sessions now **expire** (migration `0017`, 30-day window, rejected and
  cleaned up at auth time) and are **invalidated when an official's login is reset**.
- **Reports** — removed an N+1 (the official's dietary is folded into the assignment
  query) and added an **off-window-day** count to the totals.
- **Flags** — `work_date_out_of_window` is surfaced on assignments and in the report
  flags column / CSV.
- **Consistency** — room-block create/update now return `rooms_remaining`; availability
  PUT validates the official (400 instead of a 500); doubles **random requires a
  division** (else cross-division pairing).
- **Docs** — corrected the data-model relationship sketch (Certification / Availability /
  Part B now ✅), the `cert_type` field name, the Part-B build-status header, and the
  smoke-test count.
- Test suite grew **30 -> 34**, all passing.

---

## UI/UX pass 1 (2026-05-25) — applied
First batch from the UI review (frontend only; backend/tests unchanged):
- **✅ Grouped tournament nav** — the 14 tournament tabs are split into labeled
  sub-areas: **Tournament** (Sites/Roster/Availability), **Staffing**
  (Assignments/Room blocks/Reports), **Player requests** (Inbox + the 7 lists).
- **✅ Status color chips** — `selection_status`, email `status`, doubles type, etc.
  render as tinted badges (ok/warn/bad/info/muted) for scannability.
- **✅ Toasts** — every `setMsg` also raises a corner toast (errors linger longer);
  inline messages kept.
- **✅ Accessibility** — `:focus-visible` outlines; the menu is a `role="tablist"`
  with `aria-selected` and **arrow-key** navigation.
- **✅ Table polish** — zebra striping + **sticky headers** on list tables.

## UI/UX pass 2 (2026-05-25) — applied
- **✅ Global loading bar** — a thin top progress bar driven by the `api()` wrapper
  (shows whenever any request is in flight).
- **✅ Right-aligned numeric columns** — report pay/mileage/total, rate/day,
  one-way miles, room counts.
- **✅ Button consistency** — the previously unstyled save buttons (availability,
  my-availability) now match the primary button; report Print/CSV already matched.

## UI/UX pass 3 (2026-05-25) — applied
- **✅ Styled delete confirm** — a real modal (`confirmDialog()`, Esc/Enter
  support) replaces the browser's native `confirm()` across all 11 delete actions.
- **✅ Busy-on-submit** — the Setup forms disable their submit button while saving
  (prevents double-submit; complements the global loading bar).

## UI/UX pass 4 (2026-05-25) — applied
- **✅ Collapsible add-forms** — the 9 workspace add-forms are wrapped (at runtime,
  no HTML churn) in `<details>` and **closed by default** so the list is primary;
  they **auto-open** when filing-from-email or editing a row.
- **✅ Busy-on-submit extended** to the workspace `wirePlayerList` forms
  (scheduling/division/player-hotels) on top of the Setup forms.

## UI/UX pass 5 (2026-05-25) — applied
- **✅ Fixed master-detail proportions (bug)** — the grid had the **list capped at
  360px** (`minmax(260px,360px) 1fr`), forcing long columns (e.g. site/hotel
  names) to wrap to many lines. Flipped to `minmax(0,1fr) minmax(280px,380px)` so
  the **list gets the room** and the form is bounded; raised the stacking
  breakpoint to **980px** so medium screens get a **full-width list** instead of a
  cramped two-column; page max-width 1100→1200; the edit form is **sticky** while
  scrolling a long list. Verified: a 1421px viewport gives a 752px list with the
  long names on a single 36px row.

## UI/UX pass 6 (2026-05-25) — applied
- **✅ Compact forms** — denser detail/add forms per request: small **uppercase
  field labels** (0.68rem), smaller controls (0.82rem, tighter padding), reduced
  row spacing, and **compact buttons** (submit/delete/cancel/new/save at 0.8rem).
  Forms take far less vertical space while staying readable.

## UI/UX pass 7 (2026-05-25) — applied
- **✅ Condensed toolbar** — the whole top chrome was slimmed to reclaim vertical
  space: **header** padding 1rem→0.5rem and the **h1** 1.4rem→1.05rem; the
  **context bar** is tighter (padding 0.4→0.25rem, gap 0.5→0.4rem, font 0.85→
  0.72rem) with a smaller **active-tournament select** (min-width 240→200px,
  0.78rem); the **nav menu** is denser (gap 1.5→1rem, 2px under-border) with
  smaller **tabs** (0.92→0.82rem, padding 0.55/0.85→0.38/0.7rem) and **group
  labels** (0.7→0.6rem); **user box / logout** dropped to 0.72rem. Verified in
  preview: h1 16.8px, tabs 13.12px, context-bar 4px/8.8px padding, no console
  errors.

## UI/UX pass 8 (2026-05-25) — applied
- **✅ Lists own their scrollbar** (native, dependency-free per D6) — each Setup
  master-detail list now lives in a `.list-scroll` container with its **own
  vertical scrollbar** (`max-height: calc(100vh - 200px)`, sticky header pinned to
  the container edge). The list no longer pushes the page tall, so the sticky edit
  form stays in view — no more scrolling **past** the form to reach items at the
  bottom. *(We kept the pure-HTML/CSS approach rather than adopting a third-party
  grid like Tabulator/AG Grid, on the user's call — same "grid with its own
  scrollbar" UX, no CDN dependency, works offline.)*
- **✅ Prev / Next record navigation** — every master-detail detail form gets a
  small nav bar (`‹ Prev` · `N / total` · `Next ›`) that steps through the
  **currently filtered** list without touching the list at all; endpoints disable
  at the ends, the position counter reflects the active filter, and the selected
  row auto-scrolls into view inside its container. Verified in preview: 7 scroll
  containers + 7 nav bars, `1 / 2`→`2 / 2` stepping, Prev disabled on the first
  record, no console errors.

## UI/UX pass 9 (2026-05-25) — applied
- **✅ List height bounded to the viewport (dynamic)** — the earlier
  `calc(100vh - 200px)` was a guess and could still run a long list off the bottom
  of the screen. Now a tiny `sizeLists()` helper measures each active
  `.list-scroll`'s real top offset and sets a `--list-max` CSS variable to the
  exact space remaining (`innerHeight − top − 16px`), recomputed on **tab switch,
  window resize, and load**. The list's own scrollbar now always ends inside the
  viewport regardless of toolbar height. Verified: list top 212px → `--list-max`
  1051px → list bottom within the 1279px viewport.
- **✅ Toolbar condensed further** — second density pass: header padding 0.5→0.3rem
  and h1 1.05→0.92rem (14.7px); context bar padding 0.25→0.18rem, labels 0.72→
  0.68rem, active-tournament select 0.78→0.74rem (min-width 200→180); nav tabs
  0.82→0.78rem (12.5px) with tighter padding (0.38/0.7→0.28/0.6rem) and group
  labels 0.6→0.55rem.

## UI/UX pass 10 (2026-05-25) — applied
- **✅ Two-level menu** — the toolbar no longer shows every tab at once. A
  **level-1 bar** lists the four sections (**Setup · Tournament · Staffing ·
  Player requests**); picking one reveals **only that group's tabs** in the
  level-2 bar (`.menu-group.group-active`), auto-opening its first enabled tab.
  Cross-group jumps (e.g. file-from-email) keep the level-1 highlight in sync.
  Verified: 4 group buttons, exactly one group's tabs visible, Staffing→Assignments
  opens correctly.
- **✅ Type-in dropdowns (searchable comboboxes)** — every native `<select>` is
  progressively enhanced into a **filter-as-you-type** dropdown (`enhanceSelect`):
  a text input overlays the select, typing filters options, ↑/↓/Enter/Esc work,
  and click-away closes. The native `<select>` stays the **source of truth**
  (value/`required`/submit/listeners unchanged), with displays re-synced on
  change / option-repopulation (MutationObserver) / form reset / edit-fill /
  active-tournament restore. Stayed **dependency-free** (no Select2/Choices.js).
  Verified: 17 comboboxes; the officials picker filters 51→5 on "z" and writes the
  chosen value back to the select; no console errors.

## UI/UX pass 11 (2026-05-25) — applied
- **✅ Part B forms reference the existing Players list** — every Staffing /
  Player-request form now **picks an existing player** instead of free-typing a
  name + USTA #. The three free-text fields (USTA #, first, last) collapsed into a
  single **Player** picker (`select.player-ref`, a type-in combobox) on late
  entries, withdrawals, scheduling avoidances, division flexibility, player hotels,
  doubles (player **and** partner), and each **pairing-group member** row.
  (Staffing's Assignments already used an officials picker.) On submit the chosen
  player is resolved back to USTA #/first/last, so the **backend is unchanged**
  (it still upserts/matches by USTA #). The file-from-email flow focuses the new
  player picker. Verified end-to-end: filing a scheduling avoidance via the picker
  created the row against the active tournament for the referenced player; 9 player
  pickers populate (14 players + blank); no console errors.

## UI/UX pass 12 (2026-05-25) — applied
- **✅ Combobox placeholder fix** — the "— select … —" prompt was sitting in the
  input as a real value, so you had to delete it before typing a search. It's now
  rendered as the input's grey **`placeholder`** (the field starts empty), and the
  input **selects its text on focus** so an existing choice can be typed over too.
  Verified: an unset player picker shows empty value + "— select player —"
  placeholder, and typing "jon" filters straight to "Jones, Sam" with no clearing.

## UI/UX pass 13 (2026-05-25) — applied
- **✅ CSV template downloads** — next to each list's **⬇ CSV** export button there
  is now a **⬇ Template** button that downloads an **empty CSV with just the
  headers** for the user to fill in. **Roster's** template uses the importer's
  **canonical field names** (`usta_number, first_name, last_name, age_division,
  events, selection_status, t_shirt_size, dietary_preference`) so the filled file
  re-imports as-is; other lists use their visible column headers. Derived/aggregate
  lists (verified doubles pairs, CVB totals, inbox, cumulative t-shirts) are
  export-only and get no template. Verified: 8 template + 12 export buttons; roster
  template emits the canonical header row; no console errors.

## UI/UX pass 14 (2026-05-25) — applied
- **✅ Full-width layout** — dropped the centered **1200px cap** on `main` (which
  left large empty margins on wide screens) in favour of a **fluid full-window**
  layout with comfortable side padding (1.75rem). The reclaimed space goes to the
  **list** (1fr) and the **detail form** (cap nudged 380→420px). Verified at a
  1421px viewport: `main` 1421px, list pane 925px (was ~752px), form 420px; no
  console errors.
  - **Rebalanced** (follow-up): the lists were too wide and the form too narrow, so
    the detail column was widened to `minmax(420px, 600px)` — at 1421px the form is
    now 600px and the list 745px.

## UI/UX pass 15 (2026-05-25) — applied
- **✅ Combobox dropdown contrast fix (bug)** — dropdown items were **inheriting**
  their text colour from the surroundings: the header (active-tournament) combobox
  showed **white text on the white list** (invisible), and form comboboxes inherited
  the muted-grey label colour (low contrast). The `.combo-list`/`.combo-item` now
  set explicit `color: var(--ink)` on `#fff` (and reset inherited uppercase/letter-
  spacing), with highlighted/selected rows keeping dark ink on the light `--sel`
  green. Verified: item text is `rgb(31,41,51)` in both header and form dropdowns.

## UI/UX pass 16 (2026-05-25) — applied
- **✅ Placeholder no longer a dropdown row** — the blank "— select … —" / "— none —"
  option was appearing as a selectable item in the combobox list. It's now excluded
  from the rendered list (it already shows as the input's grey placeholder). Optional
  fields are still clearable: empty the text and commit (Enter / click-away) and the
  selection resets to none; required fields simply have no blank row. Verified:
  active-tournament shows only the 2 tournaments, an optional site picker shows only
  real sites yet still clears to none, and the required player picker lists only
  players — no "— … —" rows anywhere.

## UI/UX pass 17 (2026-05-25) — applied
- **✅ Roster import row tidied** — the oversized **Import CSV/XLSX** button is now a
  compact **Import** (0.8rem), and a **⬇ Template** button sits right beside the
  upload control (secondary `.ghost` style) so the importer's template is where you
  need it. The template emits the importer's **canonical columns**
  (`usta_number … dietary_preference`) — fill it in and re-upload. The redundant
  table-side roster template was removed (roster added to `NO_TEMPLATE`); the roster
  table keeps its **⬇ CSV** export. Verified: Import 12.8px/compact padding, template
  emits the canonical header row, only the CSV export remains by the table; no
  console errors.

## UI/UX pass 18 (2026-05-25) — applied (roadmap correctness gaps)
Reviewed the roadmap and executed the two outstanding **🟡 correctness gaps** that
need no external service:
- **✅ Assignment site constrained** to the active tournament's sites (dropdown
  filled per-tournament in `loadAssignments`). Verified: 1 linked site shown vs 4
  global.
- **✅ Work-date bounds warning** — ⚠ flag on out-of-window day chips + an
  "Add anyway?" confirm when adding a day outside the play window (warning, not a
  block — audit §3.4). Verified via `_outOfWindow`.

### Deferred — need an external service or an explicit decision (not executed)
These remaining roadmap items can't be completed inside the local POC without new
infrastructure or a privacy decision, so they're intentionally left open:
- **Google Maps geocoding** for auto-distance (Phase 2) — needs a Maps API key +
  network egress; **manual distance entry is the working fallback** today (D3/U2).
- **Dedicated forwarding-address email auto-ingest** (Phase 3, D4) — needs real
  mail infra; **manual add to the review inbox** is the working POC path.
- **LLM triage upgrade** (D5) — the local rule-based suggester ships; an LLM that
  reads minors' email content requires the **cloud-vs-local privacy call first**.
- **PII encryption at rest / retention** + **DB hardening** (Phase 5, audit §5) —
  tied to the post-POC deployment switch (dedicated DB user, secrets, TLS).
- **Money audit trail** beyond the current snapshot (store all calc *inputs*),
  **correction-handling** for amending emails, and **multi-user TD access** (D8) —
  lower-priority polish.

## UI/UX pass 19 (2026-05-25) — applied (remaining UI-review backlog)
- **✅ Busy-on-submit everywhere** — added an `onSubmit(form, handler)` helper that
  preventDefaults and **disables the submit button while the async handler runs**
  (re-enabling in `finally`, even on early return/error). Routed every remaining
  bespoke form through it: roster, assignment, room-block, email, late entry,
  withdrawal, pairing, doubles, login, and profile. (Setup `wireEntity` and
  `wirePlayerList` already had it.) Verified: the email form's button disables
  during submit and re-enables after.
- **✅ Narrow-screen nav** — at ≤720px both nav rows (level-1 groups + level-2 tabs)
  **scroll horizontally** (`overflow-x:auto; flex-wrap:nowrap`) instead of wrapping
  into many rows; the context bar wraps and the active-tournament picker shrinks to
  140px. Also fixed the **print** rule to hide the new level-1 bar. Verified at
  375px: both rows `overflow-x:auto; nowrap`.

Still open from the UI review (no external dep, just lower priority): a full
button-style **utility-class system** (cosmetic refactor), the inline "add
distance" fix on assignments, and the structured assignment-card layout.
