// Run: node frontend/app/gmail_feed.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../index.html"), "utf8");
const js = readFileSync(join(here, "gmail_feed.js"), "utf8");
const app = readFileSync(join(here, "../app.js"), "utf8");

assert.match(html, /data-group="inbox"[\s\S]*data-target="panel-gmail"/);
assert.match(html, /id="panel-gmail"/);
{
  const setup = html.slice(html.indexOf('data-group="setup"'), html.indexOf('data-group="tournament"'));
  assert.doesNotMatch(setup, /data-target="panel-gmail"/);
}
assert.match(html, /id="gmail-feed-form"/);
assert.match(html, /name="gmail_address"/);
assert.match(html, /name="app_password"/);
assert.match(html, /name="poll_minutes"/);
assert.match(html, /name="lookback_days"/);
assert.match(html, /id="gmail-feed-fetch"/);
assert.match(html, /App passwords/);
assert.match(html, /2-Step Verification/);
assert.match(html, /imap\.gmail\.com/);
assert.match(html, /never sends or deletes mail/);
assert.match(html, /UID cursor/);
assert.match(js, /\/gmail-feed\/fetch/);
assert.match(js, /app_password/);
assert.match(app, /installGmailFeed/);
assert.match(app, /panel-gmail/);
assert.match(html, /id="inbox-get-mails"/);
assert.match(html, /id="panel-t-inbox"/);
console.log("gmail_feed page + wiring checks passed");
