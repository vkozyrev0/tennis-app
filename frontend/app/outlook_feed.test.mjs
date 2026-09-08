// Run: node frontend/app/outlook_feed.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "../index.html"), "utf8");
const js = readFileSync(join(here, "outlook_feed.js"), "utf8");
const app = readFileSync(join(here, "../app.js"), "utf8");

assert.match(html, /data-group="inbox"[\s\S]*data-target="panel-outlook"/);
assert.match(html, /id="panel-outlook"/);
{
  const setup = html.slice(html.indexOf('data-group="setup"'), html.indexOf('data-group="tournament"'));
  assert.doesNotMatch(setup, /data-target="panel-outlook"/);
}
assert.match(html, /data-target="panel-outlook"/);
assert.match(html, /id="outlook-feed-form"/);
assert.match(html, /name="tenant_id"/);
assert.match(html, /name="client_id"/);
assert.match(html, /name="client_secret"/);
assert.match(html, /name="mailbox"/);
assert.match(html, /name="poll_minutes"/);
assert.match(html, /name="lookback_days"/);
assert.match(html, /name="mail_query"/);
assert.match(html, /id="outlook-feed-fetch"/);
assert.match(html, /Get latest/);
assert.match(html, /Mail\.Read/);
assert.match(html, /never sends or deletes mail/);
assert.match(html, /Mail\.ReadWrite/);
assert.match(html, /client credentials/i);
assert.match(html, /graph\.microsoft\.com/);
assert.match(html, /Directory \(tenant\) ID/);
assert.match(html, /Application \(client\) ID/);
assert.doesNotMatch(html, /secret_enc/);
assert.match(js, /\/outlook-feed\/fetch/);
assert.match(js, /client_secret/);
assert.match(app, /installOutlookFeed/);
assert.match(app, /panel-outlook/);
assert.match(app, /loadOutlookFeed/);
assert.match(html, /id="inbox-get-mails"/);
assert.match(html, /id="panel-t-inbox"/);
console.log("outlook_feed page + wiring checks passed");
