// Run: node frontend/app/inactivity.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInactivityGuard, IDLE_MS, WARN_BEFORE_MS } from "./inactivity.js";

const here = dirname(fileURLToPath(import.meta.url));

function mockClock() {
  let t = 0;
  const timers = new Map();
  let nid = 1;
  function flush() {
    let more = true;
    while (more) {
      more = false;
      for (const [id, rec] of [...timers]) {
        if (rec.at <= t) {
          timers.delete(id);
          rec.fn();
          more = true;
        }
      }
    }
  }
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = nid++;
      timers.set(id, { at: t + Number(ms), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      t += ms;
      flush();
    },
  };
}

function setup(extra = {}) {
  const clock = mockClock();
  const calls = { warn: 0, expire: 0, ping: 0 };
  const guard = createInactivityGuard({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    idleMs: 1000,
    warnBeforeMs: 200,
    onWarn: () => { calls.warn += 1; },
    onExpire: () => { calls.expire += 1; },
    ping: async () => { calls.ping += 1; },
    ...extra,
  });
  return { clock, calls, guard };
}

{
  const { clock, calls, guard } = setup();
  guard.start();
  assert.equal(guard.getState(), "idle");
  clock.advance(799);
  assert.equal(guard.getState(), "idle");
  assert.equal(calls.warn, 0);
  clock.advance(1);
  assert.equal(guard.getState(), "warn");
  assert.equal(calls.warn, 1);
  assert.equal(calls.expire, 0);
}

{
  const { clock, calls, guard } = setup();
  guard.start();
  clock.advance(800);
  assert.equal(guard.getState(), "warn");
  const stayed = await guard.continue();
  assert.equal(stayed, true);
  assert.equal(guard.getState(), "idle");
  assert.equal(calls.ping, 1);
  assert.equal(calls.expire, 0);
  clock.advance(800);
  assert.equal(guard.getState(), "warn");
  clock.advance(200);
  assert.equal(guard.getState(), "expired");
  assert.equal(calls.expire, 1);
}

{
  const { clock, calls, guard } = setup();
  guard.start();
  clock.advance(1000);
  assert.equal(guard.getState(), "expired");
  assert.equal(calls.warn, 1);
  assert.equal(calls.expire, 1);
  const stayed = await guard.continue();
  assert.equal(stayed, false);
  assert.equal(calls.expire, 1);
}

{
  const { clock, calls, guard } = setup();
  guard.start();
  clock.advance(500);
  guard.activity();
  clock.advance(500);
  assert.equal(guard.getState(), "idle");
  assert.equal(calls.warn, 0);
  clock.advance(300);
  assert.equal(guard.getState(), "warn");
  guard.activity();
  assert.equal(guard.getState(), "warn");
  clock.advance(200);
  assert.equal(guard.getState(), "expired");
  assert.equal(calls.expire, 1);
}

{
  const { clock, calls, guard } = setup();
  guard.start();
  guard.stop();
  clock.advance(5000);
  assert.equal(guard.getState(), "stopped");
  assert.equal(calls.warn, 0);
  assert.equal(calls.expire, 0);
}

assert.equal(IDLE_MS, 15 * 60 * 1000);
assert.equal(WARN_BEFORE_MS, 2 * 60 * 1000);
assert.ok(WARN_BEFORE_MS < IDLE_MS);

const html = readFileSync(join(here, "..", "index.html"), "utf8");
assert.match(html, /id="idle-modal"/);
assert.match(html, /id="idle-continue"/);
assert.match(html, /Stay signed in|Continue/);

const help = readFileSync(join(here, "help.js"), "utf8");
assert.match(help, /Still there\?/);
assert.match(help, /15 minutes/);

const auth = readFileSync(join(here, "auth.js"), "utf8");
assert.match(auth, /createInactivityGuard/);
assert.match(auth, /\.start\(/);
assert.match(auth, /\.stop\(/);
assert.match(auth, /idle-continue/);
assert.match(auth, /auth-expired/);
assert.match(auth, /\/auth\/logout/);

const inbox = readFileSync(join(here, "inbox.js"), "utf8");
assert.match(inbox, /inbox-promote-gender/);
assert.match(inbox, /stopGridEdit/);
assert.match(inbox, /mousedown/);

console.log("inactivity-timer warn/continue/expire + markup checks passed");
