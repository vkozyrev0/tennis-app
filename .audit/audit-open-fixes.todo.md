# Audit open-findings pass — todo

Playbook: figure-it-out (a cross-cutting fix pass over the confirmed open
findings from the 2026-10-17 audit, not one bug).

## figure-it-out

- [x] Read the Principles section of the **poteto-mode** skill.
- [x] Phase A: Frame — definition of done as a falsifiable predicate; scope quantified; rigor level.
- [x] Phase B: Design the workflow — atomic units, riskiest-unknown-first, verification harness before the work.
- [x] Phase C: Run the loop — hypothesis, smallest change, measure on the real artifact, keep or revert.
- [x] Phase D: Keep the audit trail — one TSV row per decision (`show-me-your-work`).
- [x] Phase E: Verify and hand back — whole against the Phase A predicate; encode recurring corrections as checks.

## Designed units

Baseline (before any new change)

- [x] U0 Re-run the inherited audit-pass tree: ruff, ESLint, Node suites, docs counts, full pytest. 1065 passed in 13:52.
- [x] U1 Commit the inherited audit pass as its own reviewed unit (57ea514) so the new fixes stay separable.

Findings from the 2026-10-17 audit register (Open table)

- [x] U2 D22 (M) Login throttle: global per-IP cap beside the per-(IP,user) cap; trusted proxy headers on Fly/Render.
- [x] U3 D20 (M) PII view audit: catalog list, single-player GET, history, and inbox body reads; accept-vs-redact decision recorded.
- [x] U4 D23 (L) Feed cursor: advance only past contiguous successes; persist the error status on the download failure path.
- [x] U5 D27 (L) Check-then-act: `FOR UPDATE` on the room block and the payroll record rows.
- [x] U6 D24 (L) Delete side effects: migration 0061 stores the prior roster status / created-row flag; deletes undo only their own change.
- [x] U7 D25 (L) Venue-local dates: `app/clock.py` + `COURTOPS_VENUE_TZ`; every `date.today()` / `CURRENT_DATE` decision parameterized.
- [x] U8 D26 (L) Deploy hygiene: migration advisory lock, image + GGUF pins, Caddy HSTS; ENV=prod tradeoff recorded.
- [x] U9 D30 (L) Delete the dead `require_export_pii` dependency and its coverage tests.
- [x] U10 D31 (L) Two-session password-change test.
- [x] U11 D32 (L) Monkeypatched dummy-hash assertion replaces the timing test.
- [x] U12 D33 (L) Email query ceiling scoped to a fresh tournament.
- [x] U13 D35 (L) Config reload without divergent settings; skip-masking setup removed; source-text and conditional-assertion patterns replaced.
- [x] U14 Register, policy, and trail update; full verification run.

Deferred in this pass, with the reason recorded in the register

- D28: a CI LLM sidecar or recorded corpus needs a multi-GB artifact and a CI budget decision; the suites still skip loudly.
- D34: an ongoing per-module test program, not a defect; the browser smoke covers the untested modules today.
- D13, D14, D18: already deferred with explicit triggers (multi-worker, multi-instance, cross-site client).

skip: fan-out via the Agent tool — the units are small, touch shared files, and depend on one verified baseline; serial is cheaper than merging parallel edits.
