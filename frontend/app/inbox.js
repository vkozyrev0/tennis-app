// Review inbox panel (D11) — classify, detect, bulk ops, detail drawer.
import { enhanceSelect } from "./combobox.js";
import {
  bulkBarHidden,
  selectHintHidden,
  selectionCountLabel,
  pruneSelection,
  inboxShortcutGate,
  inboxAxesLegend,
  emailCreateGuard,
  EMAIL_MSG_ID,
  reviewFormState,
  reviewDetectedPlayers,
  inboxRowClickOpensReview,
  fileWithoutPlayerGate,
  inboxConfidence,
  inboxConfidenceText,
  mergeInboxReviewRow,
  inboxSourceLabel,
  mergePlayerDropdownOptions,
  parseInboxOptionValue,
  inboxOptionValue,
  inboxAddPlayerVisible,
  inboxKnownUsta,
  INBOX_ADD_TO_PLAYERS,
  formatEmailBody,
} from "./inbox_ui.js";
import { sessionIsGone } from "./shell.js";

export function createInboxPanel(ctx) {
  const {
    api, setMsg, toast, confirmDialog, markInvalid, formObj, onSubmit,
    html, hstr, raw, esc, money, fmtDOW, chip, fillSelect, playerLabel,
    officialLabel, makeReadGrid, makeListGrid, makeMenuButton, scheduleComboSync,
    openForm, getActive, setActive, getPlayersById, getPlayersByUsta, getTournamentsById,
    rosterPrefillFromEmail, rosterPrefillFromName, resolveFilePlayerId,
    gotoImport, SHIRT_LABELS,
    // loadInbox uses a raw fetch for X-Total-Count; needs the same progress bar
    // + 422 humanizer that shell.api provides (D11 wiring — was app.js globals).
    progress, humanizeDetail,
    // Roster form prefill lives in createRosterPanel (owns form + modal state).
    rosterAddFromEmail, rosterAddBothFromEmail, playersCrudRefresh,
    sizeLists, runMailJob,
  } = ctx;
  const _runMailJob = typeof runMailJob === "function"
    ? runMailJob
    : async (_title, _opts, fn) => {
        const result = await fn({
          signal: undefined, update() {}, snapshot: () => ({ cancelled: false }),
        });
        return { ok: true, cancelled: false, result };
      };
  const _progress = typeof progress === "function" ? progress : () => {};
  const _humanizeDetail = typeof humanizeDetail === "function"
    ? humanizeDetail
    : (detail, fallback) => (typeof detail === "string" ? detail : (fallback || "error"));
  const _rosterAddFromEmail = typeof rosterAddFromEmail === "function"
    ? rosterAddFromEmail
    : () => { toast("Roster panel not ready", false); };
  const _rosterAddBothFromEmail = typeof rosterAddBothFromEmail === "function"
    ? rosterAddBothFromEmail
    : (m, p0) => _rosterAddFromEmail(m, p0);
  void money; void officialLabel; void makeListGrid; void makeMenuButton;
  void openForm; void getTournamentsById; void gotoImport; void SHIRT_LABELS;
  void markInvalid; void formObj; void onSubmit; void fillSelect;
  void resolveFilePlayerId;

  // --- Part B: review inbox + late entries ---
  const EMAIL_CLASSES = ["unclassified", "late_entry", "withdrawal", "doubles",
    "pairing_avoidance", "scheduling_avoidance", "division_flex", "hotel", "other"];
  // design-crit I-7: title-case labels + badge color per classification so the
  // Inbox column reads as colored chips (matching the Status column) instead of
  // raw lowercase enum text. `color` keys map to the .badge-* CSS variants.
  const EMAIL_CLASS_META = {
    unclassified:         { label: "Unclassified",  color: "muted" },
    late_entry:           { label: "Late entry",     color: "info" },
    withdrawal:           { label: "Withdrawal",     color: "bad" },
    doubles:              { label: "Doubles",        color: "info" },
    pairing_avoidance:    { label: "Pairing avoid.", color: "warn" },
    scheduling_avoidance: { label: "Scheduling",     color: "warn" },
    division_flex:        { label: "Division flex",  color: "info" },
    hotel:                { label: "Hotel",          color: "ok" },
    other:                { label: "Other",          color: "muted" },
  };
  // Object map {value: label} for Tabulator list editor + header-filter so those
  // dropdowns also show the friendly labels.
  const EMAIL_CLASS_VALUES = Object.fromEntries(
    EMAIL_CLASSES.map((v) => [v, (EMAIL_CLASS_META[v] || {}).label || v]));
  function classChip(v) {
    const meta = EMAIL_CLASS_META[v];
    if (!meta) return v ? hstr`<span class="badge badge-muted">${v}</span>` : "";
    return hstr`<span class="badge badge-${meta.color}">${meta.label}</span>`;
  }
  // Confidence hint for an auto-detected player: a small dot after the name whose
  // color + tooltip explain HOW the player was matched, so the TD trusts a USTA #
  // hit more than a bare-surname guess (and can spot ones worth double-checking).
  const MATCH_KIND_META = {
    usta:              { dot: "●", cls: "ok",   label: "Matched by USTA # in the email — high confidence" },
    withdraw_template: { dot: "●", cls: "ok",   label: "Matched by USTA withdrawal template — high confidence" },
    usta_subject:      { dot: "●", cls: "ok",   label: "Matched by USTA subject (first name + division) — high confidence" },
    fullname_subject:  { dot: "●", cls: "ok",   label: "Full name in the subject — high confidence" },
    fullname_body:     { dot: "◐", cls: "warn", label: "Full name in the body — medium confidence" },
    fuzzy_name:        { dot: "◐", cls: "warn", label: "Name matched after normalizing (inversion / middle name / accent) — medium confidence" },
    lastname_subject:  { dot: "○", cls: "warn", label: "Surname only (subject) — please verify" },
    lastname:          { dot: "○", cls: "warn", label: "Surname only — please verify" },
    firstname:         { dot: "○", cls: "warn", label: "First name only (unique on the roster) — please verify" },
    usta_offroster:    { dot: "◑", cls: "warn", label: "Matched by USTA # — but this player is NOT on this tournament's roster; add them" },
    manual:            { dot: "✎", cls: "info", label: "Set manually" },
  };
  function _inboxConfidence(m) {
    const k = inboxConfidence(m);
    if (!k) return null;
    if (m.detected_player_id != null && MATCH_KIND_META[m.detected_match_kind]) {
      return { ...k, title: MATCH_KIND_META[m.detected_match_kind].label };
    }
    return k;
  }
  function matchHint(kind) {
    const m = MATCH_KIND_META[kind];
    if (!m) return "";
    return hstr` <span class="match-hint match-${m.cls}" title="${m.label}" aria-label="${m.label}">${m.dot}</span>`;
  }
  const lateForm = document.getElementById("late-form");
  const wdForm = document.getElementById("withdrawal-form");
  // Audit A49: FILE_TARGETS is keyed by *classification* (so the Inbox knows
  // where to file an email) while FORM_MODALS is keyed by *form id* (so the
  // generic modal wrapping logic knows which forms to overlay). They overlap
  // on form elements but the lookup keys differ — kept separate intentionally;
  // any TD-visible label drift between them should be flagged in code review.
  const FILE_TARGETS = {
    late_entry: { label: "Late entry", tab: "panel-t-late", form: lateForm, msg: "late-msg" },
    withdrawal: { label: "Withdrawal", tab: "panel-t-withdrawals", form: wdForm, msg: "withdrawal-msg" },
    scheduling_avoidance: { label: "Scheduling avoid.", tab: "panel-t-sched", form: document.getElementById("sched-form"), msg: "sched-msg" },
    division_flex: { label: "Division flex", tab: "panel-t-divflex", form: document.getElementById("divflex-form"), msg: "divflex-msg" },
    hotel: { label: "Player hotel", tab: "panel-t-photels", form: document.getElementById("photel-form"), msg: "photel-msg" },
    pairing_avoidance: { label: "Pairing avoid.", tab: "panel-t-pairing", form: document.getElementById("pairing-form"), msg: "pairing-msg" },
    doubles: { label: "Doubles", tab: "panel-t-doubles", form: document.getElementById("doubles-form"), msg: "doubles-msg" },
  };
  // FILE_TARGETS holds the *DOM wiring* (tab/form/msg), which can only live in the
  // frontend. The set of classification keys + their labels + which are
  // bulk-populatable is owned by the backend registry (app/email_targets.py),
  // exposed at GET /api/emails/targets. verifyEmailTargets() reconciles the two at
  // boot so the keys/labels can't silently drift (the bug class that left bulk
  // "scheduling" filing into nothing): the server label becomes authoritative and
  // any key the server knows but the UI can't file — or vice versa — is logged
  // loudly. The literal above is the fallback when the fetch hasn't run / fails,
  // so single-file filing keeps working regardless.
  async function verifyEmailTargets() {
    let targets;
    try { targets = await api("/emails/targets"); }
    catch (e) { console.warn("[email-targets] could not load registry:", e.message); return; }
    const serverKeys = new Set(targets.map((t) => t.key));
    for (const t of targets) {
      const dom = FILE_TARGETS[t.key];
      if (!dom) { console.warn(`[email-targets] DRIFT: server target '${t.key}' has no FILE_TARGETS DOM wiring — emails of this class can't be filed in the UI.`); continue; }
      dom.label = t.label;                                   // server is authoritative for the label
      if (EMAIL_CLASS_META[t.key]) EMAIL_CLASS_META[t.key].label = t.label;
      dom.bulk = t.bulk;                                     // expose bulk-ness to the UI if needed
    }
    for (const key of Object.keys(FILE_TARGETS)) {
      if (!serverKeys.has(key)) console.warn(`[email-targets] DRIFT: FILE_TARGETS offers '${key}' but the backend registry doesn't know it — bulk populate will skip these.`);
    }
  }

  // Inbox grid. Classification is an inline list-editor (double-click); the per-row
  // File-target picker + File / Suggest / Delete buttons live in the actions column.
  async function _inboxPut(m, patch = {}) {
    // Full-body PUT: the endpoint overwrites detected_player_id/partner with
    // whatever we send, so every call carries the row's current links and the
    // caller overrides just the field it changed — omitting one would silently
    // unlink that player.
    await api(`/emails/${m.id}`, { method: "PUT", body: JSON.stringify({
      // Preserve the email's OWN tournament — the inbox is cross-tournament, so
      // forcing getActive().id here silently re-homed an email belonging to another
      // tournament whenever its classification was changed/suggested. Only fall
      // back to the active workspace for an as-yet-unassigned email.
      tournament_id: m.tournament_id ?? (getActive() && getActive().id) ?? null,
      classification: m.classification, status: m.status,
      detected_player_id: m.detected_player_id ?? null,
      detected_partner_id: m.detected_partner_id ?? null,
      ...patch,
    }) });
  }
  async function _inboxPutClass(m, classification) { await _inboxPut(m, { classification }); }

  // What the two "Player N" column groups display for a row, resolved in priority
  // order per slot: roster-matched player (auto-detected OR manually assigned) →
  // (name, USTA#) parsed straight from the email text (✉, not rostered yet) →
  // a bare email-text USTA #. Pairing-avoidance groups put the primary in slot 0
  // and the rest of the group in slot 1.
  function _inboxSlots(m) {
    const slots = [{}, {}];
    const pairs = m.detected_name_pairs || [];
    const matched = [m.detected_usta, m.detected_partner_usta].filter(Boolean);
    const text = (m.detected_usta_text || "").split(",").map((s) => s.trim())
      .filter((n) => n && !matched.includes(n));
    if (m.detected_player_name) {
      slots[0] = { id: m.detected_player_id, name: m.detected_player_name,
                   usta: m.detected_usta, matched: true, kind: m.detected_match_kind };
    } else if (pairs[0]) slots[0] = { name: pairs[0].name, usta: pairs[0].usta || text[0] };
    else if (text[0]) slots[0] = { usta: text[0] };
    if (m.detected_partner_name) {
      slots[1] = { id: m.detected_partner_id, name: m.detected_partner_name,
                   usta: m.detected_partner_usta, matched: true };
    } else if ((m.detected_member_names || []).length > 1) {
      slots[1] = { ids: (m.detected_member_ids || []).slice(1),
                   names: m.detected_member_names.slice(1), matched: true, group: true };
    } else if (pairs[1]) {
      slots[1] = { name: pairs[1].name,
                   usta: pairs[1].usta || (text[1] !== slots[0].usta ? text[1] : undefined) };
    } else if (text[1] && text[1] !== slots[0].usta) slots[1] = { usta: text[1] };
    for (const s of slots) {
      if (!s || s.usta || !s.name) continue;
      const p = _inboxPeople.find((row) =>
        String(row.name || "").trim().toLowerCase() === String(s.name).trim().toLowerCase());
      if (p && p.usta_number) s.usta = String(p.usta_number);
    }
    return slots;
  }
  const _MAIL_MARK = ' <span class="muted" title="parsed from the email; not matched to the roster yet">✉</span>';
  const _p360 = (pid, name) => pid
    ? hstr`<span class="p360-link" data-pid="${pid}" role="button" tabindex="0" title="View everything about this player (360)">${name}</span>`
    : hstr`${name}`;
  // Roster dropdown for the manual player/partner pickers (typeahead list).
  // Memoized: the sorted list is identical between roster reloads, but the editor
  // opens (and rebuilt it) on every cell-edit; invalidated by _invalidatePickCache
  // when getPlayersById() is rebuilt.
  let _pickCache = null;
  let _inboxPeople = [];
  const _invalidatePickCache = () => { _pickCache = null; };
  async function _loadInboxPeople() {
    try { _inboxPeople = await api("/inbox-people") || []; }
    catch (_) { _inboxPeople = []; }
    _invalidatePickCache();
  }
  function _inboxPersonForSlot(slot) {
    if (!slot) return null;
    const inboxId = parseInboxOptionValue(slot.id);
    if (inboxId != null) {
      return _inboxPeople.find((p) => Number(p.id) === inboxId) || null;
    }
    const usta = String(slot.usta || "").replace(/\D/g, "");
    const name = String(slot.name || "").trim().toLowerCase();
    if (usta) {
      const byUsta = _inboxPeople.find((p) =>
        String(p.usta_number || "").replace(/\D/g, "") === usta);
      if (byUsta) return byUsta;
    }
    if (name) {
      return _inboxPeople.find((p) =>
        String(p.name || "").trim().toLowerCase() === name) || null;
    }
    return null;
  }
  const _playerPickValues = () => (_pickCache ||= mergePlayerDropdownOptions(
    Object.values(getPlayersById()), _inboxPeople,
  ).map((o) => ({ label: o.label, value: o.value })));
  const _PLAYER_EDITOR = {
    editor: "list", editorAutocomplete: true, cssClass: "editable-cell",
    editorParams: () => ({ values: _playerPickValues(), autocomplete: true,
      clearable: true, listOnEmpty: true, placeholderEmpty: "no roster match" }),
  };
  const _USTA_EDITOR = { editor: "input", cssClass: "editable-cell" };
  // Small inline affordance button for the player cells (✎ edit / × clear / ＋ add).
  // stopPropagation so the click does its own thing instead of opening the cell
  // editor (the grid edits on a single click — see `editable: "click"` below).
  function _iconBtn(glyph, title, onClick, extraClass) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn-icon inbox-affordance" + (extraClass ? " " + extraClass : "");
    b.textContent = glyph; b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(ev); });
    return b;
  }
  // Unassign a slot. Clearing Player 1 clears Player 2 too (the partner is tied to
  // a primary — the server enforces the same).
  async function _inboxClearSlot(m, slot) {
    try {
      await _inboxPut(m, slot === 0
        ? { detected_player_id: null, detected_partner_id: null }
        : { detected_partner_id: null });
      await loadInbox();
    } catch (e) { toast(e.message, false); }
  }
  // Open the roster form pre-filled from this email (USTA #, name, division) —
  // the same plan the ⋯ menu uses, surfaced directly on a parsed-but-unrostered
  // (✉) player cell. Prefill plan is pure (roster_prefill.js); form open lives
  // in createRosterPanel so D11 free-vars stay out of this module.
  function _inboxAddToRoster(m, plan) {
    plan = plan || rosterPrefillFromEmail(m);
    _rosterAddFromEmail(m, plan);
  }
  // "Add both" for a name-only doubles pair: first player now, second after SAVE.
  function _inboxAddBothToRoster(m, plan0, plan1) {
    _rosterAddBothFromEmail(m, plan0, plan1);
  }
  async function _promoteInboxPerson(person, extras = {}) {
    const gender = extras.gender || person.gender;
    const usta_number = extras.usta_number || person.usta_number;
    const res = await api(`/inbox-people/${person.id}/promote`, {
      method: "POST",
      body: JSON.stringify({
        ...(gender ? { gender } : {}),
        ...(usta_number ? { usta_number } : {}),
      }),
    });
    if (typeof playersCrudRefresh === "function") await playersCrudRefresh();
    await _loadInboxPeople();
    return res;
  }
  function _appendPromoteControls(wrap, person, onPromoted, slot, opts = {}) {
    if (!person || !inboxAddPlayerVisible({
      catalogPlayerId: "",
      inboxPerson: person,
      catalogByUsta: getPlayersByUsta(),
    })) return;
    const spec = INBOX_ADD_TO_PLAYERS;
    const knownUsta = inboxKnownUsta(person, slot);
    const stopGridEdit = (el) => {
      for (const type of ["mousedown", "pointerdown", "click", "dblclick"]) {
        el.addEventListener(type, (e) => e.stopPropagation());
      }
    };
    let genderSel = null;
    if (!person.gender) {
      genderSel = document.createElement("select");
      genderSel.className = "inbox-promote-gender";
      genderSel.setAttribute("aria-label", "Gender for new player");
      genderSel.setAttribute("data-lpignore", "true");
      genderSel.innerHTML = "<option value=\"\">gender</option>"
        + "<option value=\"male\">male</option>"
        + "<option value=\"female\">female</option>";
      stopGridEdit(genderSel);
      wrap.appendChild(genderSel);
    }
    let ustaInp = null;
    if (!knownUsta && opts.ustaInput !== false) {
      ustaInp = document.createElement("input");
      ustaInp.type = "text";
      ustaInp.inputMode = "numeric";
      ustaInp.placeholder = "USTA #";
      ustaInp.className = "inbox-promote-usta";
      ustaInp.setAttribute("aria-label", "USTA number for new player");
      stopGridEdit(ustaInp);
      wrap.appendChild(ustaInp);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-link " + spec.className;
    btn.textContent = spec.label;
    btn.title = spec.title;
    stopGridEdit(btn);
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const gender = person.gender || (genderSel && genderSel.value) || "";
      const usta = knownUsta || (ustaInp && ustaInp.value.trim()) || "";
      if (!usta) { toast("USTA number is required to add this person to Players", false); return; }
      if (!gender) { toast("Pick male or female — gender is required", false); return; }
      try {
        const res = await _promoteInboxPerson(person, { gender, usta_number: usta });
        toast(`Added ${person.name || "player"} to Players`, true);
        if (onPromoted) await onPromoted(res);
      } catch (e) { toast(e.message, false); }
    });
    wrap.appendChild(btn);
  }
  // Run player detection for one email and fold the result back into the row.
  async function _inboxDetectInto(m, row) {
    try {
      const det = await api(`/emails/${m.id}/detect-player`, { method: "POST" });
      row.update({
        detected_player_id: det.detected_player_id, detected_usta: det.detected_usta,
        detected_player_name: det.detected_player_name, detected_match_kind: det.match_kind,
        detected_partner_id: det.detected_partner_id, detected_partner_name: det.detected_partner_name,
        detected_member_ids: det.detected_member_ids, detected_member_names: det.detected_member_names,
      });
      row.reformat();
      const who = (det.detected_member_names && det.detected_member_names.length > 1)
        ? det.detected_member_names.join(" + ")
        : det.detected_player_name
          ? det.detected_player_name + (det.detected_partner_name ? ` + ${det.detected_partner_name}` : "")
          : null;
      toast(who ? `Detected: ${who}` : "No player match", !!who);
    } catch (e) { toast(e.message, false); }
  }
  // Builds a "Player N" cell: matched roster player (360 link + ✎ change + × clear),
  // a parsed-but-unrostered name (✉ + ✎ pick + ＋ add to roster), a pairing-group
  // list, or an empty cell (Detect + ✎ pick for slot 0; ✎ for slot 1).
  function _inboxNameCell(cell, slotIdx) {
    const m = cell.getData(); const row = cell.getRow();
    const all = _inboxSlots(m);  // computed once; reused for the "add both" peek below
    const s = all[slotIdx];
    const wrap = document.createElement("span");
    wrap.className = "inbox-name-cell";
    const editBtn = (title) => _iconBtn("✎", title || "Change — pick a roster player", () => cell.edit(true));

    if (s.group) {           // pairing-avoidance: the rest of the group (slot 1)
      wrap.innerHTML = s.names.map((n, i) => _p360(s.ids[i], n)).join(" + ");
      return wrap;
    }
    if (s.matched) {
      const nameSpan = document.createElement("span");
      nameSpan.innerHTML = _p360(s.id, s.name) + (slotIdx === 0 ? matchHint(s.kind) : "");
      wrap.append(nameSpan, editBtn(),
        _iconBtn("×", "Remove this player", () => _inboxClearSlot(m, slotIdx), "danger"));
      return wrap;
    }
    if (s.name) {            // parsed from the email text, not on the roster yet
      const nameSpan = document.createElement("span");
      nameSpan.innerHTML = hstr`${s.name}${raw(_MAIL_MARK)}`;
      wrap.append(nameSpan, editBtn());
      _appendPromoteControls(wrap, _inboxPersonForSlot(s), async (res) => {
        const pid = res && (res.player_id || res.promoted_player_id);
        if (pid == null) { await loadInbox(); return; }
        try {
          if (slotIdx === 0) await _inboxPut(m, { detected_player_id: pid });
          else {
            if (!m.detected_player_id) { await loadInbox(); return; }
            await _inboxPut(m, { detected_partner_id: pid });
          }
        } catch (e) { toast(e.message, false); }
        await loadInbox();
      }, s, { ustaInput: false });
      // Pre-fill the roster add-form from THIS cell's name (+ USTA # if present).
      const plan = rosterPrefillFromName(s.name, s.usta, m.detected_division);
      // When BOTH players of a name-only pair are unrostered, collapse the two
      // per-cell ＋ into a single "Add both" on the primary cell (it opens each
      // player's form in turn); otherwise just this cell's ＋.
      const other = all[slotIdx === 0 ? 1 : 0];
      const otherPlan = other && other.name && !other.matched
        ? rosterPrefillFromName(other.name, other.usta, m.detected_division) : { canAdd: false };
      if (plan.canAdd && otherPlan.canAdd) {
        if (slotIdx === 0) {
          wrap.append(_iconBtn("＋ both", "Add BOTH players to the roster (pre-filled; confirm each in turn)",
            () => _inboxAddBothToRoster(m, plan, otherPlan), "addboth"));
        }   // slot 1: covered by the "＋both" on the primary cell — no button here
      } else if (plan.canAdd) {
        wrap.append(_iconBtn("＋", "Add this player to the roster (pre-filled from the email)",
          () => _inboxAddToRoster(m, plan)));
      }
      return wrap;
    }
    if (slotIdx === 0) {     // empty primary — offer Detect + pick
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn-link inline-detect"; btn.textContent = "Detect";
      btn.title = "Detect the player this email is about";
      btn.addEventListener("click", (ev) => { ev.stopPropagation(); _inboxDetectInto(m, row); });
      wrap.append(btn, editBtn("Pick a roster player"));
      return wrap;
    }
    // empty partner slot
    const dash = document.createElement("span"); dash.className = "muted"; dash.textContent = "—";
    wrap.append(dash, editBtn("Add a second player"));
    return wrap;
  }
  const inboxGrid = makeReadGrid("inbox-table", [
    // Mass-select column: master checkbox in header + per-row toggle. Drives
    // the bulk-action toolbar shown above the grid.
    { title: "", field: "_sel", headerSort: false, width: 36, minWidth: 36, widthGrow: 0, hozAlign: "center",
      titleFormatter: () => {
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.name = "inbox-select-all";
        cb.setAttribute("autocomplete", "off");
        cb.setAttribute("aria-label", "Select all visible");
        cb.addEventListener("change", (e) => _inboxBulkToggleAll(e.target.checked));
        return cb;
      },
      formatter: (cell) => {
        const m = cell.getData();
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.name = "inbox-row"; cb.value = String(m.id);
        cb.setAttribute("autocomplete", "off");
        cb.checked = _inboxSelected.has(m.id);
        cb.setAttribute("aria-label", `Select email ${m.subject || m.id}`);
        cb.addEventListener("click", (ev) => ev.stopPropagation());
        cb.addEventListener("change", (e) => _inboxBulkToggle(m.id, e.target.checked));
        return cb;
      } },
    { title: "Received", field: "received_at", width: 84, minWidth: 78, widthGrow: 0, formatter: (c) => hstr`${(c.getData().received_at || "").slice(0, 10)}` },
    { title: "From", field: "from_address", minWidth: 96, widthGrow: 1 },
    { title: "Source", field: "ingest_source", width: 72, minWidth: 64, widthGrow: 0, responsive: 2,
      formatter: (c) => {
        const label = inboxSourceLabel(c.getData().ingest_source);
        return hstr`<span class="badge" title="How this email arrived">${label}</span>`;
      },
      headerFilter: "list",
      headerFilterParams: { values: ["", "gmail", "outlook", "pdf", "manual", "webhook"], clearable: true } },
    // Review sits here (early, after From) so the TD can open the message
    // without scrolling past Player / Classification. Row click does the same.
    { title: "Review", field: "_review", headerSort: false, width: 64, minWidth: 56, widthGrow: 0,
      formatter: (cell) => {
        const m = cell.getData();
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "btn-link";
        btn.textContent = "Review";
        btn.title = "Open the full email in a modal";
        btn.setAttribute("aria-label", "Review email");
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          _openInboxDetail(_reviewEmail(m, cell));
        });
        return btn;
      } },
    { title: "Subject", field: "subject", minWidth: 110, widthGrow: 2, formatter: (c) => {
        const m = c.getData();
        const corr = m.amends_email_id ? ' <span class="badge badge-info" title="corrects an earlier email">↻ correction</span>' : "";
        const sup = m.superseded ? ' <span class="badge badge-warn" title="a later email corrects this — revisit its filed row">⤺ superseded</span>' : "";
        return hstr`${m.subject || ""}${raw(corr)}${raw(sup)}`;
      } },
    // Leaf columns (not groups) so Player 1 / Player 2 stay one 20px header
    // row instead of a group row + "Player" child row.
    { title: "Player 1", field: "detected_player_name", minWidth: 120, width: 140, widthGrow: 1, ..._PLAYER_EDITOR,
      formatter: (cell) => _inboxNameCell(cell, 0),
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) =>
        ((e.detected_player_name || "") + " " + (e.detected_usta || ""))
          .toLowerCase().includes(String(term).toLowerCase()) },
    { title: "USTA #1", field: "detected_usta", width: 88, minWidth: 72, widthGrow: 0, responsive: 1, ..._USTA_EDITOR,
      formatter: (c) => {
        const s = _inboxSlots(c.getData())[0];
        if (!s.usta) return '<span class="muted">—</span>';
        return hstr`${s.usta}${s.matched ? "" : raw(_MAIL_MARK)}`;
      },
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) =>
        ((e.detected_usta || "") + " " + (e.detected_usta_text || ""))
          .includes(String(term).trim()) },
    { title: "Player 2", field: "detected_partner_name", minWidth: 120, width: 140, widthGrow: 1, ..._PLAYER_EDITOR,
      formatter: (cell) => _inboxNameCell(cell, 1),
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) =>
        ((e.detected_partner_name || "") + " " + ((e.detected_member_names || []).slice(1).join(" ")) + " " +
         (e.detected_partner_usta || "")).toLowerCase().includes(String(term).toLowerCase()) },
    { title: "USTA #2", field: "detected_partner_usta", width: 88, minWidth: 72, widthGrow: 0, responsive: 1, ..._USTA_EDITOR,
      formatter: (c) => {
        const s = _inboxSlots(c.getData())[1];
        if (!s.usta) return '<span class="muted">—</span>';
        return hstr`${s.usta}${s.matched ? "" : raw(_MAIL_MARK)}`;
      },
      headerFilter: "input",
      headerFilterFunc: (term, _v, e) => (e.detected_partner_usta || "").includes(String(term).trim()) },
    { title: "Classification", field: "classification", width: 110, minWidth: 88, widthGrow: 0, cssClass: "editable-cell",
      formatter: (c) => classChip(c.getValue()),
      editor: "list", editorParams: { values: EMAIL_CLASS_VALUES },
      headerFilter: "list", headerFilterParams: { values: EMAIL_CLASS_VALUES, clearable: true } },
    // How confident the auto-detection of the player is (see inboxConfidence).
    { title: "Confidence", field: "_conf", width: 108, minWidth: 96, widthGrow: 0, headerSort: false, hozAlign: "center",
      formatter: (c) => {
        const m = c.getData();
        const k = _inboxConfidence(m);
        const ms = m.classified_ms;
        const msHint = (ms != null && ms !== "") ? ` · classified in ${ms} ms` : "";
        const badge = k
          ? hstr`<span class="badge badge-${k.cls}" title="${k.title}${msHint}">${inboxConfidenceText(k)}</span>`
          : '<span class="muted" title="No player identified yet">—</span>';
        return hstr`${raw(badge)}`;
      } },
    { title: "Status", field: "status", width: 80, minWidth: 64, widthGrow: 0, formatter: (c) => chip(c.getData().status),
      headerFilter: "list", headerFilterParams: { values: ["", "new", "filed", "needs_followup"], clearable: true } },
    { title: "", field: "_act", headerSort: false, widthGrow: 0, width: 40, minWidth: 36, cssClass: "grid-actions-cell",
      formatter: (cell) => {
        // Suggest / File / Delete fold into a ⋯ overflow menu (design-crit I-2).
        // Review lives in its own early column. The menu is body-anchored so it
        // isn't clipped by the grid cell.
        const m = cell.getData(); const row = cell.getRow();
        const fileable = !!FILE_TARGETS[m.classification];
        const wrap = document.createElement("div"); wrap.className = "grid-actions";

        const doSuggest = async () => {
          try {
            // 1) classification suggestion (preserves any existing player link)
            const res = await api(`/emails/${m.id}/suggest`, { method: "POST" });
            await _inboxPutClass(m, res.classification);
            m.classification = res.classification;
            // 2) player detection — resolve who the email is about and persist it
            const det = await api(`/emails/${m.id}/detect-player`, { method: "POST" });
            const pairs = det.detected_name_pairs || res.detected_name_pairs || m.detected_name_pairs || [];
            row.update({
              classification: res.classification,
              detected_player_id: det.detected_player_id,
              detected_usta: det.detected_usta,
              detected_player_name: det.detected_player_name,
              detected_match_kind: det.match_kind,
              detected_partner_id: det.detected_partner_id,
              detected_partner_name: det.detected_partner_name,
              detected_member_ids: det.detected_member_ids,
              detected_member_names: det.detected_member_names,
              detected_name_pairs: pairs,
            });
            row.reformat();
            const clsLabel = (EMAIL_CLASS_META[res.classification] || {}).label || res.classification;
            const pairHint = pairs.map((p) => p && p.name).filter(Boolean);
            const who = (det.detected_member_names && det.detected_member_names.length > 1)
              ? ` · players: ${det.detected_member_names.join(" + ")}`
              : det.detected_player_name
                ? ` · player: ${det.detected_player_name}` +
                  (det.detected_partner_name ? ` + ${det.detected_partner_name}` : "")
                : pairHint.length
                  ? ` · from email: ${pairHint.join(" + ")}`
                  : " · no player match";
            toast(`Suggested: ${clsLabel}${who}`, true);
          } catch (e) { toast(e.message, false); }
        };
        const doFile = async () => {
          const t = FILE_TARGETS[m.classification]; if (!t) return;
          const gate = fileWithoutPlayerGate(m.classification, m.detected_player_id);
          if (!gate.ok) {
            await confirmDialog(gate.reason, "OK", "primary");
            return;
          }
          // File into the email's OWN tournament, not whatever is active. The inbox
          // is cross-tournament and every filing form POSTs to
          // /tournaments/<active>/… , so re-scope the workspace to the email's
          // tournament first (setActive toasts the switch). An unassigned email
          // (no tournament_id) falls through and files under the active workspace.
          if (m.tournament_id && (!getActive() || m.tournament_id !== getActive().id)) {
            setActive(String(m.tournament_id));
          }
          // Switch tab FIRST — the tab handler refreshes some player selects, which
          // would otherwise wipe a preset value (same ordering as the roster→withdraw
          // flow above). Set the form fields after, then open the modal so
          // scheduleComboSync() shows the chosen name in the type-in combobox.
          document.querySelector(`.tab[data-target="${t.tab}"]`).click();
          t.form.source_email_id.value = m.id;
          // Carry the auto-detected player into the form's required picker so the
          // TD doesn't re-select someone the inbox already identified (mirrors the
          // bulk-populate path, which files on detected_player_id directly). Stays
          // editable before saving; forms without a single player_ref (e.g.
          // pairing's member rows) are skipped by the guard.
          // Resolve the player to pre-select: the linked player, or — when none was
          // linked but the email carries a USTA # — the player with that USTA #
          // (precise even when surnames collide). The picker lists all players, so
          // an off-roster match still displays.
          const _fillPid = resolveFilePlayerId(m, Object.values(getPlayersById()));
          if (t.form.player_ref && _fillPid) {
            t.form.player_ref.value = String(_fillPid);
            // Sync the combobox display SYNCHRONOUSLY (not the rAF-debounced
            // scheduleComboSync): this same menu click bubbles to the document
            // click handler that closes open comboboxes, and close() resets the
            // select to blank when the combo's text input is still empty. Filling
            // the display now means the input is non-empty by the time that fires.
            if (typeof t.form.player_ref._comboSync === "function") t.form.player_ref._comboSync();
          }
          // Doubles names TWO players — carry the detected partner into the
          // partner picker the same way (still editable before saving).
          if (m.classification === "doubles" && t.form.partner_ref && m.detected_partner_id
              && getPlayersById()[m.detected_partner_id]) {
            t.form.partner_ref.value = String(m.detected_partner_id);
            if (typeof t.form.partner_ref._comboSync === "function") t.form.partner_ref._comboSync();
          }
          // Pairing-avoidance names a GROUP — build one member row per detected
          // player (still editable; the TD can add/remove rows before saving).
          if (m.classification === "pairing_avoidance"
              && (m.detected_member_ids || []).length >= 2 && t.form.id === "pairing-form") {
            pairingMembersBox.innerHTML = "";
            for (const pid of m.detected_member_ids) {
              pairingMemberRow();
              const sel = pairingMembersBox.lastElementChild.querySelector(".pm-player");
              if (sel && getPlayersById()[pid]) {
                sel.value = String(pid);
                if (typeof sel._comboSync === "function") sel._comboSync();
              }
            }
            while (pairingMembersBox.children.length < 2) pairingMemberRow();
          }
          // Carry the auto-detected withdrawal reason into the form so the TD
          // doesn't retype it (still editable before saving).
          if (m.classification === "withdrawal" && t.form.reason && m.detected_reason) {
            t.form.reason.value = m.detected_reason;
          }
          // Carry the locally-parsed age division + events into the form's
          // catalog pickers (late entry has both; withdrawal has events). Only
          // select option values that actually exist for this tournament's
          // catalog; unknown/unmatched values are left blank for the TD.
          const div = t.form.elements.age_division;
          if (div && m.detected_division &&
              [...div.options].some((o) => o.value === m.detected_division)) {
            div.value = m.detected_division;
            if (typeof div._comboSync === "function") div._comboSync();
          }
          const evSel = t.form.elements.events;
          if (evSel && evSel.multiple && m.detected_events) {
            const want = new Set(m.detected_events.split(",").map((s) => s.trim()));
            [...evSel.options].forEach((o) => { if (want.has(o.value)) o.selected = true; });
          }
          // Scheduling avoidance: carry the parsed day + time-range free-text.
          if (t.form.elements.avoid_day && m.detected_avoid_day) {
            t.form.elements.avoid_day.value = m.detected_avoid_day;
          }
          if (t.form.elements.avoid_time_range && m.detected_avoid_time) {
            t.form.elements.avoid_time_range.value = m.detected_avoid_time;
          }
          openForm(t.form);
          scheduleComboSync();
          setMsg(t.msg, `filing from email #${m.id}`, true);
          const focusEl = t.form.querySelector(".combo-input") || t.form.querySelector("input, select");
          if (focusEl) focusEl.focus();
        };
        const doDelete = async () => {
          if (!(await confirmDialog("Delete email?"))) return;
          try { await api(`/emails/${m.id}`, { method: "DELETE" }); loadInbox(); }
          catch (e) { toast(e.message, false); }
        };
        // Correction auto-rewrite: when this email amends an earlier one, update
        // that earlier email's filed row in place instead of filing a duplicate.
        const doApplyCorrection = async () => {
          try {
            const res = await api(`/emails/${m.id}/apply-correction`, { method: "POST" });
            toast(`Correction applied to the ${res.list} row`, true);
            loadInbox();
          } catch (e) { toast(e.message, false); }
        };
        // "Add to roster" — what to pre-fill is decided by the pure, unit-tested
        // rosterPrefillFromEmail(m) (see app/roster_prefill.js + its node test);
        // _inboxAddToRoster (module scope) APPLIES that plan and is also wired to
        // the ＋ affordance on a parsed-but-unrostered player cell.
        const _rosterPlan = rosterPrefillFromEmail(m);
        const offRoster = _rosterPlan.offRoster;
        const canAddToRoster = _rosterPlan.canAdd;
        // One-click "File pair": both doubles players matched (with USTA #s) →
        // record the confirmed pair directly, no manual partner-USTA entry.
        const canFilePair = m.classification === "doubles" && m.detected_player_id
          && m.detected_partner_id && m.detected_usta && m.detected_partner_usta;
        const doFilePair = async () => {
          try {
            if (m.tournament_id && (!getActive() || m.tournament_id !== getActive().id)) setActive(String(m.tournament_id));
            const r = await api(`/tournaments/${m.tournament_id || getActive().id}/doubles-pairs`, {
              method: "POST",
              body: JSON.stringify({ usta_number: m.detected_usta, partner_usta: m.detected_partner_usta,
                age_division: m.detected_division || null, source_email_id: m.id }),
            });
            toast(r.already_existed
              ? `${m.detected_player_name} + ${m.detected_partner_name} are already paired`
              : `Filed pair: ${m.detected_player_name} + ${m.detected_partner_name}`, true);
            loadInbox();
          } catch (e) { toast(e.message, false); }
        };
        // Per-row status parity with the bulk toolbar: lets the TD clear a single
        // info-only email (hotel note, ack) — or flag one for follow-up — straight
        // from its row, without bulk-selecting. Reuses /emails/bulk/status.
        const doSetStatus = (status, verb) => async () => {
          if (status === "filed") {
            const gate = fileWithoutPlayerGate(m.classification, m.detected_player_id);
            if (!gate.ok) {
              await confirmDialog(gate.reason, "OK", "primary");
              return;
            }
          }
          try {
            await api("/emails/bulk/status", { method: "POST", body: JSON.stringify({ email_ids: [m.id], status }) });
            toast(verb, true); loadInbox();
          } catch (e) { toast(e.message, false); }
        };
        const statusItems = [
          ...(m.status !== "filed" ? [{ label: "Mark filed (handled)",
            title: "Clear this email out of the unfiled queue without creating a list row", onClick: doSetStatus("filed", "Marked filed") }] : []),
          ...(m.status !== "needs_followup" ? [{ label: "Flag for follow-up",
            title: "Mark this email as needing follow-up", onClick: doSetStatus("needs_followup", "Flagged for follow-up") }] : []),
          ...(m.status !== "new" ? [{ label: "Reopen (back to unfiled)",
            title: "Return this email to the unfiled queue", onClick: doSetStatus("new", "Reopened") }] : []),
        ];
        const items = [
          { label: "Suggest classification + player", title: "Run the local classifier and player detector", onClick: doSuggest },
          ...(canFilePair ? [{ label: "File pair (both players)",
            title: "Record the confirmed doubles pair for both detected players", onClick: doFilePair }] : []),
          { label: fileable ? `File as ${FILE_TARGETS[m.classification].label}` : "File (set a classification first)",
            title: fileable ? "" : "Pick a fileable classification first", onClick: () => { if (fileable) doFile(); } },
          ...(canAddToRoster ? [{ label: offRoster ? "Add to roster (player exists)" : "Add player to roster",
            title: offRoster ? "Add this existing player to the tournament roster" : "Open the roster form pre-filled with this email's USTA # + division", onClick: () => _inboxAddToRoster(m) }] : []),
          ...(m.amends_email_id ? [{ label: "Apply correction → update filed row",
            title: "Re-point the amended email's filed row to this one and re-apply the parsed fields", onClick: doApplyCorrection }] : []),
          { separator: true },
          ...statusItems,
          { separator: true },
          { label: "Delete email", danger: true, onClick: doDelete },
        ];
        const menu = makeMenuButton("⋯", items, { className: "btn-icon row-more", title: "More actions", anchor: true, noCaret: true });
        wrap.append(menu); return wrap;
      } },
  ], "inbox",
  "Inbox empty — paste a forwarded email above, or use Import → PDF. "
  + "Once you have rows: tick checkboxes for bulk triage (Triage all), "
  + "or press t (triage) · d (detect) · f (filed) · u (unmatched). Press ? for all shortcuts.",
  { index: "id", editable: "click", persist: false, collapseAt: "(max-width: 1400px)" });
  // Persist inline edits (single click a cell): classification, manual player /
  // partner picks (the list editor's value is a player id), and typed USTA #s
  // (resolved against the roster cache; unknown numbers revert with a toast).
  // The 360 link, Detect, and the ✎/×/＋ affordances stopPropagation so they act
  // instead of opening the editor.
  inboxGrid.grid.on("cellEdited", async (cell) => {
    const f = cell.getField(); const m = cell.getData();
    if (cell.getValue() === cell.getOldValue()) return;
    const revert = () => { try { cell.restoreOldValue(); } catch (_) {} };
    try {
      if (f === "classification") {
        await _inboxPutClass(m, cell.getValue()); cell.getRow().reformat(); return;
      }
      if (f === "detected_player_name" || f === "detected_partner_name") {
        const v = cell.getValue();
        const inboxId = parseInboxOptionValue(v);
        if (inboxId != null) {
          const person = _inboxPeople.find((p) => Number(p.id) === inboxId);
          if (!person) { revert(); return; }
          if (!person.usta_number || !person.gender) {
            toast("Use Add to Players (USTA + gender) before assigning this inbox person", false);
            revert(); return;
          }
          try {
            const res = await _promoteInboxPerson(person);
            const pid = res.player_id || res.promoted_player_id;
            if (f === "detected_partner_name") {
              if (!m.detected_player_id) { toast("Pick Player 1 first", false); revert(); return; }
              await _inboxPut(m, { detected_partner_id: pid });
            } else {
              await _inboxPut(m, { detected_player_id: pid });
            }
            await loadInbox(); return;
          } catch (e) { toast(e.message, false); revert(); return; }
        }
        const pid = (v === "" || v == null) ? null : Number(v);
        if (pid != null && !getPlayersById()[pid]) { revert(); return; }
        if (f === "detected_partner_name") {
          // the backend ties the partner to a primary — there's no partner-only row
          if (pid != null && !m.detected_player_id) { toast("Pick Player 1 first", false); revert(); return; }
          await _inboxPut(m, { detected_partner_id: pid });
        } else {
          // clearing the primary clears the partner too (server does the same)
          await _inboxPut(m, { detected_player_id: pid, ...(pid == null ? { detected_partner_id: null } : {}) });
        }
        await loadInbox(); return;
      }
      if (f === "detected_usta" || f === "detected_partner_usta") {
        const typed = String(cell.getValue() || "").replace(/\D/g, "");
        if (!typed) { revert(); return; }
        const hit = Object.values(getPlayersById()).find((p) => String(p.usta_number || "") === typed);
        if (!hit) { toast(`No player with USTA # ${typed} — add them via Players first`, false); revert(); return; }
        if (f === "detected_partner_usta") {
          if (!m.detected_player_id) { toast("Pick Player 1 first", false); revert(); return; }
          await _inboxPut(m, { detected_partner_id: hit.id });
        } else {
          await _inboxPut(m, { detected_player_id: hit.id });
        }
        toast(`Assigned ${playerLabel(hit)}`, true);
        await loadInbox(); return;
      }
    } catch (e) { setMsg("email-msg", e.message, false); revert(); }
  });

  // Detail pane: clicking a row opens it below the grid. Lets the TD read the
  // full email body and override the classification or status.
  let _inboxDetailId = null;
  let _inboxDetailTid = null;  // the open email's own tournament_id (preserved on save)
  let _inboxDetailPartnerId = null;  // detected partner — preserved on save (the pane has no partner picker)
  function _populateInboxClassSelect() {
    const sel = document.getElementById("inbox-detail-classification");
    if (!sel || sel.options.length) return;
    for (const v of EMAIL_CLASSES) {
      const o = document.createElement("option"); o.value = v;
      o.textContent = (EMAIL_CLASS_META[v] || {}).label || v; sel.appendChild(o);
    }
  }
  function _reviewPlayerOptions() {
    return mergePlayerDropdownOptions(Object.values(getPlayersById()), _inboxPeople);
  }
  function _resolveReviewSlotId(slot) {
    const usta = slot && slot.usta;
    if (usta) {
      const byUsta = getPlayersByUsta();
      const hit = byUsta && (byUsta[usta] || byUsta[String(usta).replace(/\D/g, "")]);
      if (hit && hit.id != null) return String(hit.id);
    }
    if (slot && slot.id && parseInboxOptionValue(slot.id) == null && String(slot.id).trim() !== "") {
      return String(slot.id);
    }
    const person = _inboxPersonForSlot(slot);
    if (person) {
      if (person.promoted_player_id && getPlayersById()[person.promoted_player_id]) {
        return String(person.promoted_player_id);
      }
      return inboxOptionValue(person);
    }
    return (slot && slot.id) || "";
  }
  function _renderInboxDetailPlayers(m, classification) {
    const box = document.getElementById("inbox-detail-players");
    if (!box) return;
    const slots = reviewDetectedPlayers({ ...m, classification: classification || m.classification });
    const opts = _reviewPlayerOptions();
    box.replaceChildren();
    slots.forEach((slot, i) => {
      const wrap = document.createElement("div");
      wrap.className = "inbox-detail-player-slot";
      const lab = document.createElement("label");
      lab.textContent = slots.length === 1 ? "Player" : `Player ${i + 1}`;
      const sel = document.createElement("select");
      sel.className = "inbox-detail-player-sel";
      sel.dataset.slot = String(i);
      sel.setAttribute("aria-label", slots.length === 1
        ? "Player detected on this email"
        : `Player ${i + 1} detected on this email`);
      const none = document.createElement("option");
      none.value = ""; none.textContent = "— none —";
      sel.appendChild(none);
      for (const p of opts) {
        const o = document.createElement("option");
        o.value = String(p.value);
        o.textContent = p.label;
        sel.appendChild(o);
      }
      sel.value = _resolveReviewSlotId(slot);
      lab.appendChild(sel);
      wrap.appendChild(lab);
      if (slot.hint && !_resolveReviewSlotId(slot)) {
        const hint = document.createElement("span");
        hint.className = "inbox-detail-player-hint muted";
        hint.textContent = `From email: ${slot.hint}`;
        wrap.appendChild(hint);
      }
      const person = _inboxPersonForSlot({ ...slot, id: sel.value || slot.id });
      _appendPromoteControls(wrap, person, async (res) => {
        const pid = res && (res.player_id || res.promoted_player_id);
        if (pid != null) sel.value = String(pid);
        if (typeof sel._comboSync === "function") sel._comboSync();
        _renderInboxDetailPlayers(_inboxDetailEmail, classification);
      }, slot);
      box.appendChild(wrap);
      enhanceSelect(sel);
      if (typeof sel._comboSync === "function") sel._comboSync();
    });
  }

  let _inboxDetailOpenGen = 0;
  let _inboxDetailEmail = null;
  const _inboxRowsById = new Map();
  function _rememberInboxRow(m) {
    if (!m || m.id == null) return;
    _inboxRowsById.set(m.id, mergeInboxReviewRow(m, _inboxRowsById.get(m.id)));
  }
  function _reviewEmail(m, cell) {
    const id = m && m.id;
    let gridRow = null;
    try { gridRow = cell && cell.getRow && cell.getRow().getData(); } catch (_) {}
    const live = (id != null ? _inboxRowsById.get(id) : null) || gridRow;
    return mergeInboxReviewRow(m, live);
  }
  function _paintInboxDetailConfidence(m) {
    const confEl = document.getElementById("inbox-detail-confidence");
    if (!confEl) return;
    const clsSel = document.getElementById("inbox-detail-classification");
    const row = {
      ...(m || {}),
      classification: (clsSel && clsSel.value) || (m && m.classification) || "",
    };
    const k = _inboxConfidence(row);
    confEl.textContent = k ? inboxConfidenceText(k) : "—";
    confEl.className = k ? `badge badge-${k.cls}` : "muted";
    confEl.title = k ? k.title : "No player identified yet";
  }
  function _openInboxDetail(m) {
    m = _reviewEmail(m);
    const form = reviewFormState(m);
    const gen = ++_inboxDetailOpenGen;
    _populateInboxClassSelect();
    _inboxDetailId = m.id;
    _inboxDetailTid = m.tournament_id ?? null;  // preserve on save (don't re-home to active)
    _inboxDetailPartnerId = m.detected_partner_id ?? null;
    _inboxDetailEmail = m;
    const box = document.getElementById("inbox-detail");
    box.hidden = false;
    document.getElementById("inbox-detail-subject").textContent = m.subject || "(no subject)";
    document.getElementById("inbox-detail-from").textContent = m.from_address || "(no sender)";
    document.getElementById("inbox-detail-to").textContent = m.to_address || "—";
    document.getElementById("inbox-detail-received").textContent = (m.received_at || "").slice(0, 16).replace("T", " ");
    document.getElementById("inbox-detail-source").textContent = inboxSourceLabel(m.ingest_source);
    document.getElementById("inbox-detail-body").innerHTML = formatEmailBody(m.body || "");
    document.getElementById("inbox-detail-classification").value = form.classification;
    document.getElementById("inbox-detail-status").value = form.status;
    // Combo overlay does not watch .value — resync so the visible labels match
    // this email, not the previous one.
    for (const id of ["inbox-detail-classification", "inbox-detail-status"]) {
      const sel = document.getElementById(id);
      if (sel && typeof sel._comboSync === "function") sel._comboSync();
    }
    // Always reset reason from this email (empty when not a withdrawal) so the
    // previous email's Withdrawal/filed values cannot leak into the next open.
    _syncInboxReasonRow(form.classification, form.reason);
    _renderInboxDetailPlayers(m, form.classification);
    _paintInboxDetailConfidence(m);
    // Amendment picker: the earlier email this one corrects + the superseded flag.
    _populateInboxAmendsSelect(m, gen);
    setMsg("inbox-detail-msg", "", true);
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  // Show/hide + fill the withdrawal-reason row based on the current
  // classification. `reason` is only applied when provided (initial open);
  // toggling the dropdown just shows/hides the field without clobbering text.
  function _syncInboxReasonRow(classification, reason) {
    const row = document.getElementById("inbox-detail-reason-row");
    const input = document.getElementById("inbox-detail-reason");
    if (!row || !input) return;
    const isWd = classification === "withdrawal";
    row.hidden = !isWd;
    input.value = isWd ? String(reason || "") : "";
  }
  // Toggle the reason row when the classification is changed in the modal.
  document.getElementById("inbox-detail-classification")
    ?.addEventListener("change", (e) => {
      _syncInboxReasonRow(e.target.value);
      if (_inboxDetailEmail) {
        _inboxDetailEmail = { ..._inboxDetailEmail, classification: e.target.value };
        _renderInboxDetailPlayers(_inboxDetailEmail, e.target.value);
        _paintInboxDetailConfidence(_inboxDetailEmail);
      }
    });
  // Fill the "corrects earlier email" picker with the other emails in this
  // email's tournament, select the current link, and show the superseded flag.
  async function _populateInboxAmendsSelect(m, gen) {
    const sel = document.getElementById("inbox-detail-amends");
    if (!sel) return;
    sel.innerHTML = '<option value="">— not a correction —</option>';
    if (m.tournament_id) {
      let emails = [];
      try { emails = await api(`/emails?tournament_id=${m.tournament_id}`); } catch (_) {}
      for (const e of emails) {
        if (e.id === m.id) continue;
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = `#${e.id} ${(e.subject || "(no subject)").slice(0, 60)}`;
        sel.appendChild(o);
      }
    }
    if (gen != null && gen !== _inboxDetailOpenGen) return;
    sel.value = m.amends_email_id || "";
    if (typeof sel._comboSync === "function") sel._comboSync();
    document.getElementById("inbox-detail-superseded").hidden = !m.superseded;
  }
  document.getElementById("inbox-detail-amends")?.addEventListener("change", async (e) => {
    if (_inboxDetailId == null) return;
    try {
      await api(`/emails/${_inboxDetailId}/amends`, { method: "POST",
        body: JSON.stringify({ amends_email_id: e.target.value ? Number(e.target.value) : null }) });
      setMsg("inbox-detail-msg", e.target.value ? "marked as a correction" : "correction link cleared", true);
      await loadInbox();
    } catch (err) { setMsg("inbox-detail-msg", err.message, false); }
  });
  function _closeInboxDetail() {
    _inboxDetailId = null;
    _inboxDetailEmail = null;
    document.getElementById("inbox-detail").hidden = true;
  }
  // Esc closes the detail modal — but not while focus is in a form control
  // (so Esc can cancel a combobox/list edit first). A second Esc then closes.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const box = document.getElementById("inbox-detail");
    if (!box || box.hidden) return;
    const a = document.activeElement;
    if (a && box.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    e.preventDefault();
    _closeInboxDetail();
  });
  // Click on the backdrop (outside the modal-box) also closes.
  document.getElementById("inbox-detail").addEventListener("click", (e) => {
    if (e.target.id === "inbox-detail") _closeInboxDetail();
  });
  // Import PDF — opens the hidden file picker, posts to the emails_pdf type,
  // auto-merges, reloads the inbox. No need to walk through Setup → Import.
  document.getElementById("inbox-import-pdf-btn").addEventListener("click", () => {
    document.getElementById("inbox-import-pdf-input").click();
  });
  document.getElementById("inbox-import-pdf-input").addEventListener("change", async (e) => {
    if (!getActive()) return;
    const f = e.target.files[0];
    if (!f) return;
    setMsg("inbox-import-pdf-msg", `uploading ${f.name}…`, true);
    try {
      const fd = new FormData(); fd.append("file", f);
      const job = await _runMailJob("Processing mail", { phase: "Uploading PDF" }, async ({ signal, update }) => {
        const up = await api(`/import/tournaments/${getActive().id}/emails_pdf`, { method: "POST", body: fd, signal });
        update({ phase: "Merging emails", current: 0, total: up.valid || up.total || 0 });
        const m = await api(`/import/batches/${up.batch_id}/merge`, { method: "POST", signal });
        update({ current: m.merged || 0 });
        return { up, m };
      });
      if (job.cancelled) { setMsg("inbox-import-pdf-msg", "cancelled", false); return; }
      const { m } = job.result;
      setMsg("inbox-import-pdf-msg",
        `imported ${m.merged} email${m.merged === 1 ? "" : "s"}` +
          (m.conflicts.length ? ` (+${m.conflicts.length} dupes skipped)` : ""), true);
      await loadInbox();
    } catch (err) {
      setMsg("inbox-import-pdf-msg", err.message, false);
    } finally {
      e.target.value = "";
    }
  });
  inboxGrid.grid.on("rowClick", (ev, row) => {
    if (!inboxRowClickOpensReview(ev && ev.target)) return;
    const data = row && row.getData && row.getData();
    if (data) _openInboxDetail(_reviewEmail(data));
  });
  document.getElementById("inbox-detail-close").addEventListener("click", _closeInboxDetail);
  document.getElementById("inbox-detail-save").addEventListener("click", async () => {
    if (_inboxDetailId == null) return;
    const cls = document.getElementById("inbox-detail-classification").value;
    const status = document.getElementById("inbox-detail-status").value;
    const pickers = [...document.querySelectorAll("#inbox-detail-players select")];
    const ids = [];
    for (const s of pickers) {
      const inboxId = parseInboxOptionValue(s.value);
      if (inboxId != null) {
        setMsg("inbox-detail-msg", "Add to Players first — inbox people are not on Setup Players yet", false);
        await confirmDialog(
          "Add this inbox person to Players before saving a player slot.",
          "OK", "primary",
        );
        return;
      }
      ids.push(s.value ? Number(s.value) : null);
    }
    const detected_player_id = ids[0] || null;
    const detected_partner_id = detected_player_id == null ? null : (ids[1] || null);
    if (status === "filed") {
      const gate = fileWithoutPlayerGate(cls, detected_player_id);
      if (!gate.ok) {
        setMsg("inbox-detail-msg", gate.reason, false);
        await confirmDialog(gate.reason, "OK", "primary");
        return;
      }
    }
    try {
      await api(`/emails/${_inboxDetailId}`, {
        method: "PUT",
        body: JSON.stringify({
          // keep the email's own tournament (see _inboxPutClass) — don't re-home
          // to the active workspace; only default to active if it was unassigned.
          tournament_id: _inboxDetailTid ?? (getActive() && getActive().id) ?? null,
          classification: cls, status,
          detected_player_id,
          detected_partner_id,
        }),
      });
      setMsg("inbox-detail-msg", "saved", true);
      await loadInbox();
    } catch (e) { setMsg("inbox-detail-msg", e.message, false); }
  });
  document.getElementById("inbox-detail-suggest").addEventListener("click", async () => {
    if (_inboxDetailId == null) return;
    try {
      const res = await api(`/emails/${_inboxDetailId}/suggest`, { method: "POST" });
      const m = _inboxDetailEmail || { id: _inboxDetailId };
      await _inboxPutClass(m, res.classification);
      m.classification = res.classification;
      if (res.detected_name_pairs) m.detected_name_pairs = res.detected_name_pairs;
      if (res.detected_reason != null) m.detected_reason = res.detected_reason;
      let det = {};
      if (m.tournament_id) {
        try {
          det = await api(`/emails/${_inboxDetailId}/detect-player`, { method: "POST" });
        } catch (_) { /* unassigned / no roster — keep parsed names */ }
      }
      const hasDet = det && det.email_id != null;
      Object.assign(m, {
        detected_player_id: hasDet ? det.detected_player_id : m.detected_player_id,
        detected_usta: hasDet ? det.detected_usta : m.detected_usta,
        detected_player_name: hasDet ? det.detected_player_name : m.detected_player_name,
        detected_match_kind: hasDet ? det.match_kind : m.detected_match_kind,
        detected_partner_id: hasDet ? det.detected_partner_id : m.detected_partner_id,
        detected_partner_name: hasDet ? det.detected_partner_name : m.detected_partner_name,
        detected_partner_usta: hasDet ? det.detected_partner_usta : m.detected_partner_usta,
        detected_member_ids: hasDet ? det.detected_member_ids : m.detected_member_ids,
        detected_member_names: hasDet ? det.detected_member_names : m.detected_member_names,
        detected_name_pairs: (hasDet && det.detected_name_pairs)
          || res.detected_name_pairs || m.detected_name_pairs,
      });
      _inboxDetailEmail = m;
      _rememberInboxRow(m);
      try {
        for (const row of inboxGrid.grid.getRows()) {
          if (row.getData().id !== _inboxDetailId) continue;
          row.update({
            classification: m.classification,
            detected_player_id: m.detected_player_id,
            detected_usta: m.detected_usta,
            detected_player_name: m.detected_player_name,
            detected_match_kind: m.detected_match_kind,
            detected_partner_id: m.detected_partner_id,
            detected_partner_name: m.detected_partner_name,
            detected_member_ids: m.detected_member_ids,
            detected_member_names: m.detected_member_names,
            detected_name_pairs: m.detected_name_pairs,
          });
          break;
        }
      } catch (_) {}
      const clsSel = document.getElementById("inbox-detail-classification");
      clsSel.value = res.classification;
      if (typeof clsSel._comboSync === "function") clsSel._comboSync();
      _syncInboxReasonRow(res.classification, m.detected_reason);
      _renderInboxDetailPlayers(m, res.classification);
      _paintInboxDetailConfidence(m);
      const pairHint = (m.detected_name_pairs || []).map((p) => p && p.name).filter(Boolean);
      const who = (det.detected_member_names && det.detected_member_names.length > 1)
        ? det.detected_member_names.join(" + ")
        : det.detected_player_name
          ? det.detected_player_name + (det.detected_partner_name ? ` + ${det.detected_partner_name}` : "")
          : pairHint.join(" + ");
      setMsg("inbox-detail-msg",
        who ? `suggested: ${res.classification} · ${who}` : `suggested: ${res.classification}`,
        true);
    } catch (e) { setMsg("inbox-detail-msg", e.message, false); }
  });

  // ---- Bulk inbox selection state + toolbar wiring ------------------------
  const _inboxSelected = new Set();
  function _inboxBulkToggle(id, on) {
    if (on) _inboxSelected.add(id); else _inboxSelected.delete(id);
    _inboxBulkRefreshUi();
  }
  function _inboxBulkToggleAll(on) {
    for (const row of inboxGrid.grid.getRows("active")) {
      const id = row.getData().id;
      if (on) _inboxSelected.add(id); else _inboxSelected.delete(id);
    }
    inboxGrid.grid.redraw();
    _inboxBulkRefreshUi();
  }
  function _inboxBulkRefreshUi() {
    const bar = document.getElementById("inbox-bulk-toolbar");
    const hint = document.getElementById("inbox-select-hint");
    const n = _inboxSelected.size;
    bar.hidden = bulkBarHidden(n);
    document.getElementById("inbox-bulk-count").textContent = selectionCountLabel(n);
    // When the grid has rows but nothing is checked, surface why bulk actions
    // are missing (the bar is progressive — empty inbox uses the AG empty-state).
    let displayed = 0;
    try {
      displayed = (inboxGrid && inboxGrid.grid && inboxGrid.grid.getDisplayedRowCount()) || 0;
    } catch (_) { /* grid not ready */ }
    if (hint) hint.hidden = selectHintHidden(n, displayed);
  }
  // I-3: build a per-target-list breakdown of what Populate would create, so the
  // TD sees "5 Withdrawals, 3 Doubles, 2 unfileable" before committing. Reads the
  // classification off each selected row's grid data and maps via FILE_TARGETS.
  function _inboxPopulatePreview() {
    const byLabel = new Map();
    const tabByLabel = new Map();
    let unfileable = 0;
    let needsPlayer = 0;
    const rows = inboxGrid.grid.getData();
    const sel = new Set(_inboxSelected);
    for (const m of rows) {
      if (!sel.has(m.id)) continue;
      const gate = fileWithoutPlayerGate(m.classification, m.detected_player_id);
      if (!gate.ok) { needsPlayer += 1; continue; }
      const t = FILE_TARGETS[m.classification];
      if (!t) { unfileable += 1; continue; }
      byLabel.set(t.label, (byLabel.get(t.label) || 0) + 1);
      tabByLabel.set(t.label, t.tab);
    }
    // Most-populated target first — drives the toast "View" deep-link.
    const ranked = [...byLabel.entries()].sort((a, b) => b[1] - a[1]);
    const parts = ranked.map(([label, c]) => `${c} ${label}`);
    const top = ranked[0];
    return {
      parts, unfileable, needsPlayer, fileable: parts.length > 0,
      topLabel: top ? top[0] : null,
      topTab: top ? tabByLabel.get(top[0]) : null,
    };
  }
  async function _inboxPopulateTournamentDropdown() {
    const sel = document.getElementById("inbox-bulk-tournament");
    if (sel.dataset.loaded === "1") return;
    try {
      const ts = await api("/tournaments");
      for (const t of ts) {
        const o = document.createElement("option"); o.value = t.id;
        o.textContent = `${t.name} (#${t.id})`;
        sel.appendChild(o);
      }
      sel.dataset.loaded = "1";
    } catch (_) { /* leave empty */ }
  }
  document.getElementById("inbox-bulk-clear").addEventListener("click", () => {
    _inboxSelected.clear();
    inboxGrid.grid.redraw();
    _inboxBulkRefreshUi();
  });
  function _isoDateLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function _defaultMailWindow() {
    const until = new Date();
    const since = new Date(until.getFullYear(), until.getMonth(), until.getDate() - 7);
    const sEl = document.getElementById("inbox-mail-since");
    const uEl = document.getElementById("inbox-mail-until");
    if (sEl && !sEl.value) sEl.value = _isoDateLocal(since);
    if (uEl && !uEl.value) uEl.value = _isoDateLocal(until);
  }
  async function _inboxFetchMails({ reprocess = false } = {}) {
    const t = getActive();
    if (!t) { toast("Select a tournament first", false); return; }
    _defaultMailWindow();
    const since = document.getElementById("inbox-mail-since")?.value || "";
    const until = document.getElementById("inbox-mail-until")?.value || "";
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    if (until) q.set("until", until);
    q.set("tournament_id", String(t.id));
    if (document.getElementById("inbox-get-all")?.checked) q.set("get_all", "true");
    if (reprocess) q.set("reprocess", "true");
    const getBtn = document.getElementById("inbox-get-mails");
    const rpBtn = document.getElementById("inbox-reprocess");
    if (getBtn) getBtn.disabled = true;
    if (rpBtn) rpBtn.disabled = true;
    setMsg("inbox-feed-msg", reprocess ? "reprocessing date range…" : "fetching Gmail and Outlook…", true);
    const phases = reprocess
      ? ["Connecting mailbox", "Fetching mailbox", "Reprocessing stored mail"]
      : ["Connecting mailbox", "Fetching Gmail", "Fetching Outlook", "Classifying leftover mail"];
    try {
      const job = await _runMailJob("Processing mail", { phase: phases[0], phases }, ({ signal }) =>
        api("/inbox-feeds/fetch?" + q.toString(), { method: "POST", signal }));
      if (job.cancelled) { setMsg("inbox-feed-msg", "cancelled", false); return; }
      const r = job.result;
      const n = r.imported ?? 0;
      const d = r.duplicates ?? 0;
      const skipped = (r.skipped || []).join(", ");
      const restored = r.restored ?? 0;
      const rp = r.reprocessed ?? 0;
      setMsg("inbox-feed-msg",
        `imported ${n} new` + (restored ? ` · restored ${restored}` : "") +
        (d ? ` · ${d} already in inbox` : "") +
        (rp ? ` · reprocessed ${rp}` : "") +
        (skipped ? ` · skipped ${skipped}` : ""), true);
      await loadInbox();
    } catch (e) { setMsg("inbox-feed-msg", e.message, false); }
    finally {
      if (getBtn) getBtn.disabled = false;
      if (rpBtn) rpBtn.disabled = false;
    }
  }
  document.getElementById("inbox-get-mails")?.addEventListener("click", () => _inboxFetchMails());
  document.getElementById("inbox-reprocess")?.addEventListener("click", async () => {
    if (!getActive()) { toast("Select a tournament first", false); return; }
    if (!(await confirmDialog(
      "Re-read mailbox mail in this date range and run leftover LLM + classify again on copies already in CourtOps? This does not create duplicate rows.",
      "Reprocess range", "primary",
    ))) return;
    await _inboxReprocessRange();
  });
  async function _inboxReprocessRange() {
    const t = getActive();
    if (!t) { toast("Select a tournament first", false); return; }
    _defaultMailWindow();
    const since = document.getElementById("inbox-mail-since")?.value || "";
    const until = document.getElementById("inbox-mail-until")?.value || "";
    const q = new URLSearchParams();
    if (since) q.set("since", since);
    if (until) q.set("until", until);
    q.set("tournament_id", String(t.id));
    if (document.getElementById("inbox-get-all")?.checked) q.set("get_all", "true");
    const getBtn = document.getElementById("inbox-get-mails");
    const rpBtn = document.getElementById("inbox-reprocess");
    if (getBtn) getBtn.disabled = true;
    if (rpBtn) rpBtn.disabled = true;
    setMsg("inbox-feed-msg", "reprocessing date range…", true);
    try {
      const job = await _runMailJob("Processing mail", { phase: "Fetching mailbox" }, async ({ signal, update }) => {
        await api("/inbox-feeds/fetch?" + q.toString(), { method: "POST", signal });
        update({ phase: "Listing stored mail" });
        const listed = await api("/inbox-feeds/reprocess-ids?" + q.toString(), { signal });
        const ids = listed.ids || [];
        const leftover = listed.leftover || "off";
        const fallback = listed.fallback || null;
        const rangeLabel = [since, until].filter(Boolean).join(" … ") || "this range";
        if (!ids.length) {
          update({ phase: "No stored copies", current: 0, total: 0 });
          return { ids, leftover, leftoverCalls: 0, fallback, rangeLabel };
        }
        const phase = "Analyzing...";
        update({ phase, current: 0, total: ids.length });
        if (fallback === "tournament") {
          toast(`No stored copies in ${rangeLabel} — reprocessing ${ids.length} from this tournament`, true);
        }
        if (leftover !== "ok") {
          toast(leftover === "off"
            ? "Intelligence is off — leftover LLM will not run (heuristic only)"
            : "Intelligence sidecar is down — leftover LLM will not run (heuristic only)", false);
        }
        let leftoverCalls = 0;
        for (let i = 0; i < ids.length; i++) {
          if (signal && signal.aborted) {
            const err = new Error("cancelled");
            err.name = "AbortError";
            throw err;
          }
          update({ phase, current: i, total: ids.length });
          const chunk = await api("/emails/bulk/reprocess", {
            method: "POST",
            body: JSON.stringify({ email_ids: [ids[i]] }),
            signal,
          });
          leftoverCalls += chunk.leftover_calls || 0;
        }
        update({ phase, current: ids.length, total: ids.length });
        return { ids, leftover, leftoverCalls, fallback, rangeLabel };
      });
      if (job.cancelled) { setMsg("inbox-feed-msg", "cancelled", false); return; }
      const r = job.result || {};
      const n = (r.ids || []).length;
      const calls = r.leftoverCalls || 0;
      const rangeLabel = r.rangeLabel || "this range";
      if (!n) {
        setMsg("inbox-feed-msg", `no stored copies in ${rangeLabel}`, false);
      } else if (r.fallback === "tournament") {
        setMsg("inbox-feed-msg",
          `reprocessed ${n} tournament copies (none in ${rangeLabel})` +
          (calls ? ` · leftover LLM ${calls}` : " · leftover LLM 0"),
          calls > 0);
      } else {
        setMsg("inbox-feed-msg",
          `reprocessed ${n}` + (calls ? ` · leftover LLM ${calls}` : " · leftover LLM 0"),
          calls > 0);
      }
      await loadInbox();
    } catch (e) { setMsg("inbox-feed-msg", e.message, false); }
    finally {
      if (getBtn) getBtn.disabled = false;
      if (rpBtn) rpBtn.disabled = false;
    }
  }
  document.getElementById("inbox-clear")?.addEventListener("click", async () => {
    const t = getActive();
    if (!t) { toast("Select a tournament first", false); return; }
    if (!(await confirmDialog(
      `Hide CourtOps copies of mail for ${t.name}? This does not delete anything in Gmail or Outlook/Hotmail. Get mails (or Get all) can bring them back. Filed list rows stay.`,
      "Clear inbox",
    ))) return;
    const btn = document.getElementById("inbox-clear");
    if (btn) btn.disabled = true;
    try {
      const r = await api(`/emails/clear?tournament_id=${t.id}`, { method: "POST" });
      _inboxSelected.clear();
      setMsg("inbox-feed-msg",
        `cleared ${r.deleted ?? 0} CourtOps copies (Gmail/Outlook unchanged)`, true);
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) { setMsg("inbox-feed-msg", e.message, false); }
    finally { if (btn) btn.disabled = false; }
  });
  document.getElementById("inbox-bulk-classify").addEventListener("click", async (ev) => {
    if (!_inboxSelected.size) return;
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const ids = [..._inboxSelected];
      const job = await _runMailJob("Processing mail", { phase: "Classifying", current: 0, total: ids.length }, ({ signal, update }) =>
        api("/emails/bulk/classify", {
          method: "POST", body: JSON.stringify({ email_ids: ids }), signal,
        }).then((res) => { update({ current: ids.length }); return res; }));
      if (job.cancelled) { setMsg("inbox-bulk-msg", "cancelled", false); return; }
      const res = job.result;
      if (!res.classified) {
        setMsg("inbox-bulk-msg", "Nothing to classify (already classified, or no rule matched).", false);
      } else {
        const parts = Object.entries(res.counts)
          .map(([k, n]) => `${n} ${(EMAIL_CLASS_META[k] && EMAIL_CLASS_META[k].label) || k}`).join(", ");
        setMsg("inbox-bulk-msg", `classified ${res.classified}: ${parts}`, true);
        toast(`Auto-classified ${res.classified} email${res.classified === 1 ? "" : "s"} — review, then Detect players → Populate.`, true);
      }
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
    finally { btn.disabled = false; }
  });
  document.getElementById("inbox-bulk-detect").addEventListener("click", async (ev) => {
    if (!_inboxSelected.size) return;
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const ids = [..._inboxSelected];
      const job = await _runMailJob("Processing mail", { phase: "Detecting players", current: 0, total: ids.length }, ({ signal, update }) =>
        api("/emails/bulk/detect-players", {
          method: "POST", body: JSON.stringify({ email_ids: ids }), signal,
        }).then((res) => { update({ current: ids.length }); return res; }));
      if (job.cancelled) { setMsg("inbox-bulk-msg", "cancelled", false); return; }
      const res = job.result;
      const hits = res.filter((r) => r.detected_player_id).length;
      const miss = res.length - hits;
      setMsg("inbox-bulk-msg", `detected ${hits} of ${res.length}` + (miss ? ` · ${miss} still unmatched` : ""), true);
      toast(miss
        ? `Matched ${hits}/${res.length} — ${miss} still unmatched (toggle “Unmatched only” to focus them)`
        : `Matched all ${hits} selected email(s)`, !miss);
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
    finally { btn.disabled = false; }
  });
  // "Unmatched only" drilldown: a SERVER-SIDE filter (unmatched=true) so it's
  // accurate across the whole inbox, not just the loaded page — the TD works
  // through every detection gap. Reloads on toggle; persists across reloads.
  let _inboxUnmatchedOnly = false;
  document.getElementById("inbox-unmatched-only")?.addEventListener("change", (e) => {
    _inboxUnmatchedOnly = e.target.checked;
    loadInbox();
  });
  // One-click "Detect players" over the whole inbox: runs the detector on every
  // loaded email that has no matched player yet (and an assigned tournament — the
  // detector needs a roster). No row selection required.
  document.getElementById("inbox-confirm-suggestions")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const ids = inboxGrid.grid.getData()
      .filter((m) => !m.detected_player_id && m.tournament_id
        && ((m.detected_name_pairs || []).length || m.detected_usta_text))
      .map((m) => m.id);
    if (!ids.length) {
      setMsg("inbox-import-pdf-msg", "no unmatched emails with a parsed name or USTA # to confirm", true);
      return;
    }
    if (!(await confirmDialog(
      `Confirm ${ids.length} parsed suggestion(s)? Players with a USTA # in the email are added to the catalog (not the roster) when gender can be inferred, then linked.`,
      "Confirm suggestions", "primary"))) return;
    btn.disabled = true;
    setMsg("inbox-import-pdf-msg", `confirming ${ids.length} suggestion(s)…`, true);
    try {
      const job = await _runMailJob("Processing mail", { phase: "Confirming suggestions", current: 0, total: ids.length }, ({ signal, update }) =>
        api("/emails/bulk/confirm-suggestions", {
          method: "POST", body: JSON.stringify({ email_ids: ids }), signal,
        }).then((res) => { update({ current: ids.length }); return res; }));
      if (job.cancelled) { setMsg("inbox-import-pdf-msg", "cancelled", false); return; }
      const res = job.result;
      const msg = `confirmed ${res.confirmed}`
        + (res.created ? ` · ${res.created} catalog player(s)` : "")
        + (res.still_unmatched ? ` · ${res.still_unmatched} still unmatched` : "");
      setMsg("inbox-import-pdf-msg", msg, !res.still_unmatched);
      toast(msg, !res.still_unmatched);
      await loadInbox();
    } catch (e) { setMsg("inbox-import-pdf-msg", e.message, false); toast(e.message, false); }
    finally { btn.disabled = false; }
  });
  document.getElementById("inbox-detect-all").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const ids = inboxGrid.grid.getData()
      .filter((m) => !m.detected_player_id && m.tournament_id)
      .map((m) => m.id);
    if (!ids.length) { setMsg("inbox-import-pdf-msg", "every inbox email already has a matched player", true); return; }
    btn.disabled = true;
    setMsg("inbox-import-pdf-msg", `detecting players for ${ids.length} email(s)…`, true);
    try {
      const job = await _runMailJob("Processing mail", { phase: "Detecting players", current: 0, total: ids.length }, ({ signal, update }) =>
        api("/emails/bulk/detect-players", {
          method: "POST", body: JSON.stringify({ email_ids: ids }), signal,
        }).then((res) => { update({ current: ids.length }); return res; }));
      if (job.cancelled) { setMsg("inbox-import-pdf-msg", "cancelled", false); return; }
      const res = job.result;
      const hits = res.filter((r) => r.detected_player_id).length;
      const miss = ids.length - hits;
      setMsg("inbox-import-pdf-msg",
        `matched ${hits} of ${ids.length} unmatched email(s)` + (miss ? ` · ${miss} still open` : ""), true);
      if (miss) {
        toast(`Still ${miss} unmatched — click the “N unmatched” summary chip or enable Unmatched only`, true);
      } else {
        toast(`Matched all ${hits} previously unmatched email(s)`, true);
      }
      await loadInbox();
    } catch (e) { setMsg("inbox-import-pdf-msg", e.message, false); }
    finally { btn.disabled = false; }
  });
  // Retention sweep (PII hardening H3 / COPPA §312.10): redact body/subject/sender
  // of FILED emails past the threshold via POST /api/emails/purge. The provenance
  // row survives (classification, player link, status) so the audit trail holds;
  // 'new' (unprocessed) mail is never touched. UI for the existing endpoint.
  {
    const purge = (days) => async () => {
      if (!(await confirmDialog(
        `Redact the text (body / subject / sender) of all FILED emails older than ${days} days, across all tournaments?\n` +
        "The rows stay (classification, matched player, status) — only the free-text PII is erased. This cannot be undone.",
        "Purge", "danger"))) return;
      try {
        const res = await api(`/emails/purge?older_than_days=${days}`, { method: "POST" });
        toast(`Retention sweep: ${res.purged} filed email(s) redacted`, true);
        await loadInbox();
      } catch (e) { toast(e.message, false); }
    };
    const menu = makeMenuButton(`<span aria-hidden="true">🗑</span> Retention`, [
      { label: "Purge filed older than 30 days…", onClick: purge(30), danger: true },
      { label: "Purge filed older than 90 days…", onClick: purge(90), danger: true },
      { label: "Purge filed older than 1 year…", onClick: purge(365), danger: true },
    ], { className: "export-btn no-print", title: "PII retention: redact the free text of old FILED emails (rows + audit trail survive)" });
    const anchor = document.getElementById("inbox-detect-all");
    anchor.parentNode.insertBefore(menu, anchor.nextSibling);
  }
  document.getElementById("inbox-bulk-reassign").addEventListener("click", async () => {
    if (!_inboxSelected.size) return;
    const sel = document.getElementById("inbox-bulk-tournament");
    if (!sel.value) { setMsg("inbox-bulk-msg", "pick a tournament", false); return; }
    try {
      const res = await api("/emails/bulk/reassign", {
        method: "POST",
        body: JSON.stringify({ email_ids: [..._inboxSelected], tournament_id: Number(sel.value) }),
      });
      setMsg("inbox-bulk-msg", `moved ${res.updated} emails`, true);
      _inboxSelected.clear();
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
  });
  // Bulk status: clear the info-only emails (hotel notes, acks) that don't
  // populate a list but should still leave the 'unfiled' queue. Mirrors the other
  // bulk actions: POST /emails/bulk/status → toast + reload + refresh summary.
  const _inboxBulkStatus = (status, verb) => async (ev) => {
    if (!_inboxSelected.size) return;
    if (status === "filed") {
      const rows = (inboxGrid.grid.getData() || []).filter((m) => _inboxSelected.has(m.id));
      const blocked = rows.filter((m) => !fileWithoutPlayerGate(m.classification, m.detected_player_id).ok);
      if (blocked.length === _inboxSelected.size) {
        const reason = fileWithoutPlayerGate("withdrawal", null).reason;
        setMsg("inbox-bulk-msg", reason, false);
        await confirmDialog(reason, "OK", "primary");
        return;
      }
    }
    const btn = ev.currentTarget;
    btn.disabled = true;
    try {
      const res = await api("/emails/bulk/status", {
        method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected], status }),
      });
      const n = res.updated;
      const skipped = (res.skipped || []).length;
      let msg = `${verb} ${n} email${n === 1 ? "" : "s"}`;
      if (skipped) {
        msg += `. ${skipped} skipped — ${fileWithoutPlayerGate("withdrawal", null).reason}`;
      }
      setMsg("inbox-bulk-msg", msg, !skipped);
      toast(msg, !skipped);
      _inboxSelected.clear();
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) { setMsg("inbox-bulk-msg", e.message, false); }
    finally { btn.disabled = false; }
  };
  document.getElementById("inbox-bulk-filed")
    .addEventListener("click", _inboxBulkStatus("filed", "Marked filed"));
  document.getElementById("inbox-bulk-followup")
    .addEventListener("click", _inboxBulkStatus("needs_followup", "Flagged for follow-up"));
  document.getElementById("inbox-bulk-populate").addEventListener("click", async (ev) => {
    if (!_inboxSelected.size) return;
    const btn = ev.currentTarget;
    // I-3: show exactly what will be created, broken down by destination list,
    // plus a count of selections that can't be filed (no fileable classification).
    const { parts, unfileable, needsPlayer, fileable, topLabel, topTab } = _inboxPopulatePreview();
    if (!fileable && !needsPlayer) {
      setMsg("inbox-bulk-msg", "None of the selected emails have a fileable classification yet.", false);
      return;
    }
    const lines = [
      `This will create rows in their target lists from ${_inboxSelected.size} selected emails:`,
      "",
      ...parts.map((p) => `  • ${p}`),
    ];
    if (unfileable) lines.push("", `${unfileable} selected email(s) have no fileable classification and will be skipped.`);
    if (needsPlayer) {
      const gate = fileWithoutPlayerGate("withdrawal", null);
      lines.push("", `${needsPlayer} withdrawal/doubles email(s) have no matched player and will be skipped.`, gate.reason);
    }
    if (!fileable && needsPlayer) {
      setMsg("inbox-bulk-msg", fileWithoutPlayerGate("withdrawal", null).reason, false);
      await confirmDialog(lines.join("\n"), "OK", "primary");
      return;
    }
    if (!(await confirmDialog(lines.join("\n"), "Populate lists"))) return;
    // Guard against accidental double-insert: disable until the request resolves.
    btn.disabled = true;
    try {
      const res = await api("/emails/bulk/populate", {
        method: "POST", body: JSON.stringify({ email_ids: [..._inboxSelected] }),
      });
      const skippedMsg = res.skipped.length
        ? ` · ${res.skipped.length} skipped (${res.skipped.slice(0, 3).map((s) => s.reason).join("; ")}${res.skipped.length > 3 ? "…" : ""})`
        : "";
      setMsg("inbox-bulk-msg", `filed ${res.filed}${skippedMsg}`, res.skipped.length === 0);
      // I-1: close the loop with a visible toast summarizing where rows landed,
      // plus a "View" deep-link to the most-populated target list.
      const summary = `Filed ${res.filed}: ${parts.join(", ")}${skippedMsg}`;
      const action = topTab
        ? { label: `View ${topLabel}`, onClick: () => { const t = document.querySelector(`.tab[data-target="${topTab}"]`); if (t) t.click(); } }
        : null;
      toast(summary, res.skipped.length === 0, action);
      _inboxSelected.clear();
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) {
      setMsg("inbox-bulk-msg", e.message, false);
      toast(e.message, false);
    } finally {
      btn.disabled = false;
    }
  });
  // One-click triage: classify → detect players → populate, in a single request.
  async function _inboxRunTriage(ev) {
    if (!_inboxSelected.size) return;
    const btn = ev && ev.currentTarget
      ? ev.currentTarget
      : document.getElementById("inbox-bulk-triage");
    if (!(await confirmDialog(
      `Triage ${_inboxSelected.size} selected email(s)?\n\nThis will, in one pass:\n` +
      `  1. auto-classify the unclassified ones (local rules)\n` +
      `  2. detect the player each is about\n` +
      `  3. file the fileable ones into their lists\n\n` +
      `Doubles / pairing emails and any without a detected player are left for manual filing.`,
      "Triage all", "primary"))) return;
    if (btn) btn.disabled = true;
    try {
      const ids = [..._inboxSelected];
      const job = await _runMailJob("Processing mail", { phase: "Triaging", current: 0, total: ids.length }, ({ signal, update }) =>
        api("/emails/bulk/triage", {
          method: "POST", body: JSON.stringify({ email_ids: ids }), signal,
        }).then((res) => { update({ current: ids.length }); return res; }));
      if (job.cancelled) { setMsg("inbox-bulk-msg", "cancelled", false); return; }
      const res = job.result;
      const skippedMsg = res.skipped.length
        ? ` · ${res.skipped.length} left for manual filing`
        : "";
      const summary = `Triaged: classified ${res.classified}, matched ${res.detected}, filed ${res.filed}${skippedMsg}`;
      setMsg("inbox-bulk-msg", summary, res.skipped.length === 0);
      toast(summary, res.skipped.length === 0);
      // Keep selection of rows that still need work (skipped) so the TD can
      // continue with Detect / Add to roster without re-selecting.
      if (res.skipped && res.skipped.length) {
        const keep = new Set(res.skipped.map((s) => s.id));
        for (const id of [..._inboxSelected]) {
          if (!keep.has(id)) _inboxSelected.delete(id);
        }
      } else {
        _inboxSelected.clear();
      }
      await loadInbox();
      _inboxBulkRefreshUi();
    } catch (e) {
      setMsg("inbox-bulk-msg", e.message, false);
      toast(e.message, false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  document.getElementById("inbox-bulk-triage").addEventListener("click", _inboxRunTriage);

  // Inbox-panel shortcuts (when not typing in a field):
  //   t = triage selection · d = detect selection (or detect-all if none)
  //   f = mark filed · u = toggle unmatched-only · / = search (global)
  // Gate rules live in inbox_ui.js (unit-tested).
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const panel = document.getElementById("panel-t-inbox");
    if (!panel || !panel.classList.contains("active")) return;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "button" && a.type !== "checkbox") return;
    // Detail modal owns its own keys.
    const detail = document.getElementById("inbox-detail");
    if (detail && !detail.hidden) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const gate = inboxShortcutGate(k, _inboxSelected.size);
    if (!gate.ok) {
      if (gate.reason) toast(gate.reason, false);
      return;
    }
    if (k === "t") {
      e.preventDefault();
      _inboxRunTriage(null);
    } else if (k === "d") {
      e.preventDefault();
      if (_inboxSelected.size) {
        document.getElementById("inbox-bulk-detect")?.click();
      } else {
        document.getElementById("inbox-detect-all")?.click();
      }
    } else if (k === "f") {
      e.preventDefault();
      document.getElementById("inbox-bulk-filed")?.click();
    } else if (k === "u") {
      e.preventDefault();
      const cb = document.getElementById("inbox-unmatched-only");
      if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
    }
  });

  // Populate the tournament dropdown lazily — once when the panel opens.
  _inboxPopulateTournamentDropdown();
  let _inboxFilterInit = false;
  const _INBOX_PAGE = 200;  // server-side cap; search to reach older mail
  async function loadInbox() {
    if (!getActive()) return;
    _defaultMailWindow();
    // Scope to the active tournament so search, paging, and unmatched counts
    // agree with the status summary (and q hits the right rows). Server-side
    // `q` matches subject/sender/classification/division/player/USTA text —
    // body is encrypted, so it's metadata search only (D9).
    const q = (document.getElementById("inbox-search")?.value || "").trim();
    const params = new URLSearchParams({
      limit: String(_INBOX_PAGE),
      tournament_id: String(getActive().id),
    });
    if (q) params.set("q", q);
    if (_inboxUnmatchedOnly) params.set("unmatched", "true");
    // Need X-Total-Count for the "showing N of M" note — fetch directly.
    _progress(1);
    let rows = [], total = null;
    try {
      const res = await fetch("/api/emails?" + params.toString(), { credentials: "same-origin" });
      if (res.status === 401) {
        if (await sessionIsGone()) {
          document.dispatchEvent(new CustomEvent("auth-expired"));
        }
        throw new Error("not authenticated");
      }
      if (!res.ok) {
        let detail = res.statusText;
        try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch (_) {}
        throw new Error(_humanizeDetail(detail, `${res.status}`));
      }
      total = res.headers.get("X-Total-Count");
      if (total != null) total = parseInt(total, 10);
      rows = await res.json();
    } finally {
      _progress(-1);
    }
    await _loadInboxPeople();
    _inboxRowsById.clear();
    for (const r of rows) _rememberInboxRow(r);
    inboxGrid.setData(rows);
    // Drop selection ids that are no longer on the page (tournament switch /
    // filter), then refresh bulk bar vs select-hint.
    const keep = new Set(pruneSelection([..._inboxSelected], rows.map((r) => r.id)));
    for (const id of [..._inboxSelected]) {
      if (!keep.has(id)) _inboxSelected.delete(id);
    }
    _inboxBulkRefreshUi();
    const note = document.getElementById("inbox-search-note");
    if (note) {
      const n = rows.length;
      const tot = Number.isFinite(total) ? total : null;
      if (tot != null && tot > n) {
        note.textContent = q
          ? `showing ${n} of ${tot} match(es) — refine search to narrow`
          : `showing ${n} of ${tot} — refine search to reach older mail`;
      } else if (q) {
        note.textContent = `${n} match(es)`;
      } else if (tot != null) {
        note.textContent = tot ? `${tot} in this tournament` : "";
      } else {
        note.textContent = "";
      }
    }
    // Default status filter "new" once; tournament is already server-scoped.
    if (!_inboxFilterInit) {
      _inboxFilterInit = true;
      try { inboxGrid.grid.setHeaderFilterValue("status", "new"); } catch (_) {}
    }
    _loadInboxStatusSummary();
    if (typeof sizeLists === "function") {
      sizeLists();
      requestAnimationFrame(() => sizeLists());
    }
  }
  // Inbox progress summary: counts of unfiled (new) / filed / need-follow-up for
  // the active tournament, so the TD sees what's left to process at a glance.
  // "unfiled" is the actionable number and clicking it filters the grid to new.
  async function _loadInboxStatusSummary() {
    const el = document.getElementById("inbox-status-summary");
    if (!el || !getActive()) return;
    let c;
    try { c = await api(`/emails/status-counts?tournament_id=${getActive().id}`); }
    catch (_) { el.hidden = true; return; }
    if (!c.total) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    el.innerHTML =
      `<a href="#" id="inbox-sum-new" class="${c.new ? "inbox-sum-todo" : ""}" title="Queue: emails not yet filed into a list">${c.new} unfiled</a>` +
      ` · <span class="resp-ok">${c.filed} filed</span>` +
      (c.needs_followup ? ` · <span class="warn">${c.needs_followup} need follow-up</span>` : "") +
      (c.unmatched ? ` · <a href="#" id="inbox-sum-unmatched" class="warn">${c.unmatched} unmatched</a>` : "") +
      ` · ${c.total} total`;
    const link = document.getElementById("inbox-sum-new");
    if (link) link.addEventListener("click", (e) => {
      e.preventDefault();
      // Clear unmatched-only so "unfiled" shows the full new-mail queue, not a
      // subset that can look empty after a PDF import of mostly-matched rows.
      const cb = document.getElementById("inbox-unmatched-only");
      if (cb && cb.checked) { cb.checked = false; _inboxUnmatchedOnly = false; loadInbox(); }
      try { inboxGrid.grid.setHeaderFilterValue("status", "new"); } catch (_) {}
    });
    // "N unmatched" → flip on the server-side unmatched-only drilldown (and sync
    // the checkbox so the two controls agree).
    const um = document.getElementById("inbox-sum-unmatched");
    if (um) um.addEventListener("click", (e) => {
      e.preventDefault();
      const cb = document.getElementById("inbox-unmatched-only");
      if (cb && !cb.checked) { cb.checked = true; }
      _inboxUnmatchedOnly = true;
      try { inboxGrid.grid.setHeaderFilterValue("status", "new"); } catch (_) {}
      loadInbox();
    });
    _renderInboxAging();
  }

  // Oldest unfiled emails first, with days-waiting — so nothing languishes. Shown
  // only when the oldest has waited a while; clicking an item searches for it.
  async function _renderInboxAging() {
    const box = document.getElementById("inbox-aging");
    if (!box || !getActive()) return;
    let d;
    try { d = await api(`/emails/aging?tournament_id=${getActive().id}&limit=5`); }
    catch (_) { box.hidden = true; return; }
    // Only surface when there's a backlog worth nudging (oldest ≥ 2 days).
    if (!d.count || d.oldest_age_days < 2) { box.hidden = true; box.innerHTML = ""; return; }
    const age = (n) => html`<span class="ia-age${n >= 7 ? " ia-old" : ""}">${n}d</span>`;
    box.hidden = false;
    box.innerHTML = html`<div class="ia-head">Oldest unfiled — ${d.oldest_age_days} day(s) waiting</div><ul class="ia-list">${d.items.map((i) =>
      html`<li class="ia-item" data-subj="${i.subject || ""}">${age(i.age_days)} <span class="ia-subj">${i.subject || "(no subject)"}</span> <span class="muted">${i.from_address || ""}</span></li>`)}</ul>`;
    box.querySelectorAll(".ia-item").forEach((li) => li.addEventListener("click", () => {
      const search = document.getElementById("inbox-search");
      if (search) { search.value = li.dataset.subj; loadInbox(); }
    }));
  }
  // Debounced server-side inbox search (re-queries; no per-keystroke round-trip).
  let _inboxSearchTimer = null;
  document.getElementById("inbox-search")?.addEventListener("input", () => {
    clearTimeout(_inboxSearchTimer);
    _inboxSearchTimer = setTimeout(() => { if (getActive()) loadInbox(); }, 300);
  });
  onSubmit(document.getElementById("email-form"), async (e) => {
    if (!getActive()) return;
    const b = formObj(e.target); b.tournament_id = getActive().id;
    const guard = emailCreateGuard(b);
    if (!guard.ok) {
      setMsg(EMAIL_MSG_ID, guard.reason, false);
      markInvalid(e.target, guard.reason);
      return;
    }
    try {
      await api("/emails", { method: "POST", body: JSON.stringify(b) });
      setMsg(EMAIL_MSG_ID, "added", true);
      toast("Email added to the inbox", true);
      e.target.reset();
      loadInbox();
    }
    catch (err) { setMsg(EMAIL_MSG_ID, err.message, false); toast(err.message, false); markInvalid(e.target, err.message); }
  });

  // Generic simple list grid (no master-detail): replaces a static table with a
  // Tabulator grid + a Delete action + a per-grid CSV download. Used by the
  // delete-only workspace lists (late entries, withdrawals).
  // Give each meaningful data column a header filter box (skip synthetic `_…`
  // fields and any column that already declares its own filter). `input` matches a
  // substring against the column's field value (works through formatters since the
  // underlying value is what's filtered).
  // makeListGrid / makeReadGrid / _autoHeaderFilters live in ./app/grids.js (P2 #11a).
  // Origin cell: did this list row come from a filed email (✉, tooltip = the
  // email's subject) or was it entered manually? Read-only badge.
  function _originCell(c) {
    const r = c.getData();
    if (r.source_email_id) {
      const subj = r.source_subject || `email #${r.source_email_id}`;
      return hstr`<span class="origin-email" title="${"Filed from email: " + subj}">Email</span>`;
    }
    return '<span class="muted">Manual</span>';
  }
  const _ORIGIN_COL = { title: "Origin", field: "source_email_id", headerSort: false,
    width: 100, formatter: _originCell };

  return {
    loadInbox,
    // Prefill is owned by roster; keep a thin re-export for any callers that
    // still expect this name on the inbox factory result.
    inboxAddToRoster: _inboxAddToRoster,
    invalidatePickCache: _invalidatePickCache,
    verifyEmailTargets,
  };
}
