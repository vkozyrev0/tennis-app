// Inbox → Gmail: IMAP app-password feed + latest-UID cursor.

export function installGmailFeed(ctx) {
  const { api, setMsg, formObj, onSubmit, fillSelect } = ctx;

  async function loadGmailFeed() {
    const box = document.getElementById("gmail-feed-status");
    let s;
    try { s = await api("/gmail-feed"); }
    catch (e) {
      if (box) box.textContent = e.message || "Could not load Gmail settings";
      return;
    }
    const f = document.getElementById("gmail-feed-form");
    if (!f) return;
    f.enabled.checked = !!s.enabled;
    f.gmail_address.value = s.gmail_address || "";
    f.app_password.value = "";
    f.app_password.placeholder = s.has_secret ? "unchanged (leave blank)" : "16-character App Password";
    f.mailbox.value = s.mailbox || "INBOX";
    f.gmail_query.value = s.gmail_query || "";
    f.poll_minutes.value = s.poll_minutes ?? 15;
    f.lookback_days.value = s.lookback_days ?? 7;
    try {
      const ts = await api("/tournaments");
      fillSelect(f.tournament_id, ts, (t) => t.name);
      f.tournament_id.value = s.tournament_id != null ? String(s.tournament_id) : "";
      if (typeof f.tournament_id._comboSync === "function") f.tournament_id._comboSync();
    } catch (_) { /* leave empty */ }
    if (box) {
      const bits = [];
      bits.push(s.enabled ? "Feed on" : "Feed off");
      bits.push(s.has_secret ? "app password saved" : "no app password yet");
      if (s.last_fetched_at) {
        bits.push(`last fetch ${(s.last_fetched_at || "").slice(0, 16).replace("T", " ")}`);
        bits.push(s.last_status || "");
        if (s.last_imported != null) bits.push(`${s.last_imported} new`);
        if (s.last_uid) bits.push(`cursor UID ${s.last_uid}`);
      } else {
        bits.push("never fetched — Get latest pulls the lookback window");
      }
      if (s.last_error) bits.push(`error: ${s.last_error}`);
      box.textContent = bits.filter(Boolean).join(" · ");
    }
    setMsg("gmail-feed-msg", "", true);
  }

  const form = document.getElementById("gmail-feed-form");
  if (form) {
    onSubmit(form, async () => {
      const o = formObj(form);
      const body = {
        enabled: !!form.enabled.checked,
        gmail_address: o.gmail_address || "",
        mailbox: o.mailbox || "INBOX",
        gmail_query: o.gmail_query || "",
        poll_minutes: o.poll_minutes ? Number(o.poll_minutes) : 15,
        lookback_days: o.lookback_days ? Number(o.lookback_days) : 7,
        tournament_id: o.tournament_id ? Number(o.tournament_id) : null,
      };
      if ((o.app_password || "").trim()) body.app_password = o.app_password.trim();
      try {
        await api("/gmail-feed", { method: "PUT", body: JSON.stringify(body) });
        setMsg("gmail-feed-msg", "saved — password stays encrypted at rest", true);
        await loadGmailFeed();
      } catch (e) { setMsg("gmail-feed-msg", e.message, false); }
    });
  }
  document.getElementById("gmail-feed-fetch")?.addEventListener("click", async () => {
    setMsg("gmail-feed-msg", "fetching from Gmail…", true);
    try {
      const r = await api("/gmail-feed/fetch", { method: "POST" });
      const n = r.imported ?? 0;
      const d = r.duplicates ?? 0;
      setMsg("gmail-feed-msg",
        `imported ${n} new` + (d ? ` · ${d} already in inbox` : "") +
        (r.last_uid != null ? ` · cursor UID ${r.last_uid}` : ""), true);
      await loadGmailFeed();
    } catch (e) { setMsg("gmail-feed-msg", e.message, false); }
  });

  return { loadGmailFeed };
}
