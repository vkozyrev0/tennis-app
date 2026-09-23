// Playwright smoke of the shipped SPA (no build step, real browser).
//
//   node scripts/ui_smoke.mjs [base-url]        # default http://127.0.0.1:8000
//
// Drives the app the way a TD does: sign in, pick a tournament, walk every
// section (L1) and tab (L2), then exercise the screens the ESM-split refactor
// left half-wired - the reports cert-pool matrix and staffing plan, the
// room-block prereq callout, the pairing-avoidance member rows (including the
// inbox "File as ..." prefill), and the tournament form open/new path. Fails on
// an uncaught page error, on a console or HTTP error after sign-in, on a tab
// that renders nothing, and on the desktop/mobile layout checks.
//
// Screenshots land in .ui-smoke/ (git-ignored). The app must be running, and
// `npx playwright install chromium` must have been run once. The one email the
// run seeds for the inbox check is deleted again at the end.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

// `document` / `window` appear only inside page.evaluate() callbacks, which the
// browser runs, not node.
/* global document, window */

const BASE = process.argv[2] || "http://127.0.0.1:8000";
const SHOTS = ".ui-smoke";
mkdirSync(SHOTS, { recursive: true });

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log("  ok   -", name); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log("  FAIL -", name, detail); }
}

const errors = [];
const httpErrors = [];

/** Watch one page. Each browser context signs in separately, so the
 *  "expected while signed out" window is tracked per page: the SPA probes
 *  /api/auth/me, /api/tournaments, /api/import/types and /api/td-chat/verdict
 *  before the login POST lands, and the browser logs a 401 for each. Any
 *  console or HTTP error after that page signed in is a finding. */
function watch(page, where) {
  let signedIn = false;
  page.on("pageerror", (e) => errors.push(`${where}: pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (!signedIn && /401|Unauthorized|Failed to load resource/.test(m.text())) return;
    errors.push(`${where}: console.error: ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && signedIn) httpErrors.push(`${where}: ${r.status()} ${r.url()}`);
  });
  return { markSignedIn: () => { signedIn = true; } };
}

async function signIn(page, session) {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.fill("#login-form [name=username]", "admin");
  await page.fill("#login-form [name=password]", "admin");
  await page.click("#login-form button[type=submit]");
  await page.waitForSelector("#active-tournament", { state: "visible", timeout: 20000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#active-tournament option").length > 1,
    null, { timeout: 20000 },
  );
  session.markSignedIn();
}

async function selectTournament(page) {
  const value = await page.$eval("#active-tournament", (sel) => {
    const opt = [...sel.options].find((o) => o.value);
    return opt ? opt.value : "";
  });
  if (!value) return "";
  await page.selectOption("#active-tournament", value);
  await page.waitForTimeout(1000);          // active-tournament-changed cascade
  return value;
}

/** group -> [tab targets], read from the live nav so it can't drift. */
async function tabMap(page) {
  const groups = await page.$$eval("#menu-groups button.gbtn", (els) => els.map((e) => e.dataset.group));
  const map = {};
  for (const g of groups) {
    map[g] = await page.$$eval(`.menu-group[data-group="${g}"] button.tab`,
      (els) => els.map((e) => e.dataset.target));
  }
  return map;
}

/** Close any open master/detail overlay so the next click isn't blocked. */
async function closeDetail(page) {
  for (let i = 0; i < 3 && await page.locator(".detail-backdrop.show").count(); i++) {
    const closeBtn = page.locator(".detail-pane:visible .detail-close, .detail-pane:visible .cancel");
    if (await closeBtn.count() && await closeBtn.first().isVisible()) await closeBtn.first().click();
    else await page.locator(".detail-backdrop.show").click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
}

let MAP = {};

/** Open the L2 tab that owns `target` (found via the live nav map). */
async function openTab(page, target, settle = 900) {
  const group = Object.keys(MAP).find((g) => MAP[g].includes(target));
  if (!group) return false;
  await closeDetail(page);
  await page.click(`#menu-groups button.gbtn[data-group="${group}"]`);
  await page.waitForTimeout(300);
  const tab = page.locator(`.menu-group[data-group="${group}"] button.tab[data-target="${target}"]`);
  if (await tab.count() && await tab.first().isVisible()) await tab.first().click();
  await page.waitForTimeout(settle);
  return page.locator(`#${target}`).first().isVisible();
}

async function walkAllTabs(page, label, shotPrefix) {
  let opened = 0;
  const failed = [];
  for (const group of Object.keys(MAP)) {
    await closeDetail(page);
    await page.click(`#menu-groups button.gbtn[data-group="${group}"]`);
    await page.waitForTimeout(300);
    const targets = MAP[group];
    for (const t of targets) {
      if (await openTab(page, t)) opened++; else failed.push(`${group}/${t}`);
    }
    if (!targets.length) {                   // solo group: L1 itself is the tab
      const visible = await page.locator(".panel:not([hidden])").first().isVisible();
      if (visible) opened++; else failed.push(`${group}/(solo)`);
    }
  }
  check(`${label}: every section + tab opens (${opened} panels)`, failed.length === 0, failed.join(", "));
  await page.screenshot({ path: `${SHOTS}/${shotPrefix}-all-tabs.png`, fullPage: true });
}

/** Seed a pairing-avoidance email for the active tournament and run the real
 *  detector on it, so the inbox has something the "File as ..." flow can use. */
async function seedPairingEmail(page, tid) {
  return page.evaluate(async ({ tournamentId }) => {
    const j = (r) => r.json();
    const roster = await fetch(`/api/tournaments/${tournamentId}/players`, { credentials: "same-origin" }).then(j);
    const withName = roster.filter((r) => r.player_id && r.first_name && r.last_name).slice(0, 2);
    if (withName.length < 2) return { ok: false, reason: "need 2 named roster players" };
    const [a, b] = withName;
    const subject = `UISMOKE pairing ${Math.random().toString(16).slice(2, 8)}`;
    const body = `${a.first_name} ${a.last_name} and ${b.first_name} ${b.last_name} `
      + "must not be paired in the same group.";
    const created = await fetch("/api/emails", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournament_id: Number(tournamentId), from_address: "ui-smoke@example.com", subject, body }),
    }).then(j);
    await fetch(`/api/emails/${created.id}`, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tournament_id: Number(tournamentId), classification: "pairing_avoidance", status: "new" }),
    }).then(j);
    const detected = await fetch(`/api/emails/${created.id}/detect-player`, {
      method: "POST", credentials: "same-origin",
    }).then(j);
    return {
      ok: true, emailId: created.id, subject,
      memberIds: detected.detected_member_ids || [],
    };
  }, { tournamentId: tid });
}

/** Drop the email this run seeded, so repeated runs don't pile up test mail. */
async function cleanupSeededEmail(page, emailId) {
  if (!emailId) return true;
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/emails/${id}`, { method: "DELETE", credentials: "same-origin" });
    return r.ok || r.status === 404;
  }, emailId);
}

async function desktopRun(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const session = watch(page, "desktop");
  await signIn(page, session);
  check("sign-in reaches the app shell", await page.locator("#active-tournament").isVisible());

  const tid = await selectTournament(page);
  check("an active tournament can be selected", Boolean(tid), tid ? "" : "no tournaments in the dev DB");
  MAP = await tabMap(page);

  await walkAllTabs(page, "desktop", "01");

  // --- Tournaments: row select + form open (the rewired setup_crud callbacks) ---
  check("tournaments: tab opens", await openTab(page, "panel-tournaments", 1400));
  const rows = page.locator("#panel-tournaments .ag-row");
  const rowCount = await rows.count();
  check("tournaments: grid renders rows", rowCount > 0, `${rowCount}`);
  if (rowCount) {
    await rows.first().click();
    await page.waitForTimeout(400);
    check("tournaments: row select keeps the grid usable", await rows.first().isVisible());
  }
  await page.locator("#panel-tournaments .new-btn").first().click();
  await page.waitForTimeout(700);
  check("tournaments: New opens the form pane",
    await page.locator("#tournament-form").isVisible().catch(() => false));
  await page.screenshot({ path: `${SHOTS}/02-tournament-form.png` });
  await closeDetail(page);

  // --- Reports: cert-pool matrix (getCertPairs) + staffing plan (STAFF_ROLES) ---
  check("reports: tab opens", await openTab(page, "panel-t-reports", 2000));
  const certHead = (await page.locator("#cert-pool-table thead").innerText().catch(() => "")).trim();
  check("reports: cert-pool matrix renders a header (getCertPairs wired)",
    certHead.length > 0, JSON.stringify(certHead.slice(0, 80)));
  const certBody = (await page.locator("#cert-pool-table tbody").innerText().catch(() => "")).trim();
  check("reports: cert-pool matrix renders rows", certBody.length > 0, JSON.stringify(certBody.slice(0, 80)));
  await page.locator("#cert-pool-table").screenshot({ path: `${SHOTS}/03b-cert-pool.png` })
    .catch(() => {});
  const staffHead = (await page.locator("#report-staff-table thead").innerText().catch(() => "")).trim();
  check("reports: staffing plan renders a header", staffHead.length > 0);
  const staffBody = (await page.locator("#report-staff-table tbody").innerText().catch(() => "")).trim();
  check("reports: staffing plan body renders", staffBody.length > 0, JSON.stringify(staffBody.slice(0, 80)));
  check("reports: no raw role key leaked into the staffing plan",
    !/(site_director|player_amenities)/.test(staffBody));
  await page.screenshot({ path: `${SHOTS}/03-reports.png`, fullPage: true });

  // --- Room blocks: grid mounts (loadRoomBlocks) + prereq callout (getHotelsById) ---
  check("room blocks: tab opens", await openTab(page, "panel-t-roomblocks", 1800));
  const trbGrid = await page.locator("#panel-t-roomblocks .ag-root").count();
  check("room blocks: grid mounts (loadRoomBlocks ran)", trbGrid > 0, `ag-root count ${trbGrid}`);
  check("room blocks: panel renders content",
    (await page.locator("#panel-t-roomblocks").innerText().catch(() => "")).trim().length > 0);
  await page.screenshot({ path: `${SHOTS}/04-roomblocks.png` });

  // --- Pairing form: member rows (pairingMemberRow) ---
  check("pairing: tab opens", await openTab(page, "panel-t-pairing", 1200));
  await page.locator("#panel-t-pairing .new-btn").first().click();
  await page.waitForTimeout(800);
  check("pairing: Add pairing group opens the form",
    await page.locator("#pairing-form").isVisible().catch(() => false));
  const before = await page.locator("#pairing-members .pmember").count();
  await page.click("#pairing-add-member");
  await page.waitForTimeout(400);
  const after = await page.locator("#pairing-members .pmember").count();
  check("pairing: + member appends a row", after === before + 1, `${before} -> ${after}`);
  await page.screenshot({ path: `${SHOTS}/05-pairing-form.png` });
  await closeDetail(page);

  // --- Inbox: grid + "File as ..." pairing prefill ---
  const seeded = await seedPairingEmail(page, tid);
  check("inbox: seeded a pairing-avoidance email and detected its group",
    seeded.ok && seeded.memberIds.length >= 2,
    seeded.ok ? `detected_member_ids=${JSON.stringify(seeded.memberIds)}` : seeded.reason);

  check("inbox: tab opens", await openTab(page, "panel-t-inbox", 2200));
  check("inbox: grid renders rows", (await page.locator("#panel-t-inbox .ag-row").count()) > 0);

  if (seeded.ok) {
    const row = page.locator("#panel-t-inbox .ag-row", { hasText: seeded.subject }).first();
    check("inbox: the seeded email is listed", await row.count() > 0);
    if (await row.count()) {
      // Open the row's ⋯ menu from the keyboard: a mouse click also makes AG
      // Grid scroll the row into view, and the menu closes itself on scroll.
      const trigger = row.locator("button.row-more").first();
      await trigger.focus();
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(600);
      const fileItem = page.locator("button.menu-btn-item:visible")
        .filter({ hasText: /^File as/i }).first();
      check("inbox: the File as … action is offered", await fileItem.count() > 0);
      await page.screenshot({ path: `${SHOTS}/06-inbox-row-menu.png` });
      if (await fileItem.count()) {
        await fileItem.click();
        await page.waitForTimeout(1800);
        const memberRows = await page.locator("#pairing-members .pmember").count();
        check("inbox: File as pairing prefills one member row per detected player",
          memberRows === seeded.memberIds.length,
          `${memberRows} rows for ${seeded.memberIds.length} detected members`);
        check("inbox: the pairing form is the one that opened",
          await page.locator("#pairing-form").isVisible().catch(() => false));
        const filled = await page.$$eval("#pairing-members .pm-player",
          (els) => els.map((e) => e.value).filter(Boolean));
        check("inbox: each prefilled member row picked a player",
          filled.length === seeded.memberIds.length, JSON.stringify(filled));
        await page.screenshot({ path: `${SHOTS}/07-pairing-prefill.png`, fullPage: true });
      }
    }
  }
  await closeDetail(page);
  await openTab(page, "panel-t-inbox", 1500);
  await page.screenshot({ path: `${SHOTS}/08-inbox.png`, fullPage: true });
  check("inbox: the seeded email was cleaned up again",
    await cleanupSeededEmail(page, seeded.emailId));

  // --- Assignments cards (respChip) ---
  check("assignments: tab opens", await openTab(page, "panel-t-assignments", 1800));
  check("assignments: cards render", (await page.locator("#asg-list > *").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/09-assignments.png`, fullPage: true });

  // --- Roster ---
  check("roster: tab opens", await openTab(page, "panel-t-roster", 1800));
  check("roster: grid mounts", (await page.locator("#panel-t-roster .ag-root").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/10-roster.png`, fullPage: true });

  // --- Shell: help overlay ---
  await page.keyboard.press("?");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/11-help.png` });
  await page.keyboard.press("Escape");

  await ctx.close();
}

async function mobileRun(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const session = watch(page, "mobile");
  await signIn(page, session);
  check("mobile: app shell renders", await page.locator("#active-tournament").isVisible());
  await selectTournament(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("mobile: no horizontal page overflow", overflow <= 2, `overflow ${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/20-mobile-home.png`, fullPage: true });
  MAP = await tabMap(page);
  await walkAllTabs(page, "mobile", "21-mobile");
  check("mobile: roster tab opens", await openTab(page, "panel-t-roster", 1800));
  await page.screenshot({ path: `${SHOTS}/22-mobile-roster.png`, fullPage: true });
  await ctx.close();
}

const browser = await chromium.launch();
try {
  await desktopRun(browser);
  await mobileRun(browser);
} finally {
  await browser.close();
}

console.log("");
if (errors.length) {
  console.log(`UNCAUGHT PAGE/CONSOLE ERRORS (${errors.length}):`);
  for (const e of errors) console.log("  -", e);
}
if (httpErrors.length) {
  console.log(`HTTP 4xx/5xx AFTER SIGN-IN (${httpErrors.length}):`);
  for (const e of httpErrors) console.log("  -", e);
}
console.log(`${passed} checks passed, ${failures.length} failed, `
  + `${errors.length} uncaught page/console errors, ${httpErrors.length} HTTP errors after sign-in`);
console.log(`screenshots: ${SHOTS}/`);
process.exit(failures.length || errors.length || httpErrors.length ? 1 : 0);
