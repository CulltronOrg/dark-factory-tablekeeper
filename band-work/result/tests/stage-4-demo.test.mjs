import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createService } from "../stage-4/src/engine.mjs";

// In-process demo checks, not the official harness or a browser/HTTP run.
// Run with BAND_API_KEY unset. Accounts below are disposable test data;
// generated session tokens stay in memory and are never logged or persisted.
const day = "2035-01-08";
const at = (time) => `${day}T${time}`;

function request(service, method, path, body, headers = {}, query = {}) {
  return service.handle(method, path, query, headers, body === undefined ? "" : JSON.stringify(body));
}

function setup() {
  const service = createService(4);
  const reset = request(service, "POST", "/_test/reset", {
    users: [],
    reservations: [],
    restaurants: [{
      id: "demo", name: "Demo restaurant", timezone: "Europe/Berlin",
      slot_minutes: 30, reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120,
      opening_hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((weekday) => ({
        weekday, opens: "17:00", closes: "23:00",
      })),
      tables: [
        { id: "window", label: "Window", capacity: 2 },
        { id: "banquette", label: "Banquette", capacity: 4 },
        { id: "round", label: "Round", capacity: 6 },
      ],
      combinable: [["window", "banquette"]],
    }],
  });
  assert.equal(reset.status, 204);
  return service;
}

function account(service, email = "diner@example.test") {
  const created = request(service, "POST", "/auth/signup", {
    email, password: "disposable-demo-password", display_name: "Demo diner",
  });
  assert.equal(created.status, 201);
  const loggedIn = request(service, "POST", "/auth/login", {
    email, password: "disposable-demo-password",
  });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.body.user_id, created.body.user_id);
  assert.ok(typeof loggedIn.body.token === "string" && loggedIn.body.token.length > 0);
  return { authorization: `Bearer ${loggedIn.body.token}` };
}

function booking(overrides = {}) {
  return { restaurant_id: "demo", table_id: "window", party_size: 2, starts_at_local: at("17:00"), ...overrides };
}

function book(service, auth, key, body = booking()) {
  return request(service, "POST", "/reservations", body, { ...auth, "idempotency-key": key });
}

function available(service, time, party = "2") {
  const response = request(service, "GET", "/availability", undefined, {}, {
    restaurant_id: "demo", date: day, party_size: party,
  });
  assert.equal(response.status, 200);
  const slot = response.body.slots.find((item) => item.starts_at_local === at(time));
  assert.ok(slot);
  return slot;
}

test("stage 4 demo: health, restaurant detail and table combinations", () => {
  const service = setup();
  assert.deepEqual(request(service, "GET", "/health"), { status: 200, body: { status: "ok" } });
  const listed = request(service, "GET", "/restaurants");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.restaurants.map((item) => item.id), ["demo"]);
  const detail = request(service, "GET", "/restaurants/demo");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.tables.length, 3);
  assert.deepEqual(available(service, "17:00").available_table_ids, ["window", "banquette", "round"]);
  const largeParty = available(service, "17:00", "5");
  assert.deepEqual(largeParty.available_table_ids, ["round"]);
  assert.ok(largeParty.available_options.some((item) => item.table_ids.join(",") === "window,banquette"));
});

test("stage 4 demo: signup, login, booking, lookup, change and cancellation", () => {
  const service = setup();
  const auth = account(service);
  const created = book(service, auth, "initial");
  assert.equal(created.status, 201);
  const path = `/reservations/${created.body.reference}`;
  assert.deepEqual(request(service, "GET", path, undefined, auth).body, created.body);
  const other = account(service, "other@example.test");
  assert.equal(request(service, "GET", path, undefined, other).status, 404);
  assert.equal(request(service, "GET", "/reservations", undefined, auth).body.reservations.length, 1);
  assert.ok(!available(service, "17:00").available_table_ids.includes("window"));

  const changed = request(service, "PATCH", path, {
    table_id: "banquette", party_size: 3, starts_at_local: at("19:00"), expected_revision: created.body.revision,
  }, auth);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.table_id, "banquette");
  assert.equal(changed.body.party_size, 3);
  assert.equal(changed.body.starts_at_local, at("19:00"));
  assert.equal(changed.body.revision, created.body.revision + 1);
  assert.ok(available(service, "17:00").available_table_ids.includes("window"));
  assert.ok(!available(service, "19:00").available_table_ids.includes("banquette"));
  const decision = request(service, "GET", `${path}/decision`, undefined, auth);
  assert.equal(decision.status, 200);
  assert.deepEqual(decision.body.accepted_terms, changed.body.accepted_terms);

  const cancelled = request(service, "POST", `${path}/cancel`, undefined, auth);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.deepEqual(request(service, "POST", `${path}/cancel`, undefined, auth).body, cancelled.body);
  assert.equal(request(service, "GET", path, undefined, auth).body.status, "cancelled");
  assert.ok(available(service, "19:00").available_table_ids.includes("banquette"));
  const history = request(service, "GET", `${path}/history`, undefined, auth);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.entries.map((entry) => entry.event), ["created", "changed", "cancelled"]);
  assert.equal(book(service, auth, "replacement", booking({ table_id: "banquette", starts_at_local: at("19:00") })).status, 201);
});

test("stage 4 demo: retries hold once, overlap conflicts, adjacent seats remain available", () => {
  const service = setup();
  const auth = account(service);
  const created = book(service, auth, "retry-key");
  assert.equal(created.status, 201);
  const replay = book(service, auth, "retry-key");
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, created.body);
  const reused = book(service, auth, "retry-key", booking({ party_size: 1 }));
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error.code, "idempotency_key_reuse");
  const conflict = book(service, auth, "second-key");
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "table_unavailable");
  const combined = book(service, auth, "combined-key", {
    restaurant_id: "demo", table_ids: ["window", "banquette"], party_size: 5, starts_at_local: at("17:30"),
  });
  assert.equal(combined.status, 409);
  assert.equal(combined.body.error.code, "table_unavailable");
  assert.equal(request(service, "GET", "/reservations", undefined, auth).body.reservations.length, 1);
  assert.ok(!available(service, "18:00").available_table_ids.includes("window"));
  assert.ok(available(service, "18:30").available_table_ids.includes("window"));
  assert.equal(book(service, auth, "adjacent", booking({ starts_at_local: at("18:30") })).status, 201);
});

test("stage 4 demo: rejected changes and stale revisions leave bookings intact", () => {
  const service = setup();
  const auth = account(service);
  const created = book(service, auth, "window");
  assert.equal(created.status, 201);
  assert.equal(book(service, auth, "banquette", booking({ table_id: "banquette" })).status, 201);
  const path = `/reservations/${created.body.reference}`;
  const historyBefore = request(service, "GET", `${path}/history`, undefined, auth).body;
  const rejected = request(service, "PATCH", path, {
    table_id: "banquette", party_size: 3, expected_revision: created.body.revision,
  }, auth);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, "table_unavailable");
  assert.deepEqual(request(service, "GET", path, undefined, auth).body, created.body);
  assert.deepEqual(request(service, "GET", `${path}/history`, undefined, auth).body, historyBefore);
  const changed = request(service, "PATCH", path, { party_size: 1, expected_revision: created.body.revision }, auth);
  assert.equal(changed.status, 200);
  const stale = request(service, "PATCH", path, { starts_at_local: at("20:00"), expected_revision: created.body.revision }, auth);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "stale_revision");
  assert.deepEqual(request(service, "GET", path, undefined, auth).body, changed.body);
  const malformed = service.handle("POST", `${path}/cancel`, {}, auth, "{");
  assert.equal(malformed.status, 400);
  assert.deepEqual(request(service, "GET", path, undefined, auth).body, changed.body);
});

test("stage 4 demo: page script parses and vendored fonts exist (static check only)", () => {
  const page = readFileSync(new URL("../stage-4/src/app.html", import.meta.url), "utf8");
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new Script(scripts[0][1], { filename: "stage-4/src/app.html inline script" });
  assert.ok(page.includes('name="viewport"'));
  for (const name of ["literata-400", "literata-700", "outfit-400", "outfit-600"]) {
    assert.ok(page.includes(`/fonts/${name}.woff2`));
    assert.ok(readFileSync(new URL(`../stage-4/src/fonts/${name}.woff2`, import.meta.url)).length > 0);
  }
});

test("stage 4 fallback server adapter: no configured provider key starts the demo and serves search, book, move and cancel without outbound calls", { timeout: 15_000 }, async (t) => {
  // Construct a clean environment rather than inspecting or copying real keys.
  // Execute the real server handler over in-memory streams and IPC. The sandbox
  // forbids socket listeners, so this is a server-adapter test, not a socket test.
  const serverModule = new URL("../stage-4/src/server.mjs", import.meta.url).href;
  const bootstrap = `
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import { Readable } from 'node:stream';
    import { syncBuiltinESMExports } from 'node:module';
    const noOutbound = () => {
      process.send({ kind: 'outbound-call' });
      throw new Error('Outbound calls are forbidden in the key-free demo');
    };
    globalThis.fetch = noOutbound;
    http.request = http.get = https.request = https.get = noOutbound;
    net.connect = net.createConnection = tls.connect = noOutbound;
    syncBuiltinESMExports();
    http.Server.prototype.listen = function (...args) {
      process.on('message', (message) => {
        if (message.kind !== 'request') return;
        const req = Readable.from([Buffer.from(message.body || '')]);
        req.method = message.method;
        req.url = message.path;
        req.headers = message.headers;
        const res = {
          writableEnded: false, destroyed: false, status: 200,
          writeHead(status) { this.status = status; },
          end(body) {
            this.writableEnded = true;
            process.send({ kind: 'response', id: message.id, status: this.status, body: String(body || '') });
          },
        };
        this.emit('request', req, res);
      });
      const callback = args.at(-1);
      if (typeof callback === 'function') callback();
      process.send({ kind: 'ready' });
      return this;
    };
    await import(${JSON.stringify(serverModule)});
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", bootstrap], {
    env: { DEMO: "1", PORT: "0" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  let outboundCalls = 0;
  child.on("message", (message) => { if (message.kind === "outbound-call") outboundCalls++; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The key-free demo did not become ready")), 5_000);
    child.on("message", (message) => {
      if (message.kind === "ready") { clearTimeout(timer); resolve(); }
    });
    child.once("error", () => { clearTimeout(timer); reject(new Error("The key-free demo could not start")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("The key-free demo exited before becoming ready")); });
  });
  let requestId = 0;
  function dispatch(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        child.off("message", receive);
        reject(new Error("The local server handler did not respond"));
      }, 3_000);
      function receive(message) {
        if (message.kind !== "response" || message.id !== id) return;
        clearTimeout(timer);
        child.off("message", receive);
        resolve({ status: message.status, body: message.body });
      }
      child.on("message", receive);
      child.send({ kind: "request", id, method, path, headers, body: body === undefined ? "" : JSON.stringify(body) });
    });
  }
  async function call(method, path, body, headers = {}) {
    const response = await dispatch(method, path, body, headers);
    return { status: response.status, body: JSON.parse(response.body) };
  }
  for (const route of ["/", "/login", "/signup", "/lookup"]) {
    const pageResponse = await dispatch("GET", route);
    assert.equal(pageResponse.status, 200);
    const servedPage = pageResponse.body;
    const visibleStatus = servedPage.match(/<[^>]+id="agent-status"[^>]*>([\s\S]*?)<\//);
    assert.ok(visibleStatus, "Every page must include the fallback status before JavaScript runs");
    assert.match(visibleStatus[1], /out of API credits/);
    assert.match(visibleStatus[1], /live agents.*unavailable/i);
    assert.match(visibleStatus[1], /three seats are simulated/i);
    assert.match(servedPage.slice(servedPage.indexOf("<body>"), servedPage.indexOf("<script>")), /not a judged Band run/i);
  }

  const available = await call("GET", `/availability?restaurant_id=r_late&date=${day}&party_size=2`);
  assert.equal(available.status, 200);
  assert.ok(available.body.slots.find((slot) => slot.starts_at_local === at("17:00")).available_table_ids.includes("t_window"));
  const signup = await call("POST", "/auth/signup", {
    email: "key-free@example.test", password: "disposable-fallback-password", display_name: "Demo diner",
  });
  assert.equal(signup.status, 201);
  const login = await call("POST", "/auth/login", {
    email: "key-free@example.test", password: "disposable-fallback-password",
  });
  assert.equal(login.status, 200);
  const auth = { authorization: `Bearer ${login.body.token}` };
  const created = await call("POST", "/reservations", {
    restaurant_id: "r_late", table_id: "t_window", party_size: 2, starts_at_local: at("17:00"),
  }, { ...auth, "idempotency-key": "key-free-booking" });
  assert.equal(created.status, 201);
  const path = `/reservations/${created.body.reference}`;
  const moved = await call("PATCH", path, {
    table_id: "t_banquette", party_size: 3, starts_at_local: at("19:00"), expected_revision: created.body.revision,
  }, auth);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.starts_at_local, at("19:00"));
  assert.equal(moved.body.table_id, "t_banquette");
  const cancelled = await call("POST", `${path}/cancel`, undefined, auth);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal((await call("GET", path, undefined, auth)).body.status, "cancelled");
  assert.equal(outboundCalls, 0, "Fallback actions must never attempt an external provider call");
});
