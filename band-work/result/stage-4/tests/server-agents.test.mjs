import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const fakeKey = "server-test-placeholder-only";
const configured = {
  BAND_API_KEY: fakeKey,
  BAND_AGENT_URL: "https://provider.example.test/chat/completions",
  BAND_AGENT_MODEL: "test-model",
};
const creditNotice = "The site is out of API credits. Live agents are unavailable; all three seats are simulated.";
const day = "2035-01-08";

// Exercise the actual server adapter with streams and IPC, without opening a
// socket. All provider traffic is mocked, and the child has a clean environment.
async function server(t, env, provider = "success") {
  const serverModule = new URL("../src/server.mjs", import.meta.url).href;
  const bootstrap = `
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    import tls from 'node:tls';
    import { Readable } from 'node:stream';
    import { syncBuiltinESMExports } from 'node:module';
    const noOutbound = () => {
      process.send({ kind: 'outbound' });
      throw new Error('Outbound network is forbidden in tests');
    };
    http.request = http.get = https.request = https.get = noOutbound;
    net.connect = net.createConnection = tls.connect = noOutbound;
    syncBuiltinESMExports();
    const provider = ${JSON.stringify(provider)};
    globalThis.fetch = async (url, options) => {
      const payload = JSON.parse(options.body);
      const role = payload.messages[0].content.match(/You are the (\\w+) seat/)[1];
      const input = JSON.parse(payload.messages[1].content);
      process.send({ kind: 'provider', role, input,
        requestValid: url === 'https://provider.example.test/chat/completions'
          && options.headers.authorization === 'Bearer ' + ${JSON.stringify(fakeKey)}
          && options.headers['api-key'] === ${JSON.stringify(fakeKey)}
          && payload.max_completion_tokens === 600 && payload.reasoning_effort === 'minimal'
          && !('max_tokens' in payload)
          && payload.model === 'test-model' && options.redirect === 'error'
          && !options.body.includes(${JSON.stringify(fakeKey)}) });
      if (provider === 'network') throw new Error('Mocked provider failure');
      if (provider === 'credits') return { ok: false, status: 429,
        json: async () => ({ error: { code: 'insufficient_quota' } }) };
      if (provider === 'plain402') return { ok: false, status: 402,
        json: async () => { throw new SyntaxError('Non-JSON payment required'); } };
      return { ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: role + ' provider response' } }] }) };
    };
    http.Server.prototype.listen = function (...args) {
      process.on('message', (message) => {
        if (message.kind !== 'request') return;
        const req = Readable.from([Buffer.from(message.body || '')]);
        req.method = message.method;
        req.url = message.path;
        req.headers = message.headers;
        const res = {
          writableEnded: false, destroyed: false, status: 200, headers: {},
          writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
          end(body) {
            this.writableEnded = true;
            process.send({ kind: 'response', id: message.id, status: this.status,
              headers: this.headers, body: String(body || '') });
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
    env: { DEMO: "1", PORT: "0", ...env },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const providerCalls = [];
  let outbound = 0;
  child.on("message", (message) => {
    if (message.kind === "provider") providerCalls.push(message);
    if (message.kind === "outbound") outbound++;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server adapter did not become ready")), 5_000);
    child.on("message", (message) => { if (message.kind === "ready") { clearTimeout(timer); resolve(); } });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Server adapter could not start")); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Server adapter exited before ready")); });
  });
  let nextId = 0;
  async function dispatch(method, path, body, headers = {}) {
    const response = await new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        child.off("message", receive);
        reject(new Error("Server adapter did not respond"));
      }, 3_000);
      function receive(message) {
        if (message.kind !== "response" || message.id !== id) return;
        clearTimeout(timer);
        child.off("message", receive);
        resolve(message);
      }
      child.on("message", receive);
      child.send({ kind: "request", id, method, path, headers, body: body === undefined ? "" : JSON.stringify(body) });
    });
    assert.ok(!JSON.stringify(response).includes(fakeKey), "Responses and HTML must never include provider credentials");
    return response;
  }
  return {
    dispatch, providerCalls,
    assertNoOutbound: () => assert.equal(outbound, 0),
    async call(...args) {
      const response = await dispatch(...args);
      const header = response.headers["x-nightshift-agents"];
      return { ...response, body: JSON.parse(response.body), trace: header ? JSON.parse(decodeURIComponent(header)) : null };
    },
  };
}

async function assertPages(app, mode) {
  for (const route of ["/", "/login", "/signup", "/lookup"]) {
    const response = await app.dispatch("GET", route);
    assert.equal(response.status, 200);
    const status = response.body.match(/<p[^>]*id="agent-status"[^>]*>([^<]*)</)?.[1];
    assert.ok(status);
    if (mode === "simulated") assert.equal(status, creditNotice);
    else {
      assert.match(status, /Live agents are configured/);
      assert.notEqual(status, creditNotice);
    }
    const initialState = JSON.parse(response.body.match(/const initialAgentState = (\{[^;]+\});/)[1]);
    assert.equal(initialState.mode, mode);
    const visible = response.body.slice(response.body.indexOf("<body>"), response.body.indexOf("<script>"));
    assert.match(visible, /not a judged Band run/);
    if (mode === "live") assert.ok(!visible.includes(creditNotice));
  }
}

for (const [label, env] of [
  ["present", { BAND_API_KEY: fakeKey }], ["absent", {}],
  ["empty", { BAND_API_KEY: "" }], ["whitespace", { BAND_API_KEY: " \t " }],
]) {
  test(`server pages: ${label} provider key selects the correct initial banner`, { timeout: 10_000 }, async (t) => {
    const app = await server(t, env);
    await assertPages(app, label === "present" ? "live" : "simulated");
    assert.equal(app.providerCalls.length, 0);
    app.assertNoOutbound();
  });
}

for (const [label, env, provider, mode, reason] of [
  ["missing key", {}, "success", "simulated", "missing_key"],
  ["live provider", configured, "success", "live", null],
  ["exhausted credits", configured, "credits", "simulated", "credits"],
  ["non-JSON exhausted credits", configured, "plain402", "simulated", "credits"],
  ["provider network failure", configured, "network", "simulated", "provider_error"],
]) {
  test(`server actions: search, book, move and cancel work with ${label}`, { timeout: 15_000 }, async (t) => {
    const app = await server(t, env, provider);
    const actions = [];
    function assertTrace(response, action) {
      actions.push(action);
      assert.equal(response.trace?.mode, mode);
      assert.equal(response.trace.reason, reason);
      assert.ok(!Object.hasOwn(response.body, "agents"), "Agent metadata must not change reservation API bodies");
      if (mode === "live") assert.deepEqual(response.trace.seats.map((seat) => seat.role), ["coordinator", "implementer", "reviewer"]);
      else assert.equal(response.trace.seats, undefined, "Simulation metadata must not claim a provider response");
    }
    const available = await app.call("GET", `/availability?restaurant_id=r_late&date=${day}&party_size=2`);
    assert.equal(available.status, 200);
    assert.ok(available.body.slots.find((slot) => slot.starts_at_local === `${day}T17:00`).available_table_ids.includes("t_window"));
    assertTrace(available, "search");
    assert.equal((await app.call("POST", "/auth/signup", {
      email: "mode-test@example.test", password: "disposable-test-password", display_name: "Test diner",
    })).status, 201);
    const login = await app.call("POST", "/auth/login", {
      email: "mode-test@example.test", password: "disposable-test-password",
    });
    assert.equal(login.status, 200);
    assert.equal(login.trace, null);
    const auth = { authorization: `Bearer ${login.body.token}` };
    const created = await app.call("POST", "/reservations", {
      restaurant_id: "r_late", table_id: "t_window", party_size: 2, starts_at_local: `${day}T17:00`,
    }, { ...auth, "idempotency-key": "mode-booking" });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "confirmed");
    assertTrace(created, "book");
    const path = `/reservations/${created.body.reference}`;
    const moved = await app.call("PATCH", path, {
      table_id: "t_banquette", party_size: 3, starts_at_local: `${day}T19:00`, expected_revision: created.body.revision,
    }, auth);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.table_id, "t_banquette");
    assert.equal(moved.body.starts_at_local, `${day}T19:00`);
    assert.equal(moved.body.revision, created.body.revision + 1);
    assertTrace(moved, "move");
    const cancelled = await app.call("POST", `${path}/cancel`, undefined, auth);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assertTrace(cancelled, "cancel");
    const stored = await app.call("GET", path, undefined, auth);
    assert.deepEqual(stored.body, cancelled.body);
    assert.equal(stored.trace, null);
    const history = await app.call("GET", `${path}/history`, undefined, auth);
    assert.deepEqual(history.body.entries.map((entry) => entry.event), ["created", "changed", "cancelled"]);
    if (reason === "credits") {
      await assertPages(app, "simulated");
      assert.equal(app.providerCalls.length, 3, "Exhausted credits must latch local simulation after the first parallel seat calls");
    } else if (reason === "missing_key") {
      assert.equal(app.providerCalls.length, 0, "Simulated actions stay local");
    } else if (mode === "live") {
      await assertPages(app, "live");
      assert.equal(app.providerCalls.length, 12);
      assert.deepEqual(app.providerCalls.map((call) => call.input), actions.flatMap((action) =>
        Array.from({ length: 3 }, () => ({ action, outcome: "succeeded" }))));
    } else assert.equal(app.providerCalls.length, 12, "Transient failures must not permanently disable the provider");
    assert.ok(app.providerCalls.every((call) => call.requestValid));
    app.assertNoOutbound();
  });
}
