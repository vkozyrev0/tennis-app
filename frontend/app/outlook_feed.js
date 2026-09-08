// Inbox → Outlook: Microsoft Graph app-only feed + received-time cursor.

import { parseLocaleDate } from "./td_helpers.js";

export function installOutlookFeed(ctx) {
  const { api, setMsg, formObj, onSubmit, fillSelect } = ctx;

  async function loadOutlookFeed() {
    const box = document.getElementById("outlook-feed-status");
    let s;
    try { s = await api("/outlook-feed"); }
    catch (e) {
      if (box) box.textContent = e.message || "Could not load Outlook settings";
      return;
    }
    const f = document.getElementById("outlook-feed-form");
    if (!f) return;
    f.enabled.checked = !!s.enabled;
    f.mailbox.value = s.mailbox || "";
    f.tenant_id.value = s.tenant_id || "";
    f.client_id.value = s.client_id || "";
    f.client_secret.value = "";
    f.client_secret.placeholder = s.has_secret ? "unchanged (leave blank)" : "Entra client secret value";
    f.client_secret_expires.value = parseLocaleDate(s.client_secret_expires) || "";
    f.mail_query.value = s.mail_query || "";
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
      bits.push(s.has_secret ? "client secret saved" : "no client secret yet");
      if (s.client_secret_expires) bits.push(`secret expires ${s.client_secret_expires}`);
      if (s.last_fetched_at) {
        bits.push(`last fetch ${(s.last_fetched_at || "").slice(0, 16).replace("T", " ")}`);
        bits.push(s.last_status || "");
        if (s.last_imported != null) bits.push(`${s.last_imported} new`);
        if (s.last_received_at) bits.push(`cursor ${(s.last_received_at || "").slice(0, 19).replace("T", " ")}`);
      } else {
        bits.push("never fetched — Get latest pulls the lookback window");
      }
      if (s.last_error) bits.push(`error: ${s.last_error}`);
      box.textContent = bits.filter(Boolean).join(" · ");
    }
    setMsg("outlook-feed-msg", "", true);
  }

  const form = document.getElementById("outlook-feed-form");
  if (form) {
    onSubmit(form, async () => {
      const o = formObj(form);
      const body = {
        enabled: !!form.enabled.checked,
        mailbox: o.mailbox || "",
        tenant_id: o.tenant_id || "",
        client_id: o.client_id || "",
        client_secret_expires: o.client_secret_expires || "",
        mail_query: o.mail_query || "",
        poll_minutes: o.poll_minutes ? Number(o.poll_minutes) : 15,
        lookback_days: o.lookback_days ? Number(o.lookback_days) : 7,
        tournament_id: o.tournament_id ? Number(o.tournament_id) : null,
      };
      if ((o.client_secret || "").trim()) body.client_secret = o.client_secret.trim();
      try {
        await api("/outlook-feed", { method: "PUT", body: JSON.stringify(body) });
        setMsg("outlook-feed-msg", "saved — secret stays encrypted at rest", true);
        await loadOutlookFeed();
      } catch (e) { setMsg("outlook-feed-msg", e.message, false); }
    });
  }
  document.getElementById("outlook-feed-fetch")?.addEventListener("click", async () => {
    setMsg("outlook-feed-msg", "fetching from Microsoft Graph…", true);
    try {
      const r = await api("/outlook-feed/fetch", { method: "POST" });
      const n = r.imported ?? 0;
      const d = r.duplicates ?? 0;
      setMsg("outlook-feed-msg",
        `imported ${n} new` + (d ? ` · ${d} already in inbox` : "") +
        (r.last_received_at ? ` · cursor ${(r.last_received_at || "").slice(0, 19).replace("T", " ")}` : ""), true);
      await loadOutlookFeed();
    } catch (e) { setMsg("outlook-feed-msg", e.message, false); }
  });

  return { loadOutlookFeed };
}
