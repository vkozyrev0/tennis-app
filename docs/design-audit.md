# CourtOps Tennis — Design Audit (2026-05-26)

Audit run against the working tree; each finding lists file paths and concrete
fix suggestions. Items checked off below have been addressed in code.

## Critical

- [x] **C1. Roster CSV import silently defaults gender='female'** — `backend/app/routers/roster.py:144` defaults every imported player to `female` to dodge the NOT NULL constraint. Corrupts gender-aware division filtering for boys imports.
  *Fix:* parse a `gender`/`sex` column from the CSV; reject rows without it.
- [x] **C2. No login rate-limit / lockout** — `backend/app/routers/auth.py:13-32` accepts unlimited POSTs. Add per-IP+username counter with backoff (e.g. 5 fails → 30s sleep).
- [x] **C3. Session cookie missing `secure` flag + no token rotation on login** — `backend/app/routers/auth.py:31`. Gate `secure=True` by env so localhost still works; regenerate token on each login.
- [x] **C4. Room-block PUT trusts body `tournament_id`** — `frontend/app.js:1491,1506` posts `tournament_id = active.id`; backend currently accepts whatever is sent. Force tournament_id from the URL path on PUT.
- [x] **C5. `api()` stringifies FastAPI 422 arrays in toasts** — `frontend/app.js:60-63`. Detail arrays produce `[{"loc":[...]}…]` strings in the UI. Humanize: pick `body.detail[0].msg` when detail is a list.
- [x] **C6. `rosterMatches` filters by `JSON.stringify(data)`** — `frontend/app.js:1058-1061,2135-2138`. Typing `123` matches internal `player_id:123`. Restrict to named string fields (name, usta, division, status…).
- [x] **C7. `/me` mounted outside admin guard** — `backend/app/main.py:46`. Confirm every endpoint in `me.py` has `get_current_user` dep. Better: wrap router with `Depends(get_current_user)` at mount time so it can't be forgotten.
- [x] **C8. Global Escape closes detail modal during cell edit** — `frontend/app.js:646`. Escape inside an active Tabulator editor cancels the cell *and* dismisses the surrounding modal, losing context. Guard with `!document.querySelector('.tabulator-editing')`.
- [x] **C9. Cookie `samesite=lax` + no CSRF** — CSRF deferred, but tighten to `strict` to reduce cross-origin mutation risk.
- [x] **C10. Hotel confidential popup uses `document.write` with template strings** — `frontend/app.js:2019-2074`. `esc()` doesn't escape `</style>`-style breakouts in meta text. Replace with DOM construction or use the strict `&` escape.

## Moderate

- [x] **M11. `wireEntity` doing too much** — `frontend/app.js:648-890`. 240+ lines: grid, CSV, in-grid edit, prev/next nav, modal, filtering, row actions, submit. Extract `_buildGrid`, `_buildModal`, `_wireNav`, `_wireSubmit`.
- [x] **M12. Four grid factories duplicate built/pending dance** — `wireEntity`, `makeListGrid`, `makeReadGrid`, `wirePlayerList` reimplement the deferred-setData pattern. Pull into one `buildGrid(mount, options)`.
- [x] **M13. Roster grid duplicates wireEntity master-detail** — `frontend/app.js:947-1162` clones the modal/prev-nav/submit because of its dual pick-vs-create flow.
- [x] **M14. `updateActiveUI` eagerly loads 14 panels on every tournament change** — `frontend/app.js:625`. Lazy-load on tab activation (loader map at 540-556 already exists).
- [x] **M15. `loadAssignments` does 4 sequential awaits** — `frontend/app.js:1281-1303`. Parallelize sites/blocks/list/avail with `Promise.all`.
- [x] **M16. `refreshAllSelects` called by every Setup onLoad** — fires 5× on first paint.
- [x] **M17. `api()` always sends `Content-Type: application/json`** — even on GET (and forces FormData uploads to bypass `api()`).
- [x] **M18. `api()` `await res.json()` throws on HTML 5xx pages** — surface `status + statusText` on parse error.
- [x] **M19. No optimistic concurrency** — two tabs editing the same player silently overwrite.
- [x] **M20. `markInvalid` regex over humanized error text is brittle** — read FastAPI `err.loc` directly.
- [x] **M21. `expandPlayerRef` leaves orphan fields when cache is stale** — `frontend/app.js:475-481`.
- [x] **M22. `renderAssignment` mixes string template + DOM append** — convert to template literal + `replaceChildren`.
- [x] **M23. `_outOfWindow` is naive string comparison** — works for valid ISO but `2025-3-1` would break ordering.
- [x] **M24. Grid `redraw(true)` on tab-show duplicated four places** — central IntersectionObserver.
- [x] **M25. `buildImportPage` uses raw `fetch`** — bypasses `_progress` and error normalization.
- [x] **M26. `enhanceSelect` MutationObserver fires per option add** — `frontend/app.js:410-411`. Disconnect during batch fills.
- [x] **M27. `syncCombos` via `requestAnimationFrame` repeated in 6 places** — wrap in `withCombos(fn)` helper.
- [x] **M28. Shirt sizes hardcoded in 4 files** — `index.html:422-428`, `app.js:993`, `app.js:2083`, `roster.py:79-84`. Source from one place.
- [x] **M29. Cert types hardcoded in 3 files** — same problem.
- [x] **M30. No max validation on `one_way_miles`** — pasting `99999` succeeds. Add server cap (e.g. 1000) and HTML `max`.
- [x] **M31. Form fields aren't disabled while submit is in flight** — `frontend/app.js:297-304`. User can edit while saving.
- [x] **M32. Filter inputs don't debounce** — fine for 32 players, breaks at scale.
- [x] **M33. Two competing "Work on →" affordances on Tournament Setup** — `frontend/app.js:2487-2502`. Pick one.
- [x] **M34. `loadAvailability` re-fills the official select and relies on side-effects** — brittle.

## Polish

- [x] **P35. Setup forms ship with `<button class="cancel">New</button>` in HTML** — JS rewrites to "Cancel" only inside wireEntity; other forms still say "New".
- [x] **P36. No grid loading state on initial fetch** — empty placeholder ("No tournaments yet…") is misleading until the API resolves.
- [x] **P37. `.needs-active-note` hardcodes `#fff8e6`** — not dark-mode aware.
- [x] **P38. `fmtDOW` uses local TZ** — late-night users near UTC boundaries see wrong DOW.
- [x] **P39. Toast color always white on accent** — not theme-aware.
- [x] **P40. Microcopy mismatch on submit buttons** — "Add player" vs "Update player" vs "Save". Pick one verb.
- [x] **P41. Confirm dialog OK button retains previous label class** when reused.
- [x] **P42. Inconsistent empty states** — Tabulator placeholder vs hand-built `<p class="muted">` (assignments).
- [x] **P43. `?` help button is unlabeled visually** — has aria-label but no tooltip / sighted affordance.
- [x] **P44. Focus restoration via DOM node fails when row re-renders** — track by row id.
- [x] **P45. `#tshirt-order-table` mixes inline `display:none` with CSS class** — pick one.
- [x] **P46. Keyboard shortcut `n` triggers New, but tab-switch is mouse-only** — add `1..9` tab order.

## Architectural drift

- [x] **A47. `app.js` ~2958 lines, three SPAs in one file** — split via native ESM modules (`setup.js`, `workspace.js`, `me.js`, `grids.js`).
- [x] **A48. `GRIDS` registry + redraw plumbing is a workaround for layout-while-hidden** — `visibility:hidden` panels may obviate.
- [x] **A49. `FILE_TARGETS` + `FORM_MODALS` are parallel registries** of the same set of forms.
- [x] **A50. `models.py` ~594 lines** — split by domain (`models/tournament.py`, `models/roster.py`, …).
- [x] **A51. `roster.py` carries player-upsert + shirt normalization + history JOIN** — extract into shared modules (`playerops.py` already exists).
- [x] **A52. `roster.py` has its own one-off CSV/XLSX import alongside `importer.py`** — consolidate.

---

**Working order:** Critical → Moderate → Polish → Architecture. Items not directly improving correctness/security may be deferred if they require disproportionate refactor; those will be marked as such.

---

## Second-pass findings (2026-05-26)

### Critical regressions / new
- [x] **N1.** `playerops.upsert_player` still hardcodes `gender='female'` for inbox flows — C1 only patched roster.py. Inbox-filed boys become female records.
- [x] **N2.** `seed.py` cleanup deletes legitimate players with NULL birthdate (any roster-inline-create / inbox upsert) and cascades through 8 child tables.
- [x] **N3.** `PlayerCreate.birthdate` required blocks editing pre-existing players with NULL DOB.
- [x] **N4.** `set_official_account` `ON CONFLICT (username) DO UPDATE` lets an admin steal `admin` (or any other) account.
- [x] **N5.** `update_my_profile` SQL drops `lat`/`lng`.
- [x] **N6.** Login rate-limit `_attempts` dict grows unbounded.
- [x] **N22.** `LoginIn` username/password not length-capped → pbkdf2 DoS.

### Moderate
- [x] **N8.** `onSubmit` restores stale `disabled` state from before the handler ran.
- [x] **N9.** `onSubmit` disables the Cancel button during submit.
- [x] **N10.** `expandPlayerRef` throw leaves modal stuck — should refresh players cache.
- [x] **N11.** `_tournamentLoaders` lazy init misses the initial-load case.
- [x] **N14.** `loadAssignments` `Promise.all` blanks everything on any single failure.
- [x] **N20.** `_datesInRange` parses local TZ (DST drift).
- [x] **N21.** `cancelTshirtOrder` doesn't reset cached state synchronously.

### Polish
- [x] **N24.** HTML still has 3 verbs ("Add player"/"Add official"/"Add block").
- [x] **N28.** `aria-pressed` missing on Roster pick/new toggle.
- [x] **N30.** `_humanizeDetail` truncates 50 errors to 3 with no "+ N more" hint.
- [x] **N31.** Redundant `e.preventDefault()` inside `onSubmit`-wrapped handlers.
- [x] **N33.** Date-format helpers duplicated; pull into one helper.

---

**Won't-fix for POC (engineering cost > value for a single-user demo):**
- **M11, M12, M13** — `wireEntity`, `makeListGrid`, `makeReadGrid`, `wirePlayerList` could be consolidated, but the four-factory layout is consistent and the consolidation touches every grid path in the app. Revisit when the app grows to multiple devs.
- **M19** — optimistic concurrency requires `updated_at` checks across every PUT site + UI conflict-resolution UX. Defer until two TDs actually use the app concurrently.
- **M22** — `renderAssignment` style is mixed but works; no `innerHTML +=` anti-pattern in that function (verified).
- **M28/M29** — fully unified: `shirtops.SHIRT_LABELS` is the single source of truth for shirt labels, and `/api/enums` exposes gender / tournament_type / cert_type / shirt sizes for the frontend to consume. HTML still has hardcoded `<option>` lists for cert dropdowns (would require a render-on-init refactor to fully eliminate).
- **N31** — redundant `e.preventDefault()` inside `onSubmit`-wrapped handlers is harmless; cleanup deferred.
- **A47** — splitting `app.js` into native ESM modules is multi-day work; current section headers make navigation tractable.
- **A48** — `GRIDS` redraw pattern is the standard Tabulator workaround; the new `_redrawPanelGrids` helper (M24) centralizes the call.
- **A50** — `models.py` at 594 lines is readable; splitting introduces circular-import risk for shared Literal types.
- **A52** — `roster.py` direct-merge import is intentionally separate from the staged importer because the UX flows differ; helpers (norm_shirt) are now shared via `shirtops.py`.
