# Mobile-friendly plan + menu IA

CourtOps is a **tournament-director desk**: dense grids, two-level nav, a
context tournament picker, and a review inbox. It is used at a laptop in
planning week and on a phone or tablet **courtside** (day-of venue view,
inbox, incidents). This plan is how we make the second context work without
throwing away the grass-court desktop.

The visual identity stays: late-afternoon grass chrome, tennis-ball yellow
court line, scoreboard type. Mobile work is **structure and hit targets**,
not a second brand.

## What is true today

Shipped, not a blank slate:

- Viewport meta is set. Login card, toasts, and some toolbars wrap.
- L1 icons drop labels under 480px. L1/L2 scroll sideways under 720px.
- Hover-only inbox/edit affordances stay visible on `hover: none`.
- Inbox grid has a 380px floor so Review/⋯ stay clickable.
- Account actions already live in an overflow menu.

Still a **desktop app in a phone window**:

- Sticky stack is header + Working-on bar + L1 + L2 + breadcrumbs. On a
  667px-tall phone that can eat ~220px before a grid appears.
- AG Grid tables (inbox, roster, assignments, payroll) do not collapse to
  cards. Horizontal pan is the only path, and column mins fight the
  viewport.
- Forms (inbox review, assignment editor, import) are multi-column rows
  that overflow or shrink labels into unreadability.
- L1 is seven groups; Setup still has thirteen L2 tabs. Icon-only L1 is
  guesswork courtside.
- No drawer, no “More”, no way to hide chrome on Day-of.
- Touch targets on desktop chrome are 32px. 44px now applies under 720px
  for L1/L2 only.

## Menu — critique and direction

**What works.** Two levels (group → page) is the right model for this
catalog. Solo L1 (Day-of, Inbox) skipping a redundant L2 bar is correct.
Badges on Inbox / Player lists earn their keep. “Working on” as the scope
control is clearer than putting the tournament inside every page title.

**What is wrong.**

1. **Chat was a whole L1 group for one page.** Low-frequency next to
   Day-of. **Shipped this round:** Chat is a Home L2 tab (Dashboard | Chat).
   L1 is seven groups, not eight.
2. **Setup is a junk drawer** (13 tabs: catalogs + Import + Notices +
   Users + T-shirts). Import is a workflow; Notices is a log; Users is
   admin. They drown Sites / Officials / Players.
3. **Player lists is seven sibling tabs** with truncated names
   (`Div. flex`, `Pairing avoid.`). **Shipped this round:** full labels
   (`Division flex`, `Pairing avoidances`). The group is still a pile;
   Day-of TDs only need Inbox + Withdrawals + Doubles.
4. **Icon-only L1 under 480px** hides the only thing that distinguishes
   Setup from Tournament (gear vs trophy is not enough at 16px on grass).
5. **Keyboard 1–9 is L2 only.** L1 has no equivalent, so Home → Chat is
   a click, not a key.
6. **Breadcrumbs + L1 + L2** narrate the same place three times on a
   phone.

**Do next (nav), in this order.**

| # | Change | Why |
|---|---|---|
| N1 | **Phone drawer for L1.** Hamburger in the header opens a labeled list (not icons). L2 stays a horizontal strip for the open group. | Icon-only L1 fails courtside. A drawer is the one new pattern; do not add a third nav row. |
| N2 | **Split Setup.** L1 “Setup” = Sites, Officials, Players, Rates, Hotels, Distances, Divisions, Events. Move Import + Notices + Users + T-shirts into L1 **Data** (or keep T-shirts under Setup catalog — it is a size list). | 13 tabs will never fit a phone strip. |
| N3 | **Player lists: Inbox-adjacent short list on Day-of.** Keep the full group on desktop. On a phone in Day-of, surface Inbox, Incidents, Withdrawals, Doubles only (a “Today” slice). | Courtside does not need Div. flex. |
| N4 | **Hide breadcrumbs under 720px.** History is a desktop trail; Back (already Alt+Left / crumb-back) is enough on a phone. Recovers a sticky row. |
| N5 | **Collapse Working-on + search.** One field: tournament picker; search behind a magnifying-glass that expands. |
| N6 | **Do not** add a mega-menu, a left sidebar that is always visible, or a bottom tab bar of every L1 group. Bottom tabs fight the keyboard and the inbox bulk bar. |

Chat stays under Home. Do not promote it back to L1.

## Mobile phases

Ship one phase at a time. Each phase is usable on its own. Desktop must
not regress (the TD still lives in AG Grid on a laptop).

### P0 — Chrome that fits a hand *(this round + next)*

- [x] Separate API / DB / Intelligence header chips (not one combined pill).
- [x] UI copy says **Intelligence**, never LLM / sidecar.
- [x] Chat under Home; full Player-list tab names.
- [x] L1/L2 min-height 44px under 720px; L1/L2 already scroll sideways.
- [ ] N1 drawer for L1 under 720px (labeled, badge counts preserved).
- [ ] N4 hide breadcrumbs under 720px.
- [ ] N5 collapse context bar.
- [ ] Sticky offsets (`--nav-sticky-*`) recompute when L2/crumbs hide so
      grids are not stranded under leftover padding.

**Done when:** signed-in Home, Day-of, and Inbox are reachable in three
taps on a 390×844 viewport without horizontal page scroll (nav strips
may still pan).

### P1 — Day-of + Inbox on a phone

These are the only screens that **must** work courtside.

- Venue view: one column, 44px accept/decline, incident log as a stacked
  list (not a wide grid).
- Inbox: card rows on viewports &lt;720px (From, Subject, Player,
  Classification, Status, Review). Keep AG Grid at ≥720px.
- Inbox review sheet: full-width drawer from the bottom, not a centered
  modal. Primary actions (Save, File) pinned.
- Incidents: same stacked pattern as venue.

**Done when:** a TD can file one email and log one incident on a phone
without pinch-zoom.

### P2 — Lists that can wait until the hotel

Roster, assignments, payroll, reports, import stay **desktop-first**.
On a phone:

- Show a “Open on a larger screen for the full grid” callout **or**
  a read-only card summary (counts, next action) with a link.
- Do not invent a second editor for payroll.

Import, Setup catalogs, distances: out of P2.

### P3 — Forms, print, official portal

- Assignment / roster add forms: single column under 720px.
- Official portal (accept/decline, my schedule): already closer to
  mobile; audit hit targets and the ics link.
- Print CSS already hides chrome; leave it.

## Health chips (shipped)

Header is a **scoreboard strip** of three chips:

| Chip | Wire field | Healthy | Problem |
|---|---|---|---|
| API | request succeeded | ball-yellow pip | red — unreachable |
| DB | `GET /api/health` `db` | ball-yellow pip | red — down |
| Intelligence | `GET /api/health` `llm` | ball-yellow pip | amber — on but down; gray — off |

The JSON field stays `llm` (API compatibility). The **words on screen**
are Intelligence. Dashboard and Chat use the same term.

## How to verify a phase

1. Desktop ≥1100px: L1 labeled, L2 tabs, grids unchanged.
2. 720px and 390px: drawer (once N1 lands), 44px hits, no clipped
   primary actions.
3. `hover: none`: inbox Review/⋯ visible without a pointer.
4. Frontend node tests + a signed-in click-through of Home, Day-of,
   Inbox.

Do not Fly-redeploy `courtops-llm` for UI work. Site app only.
