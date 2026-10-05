import assert from "node:assert/strict";
import test from "node:test";
import { agentPresentation, createAgents } from "../src/agents.mjs";

// Deliberately fake credentials; never inspect or inherit provider credentials.
const fakeKey = "unit-test-placeholder-only";
const configured = {
  BAND_API_KEY: fakeKey,
  BAND_AGENT_URL: "https://provider.example.test/chat/completions",
  BAND_AGENT_MODEL: "test-model",
};
const creditNotice = "The site is out of API credits. Live agents are unavailable; all three seats are simulated.";
const result = { status: 200, body: { private_diner_information: "must-stay-local" } };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

for (const [label, env] of [
  ["absent", {}], ["empty", { BAND_API_KEY: "" }], ["whitespace", { BAND_API_KEY: " \t\n " }],
]) {
  test(`provider key ${label}: every action stays local with the exact credit notice`, async () => {
    let calls = 0;
    const agents = createAgents({ env, fetchProvider: async () => { calls++; throw new Error("No provider call allowed"); } });
    assert.deepEqual(agents.state(), { mode: "simulated", reason: "missing_key" });
    assert.equal(agentPresentation(agents.state()).status, creditNotice);
    for (const action of ["search", "book", "move", "cancel"]) {
      assert.deepEqual(await agents.run(action, result), { mode: "simulated", reason: "missing_key" });
    }
    assert.equal(calls, 0);
    assert.match(agentPresentation(agents.state()).details, /simulated locally/);
    assert.match(agentPresentation(agents.state()).details, /not a judged Band run/);
  });
}

test("a key alone configures live mode without forcing the out-of-credits notice", async () => {
  let calls = 0;
  const agents = createAgents({
    env: { BAND_API_KEY: fakeKey },
    fetchProvider: async () => { calls++; throw new Error("No configured endpoint"); },
  });
  assert.deepEqual(agents.state(), { mode: "live", reason: null });
  assert.doesNotMatch(agentPresentation(agents.state()).status, /out of API credits/);
  const trace = await agents.run("book", result);
  assert.deepEqual(trace, { mode: "simulated", reason: "provider_error" });
  assert.doesNotMatch(agentPresentation(trace).status, /out of API credits/);
  assert.equal(calls, 0);
});

test("live actions call all three seats with only action and outcome", async () => {
  const calls = [];
  const agents = createAgents({
    env: configured,
    fetchProvider: async (url, options) => {
      const payload = JSON.parse(options.body);
      const role = payload.messages[0].content.match(/You are the (\w+) seat/)[1];
      calls.push({ url, options, payload, role });
      return reply(200, { choices: [{ message: { content: `${role} provider response` } }] });
    },
  });
  for (const [index, action] of ["search", "book", "move", "cancel"].entries()) {
    const trace = await agents.run(action, result);
    assert.equal(trace.mode, "live");
    assert.equal(trace.reason, null);
    assert.deepEqual(trace.seats.map((seat) => seat.role), ["coordinator", "implementer", "reviewer"]);
    assert.ok(trace.seats.every((seat) => seat.text === `${seat.role} provider response`));
    assert.ok(!JSON.stringify(trace).includes(fakeKey));
    for (const call of calls.slice(index * 3, index * 3 + 3)) {
      assert.equal(call.url, configured.BAND_AGENT_URL);
      assert.equal(call.options.headers["api-key"], fakeKey);
      assert.equal(call.options.headers.authorization, `Bearer ${fakeKey}`);
      assert.equal(call.options.headers["content-type"], "application/json");
      assert.equal(call.payload.max_completion_tokens, 600);
      assert.equal(call.payload.reasoning_effort, "minimal");
      assert.ok(!Object.hasOwn(call.payload, "max_tokens"), "Reasoning models reject max_tokens");
      assert.equal(call.options.method, "POST");
      assert.equal(call.options.redirect, "error");
      assert.equal(call.payload.model, configured.BAND_AGENT_MODEL);
      assert.deepEqual(JSON.parse(call.payload.messages[1].content), { action, outcome: "succeeded" });
      assert.ok(!call.options.body.includes("must-stay-local"));
      assert.ok(!call.options.body.includes(fakeKey));
    }
  }
  assert.equal(calls.length, 12);
});

for (const [label, response] of [
  ["402 JSON", () => reply(402, { error: { message: "Payment required" } })],
  ["402 non-JSON", () => ({ ok: false, status: 402, json: async () => { throw new SyntaxError("Not JSON"); } })],
  ["429 insufficient_quota", () => reply(429, { error: { code: "insufficient_quota" } })],
]) {
  test(`${label} latches credit fallback and stops further provider calls`, async () => {
    let calls = 0;
    const agents = createAgents({ env: configured, fetchProvider: async () => { calls++; return response(); } });
    const fallback = await agents.run("book", result);
    assert.deepEqual(fallback, { mode: "simulated", reason: "credits" });
    assert.equal(agentPresentation(fallback).status, creditNotice);
    for (const action of ["search", "book", "move", "cancel"]) assert.deepEqual(await agents.run(action, result), fallback);
    assert.deepEqual(agents.state(), fallback);
    assert.equal(calls, 3, "Only the first action's three parallel seat calls reach the provider");
  });
}

for (const [label, failure] of [
  ["normal 429 rate limit", async () => reply(429, { error: { code: "rate_limit_exceeded", message: "Too many requests" } })],
  ["network exception", async () => { throw new Error("Provider unavailable"); }],
  ["malformed response", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Not JSON"); } })],
  ["credential echo", async () => reply(200, { choices: [{ message: { content: fakeKey } }] })],
  ["timeout", async () => new Promise(() => {})],
]) {
  test(`${label} falls back without claiming credit exhaustion and can recover`, async () => {
    let fail = true;
    const agents = createAgents({
      env: configured, timeoutMs: 25,
      fetchProvider: async () => fail ? failure() : reply(200, { choices: [{ message: { content: "Provider recovered" } }] }),
    });
    const trace = await agents.run("book", result);
    assert.deepEqual(trace, { mode: "simulated", reason: "provider_error" });
    assert.doesNotMatch(agentPresentation(trace).status, /out of API credits/);
    assert.ok(!JSON.stringify(trace).includes(fakeKey));
    assert.deepEqual(agents.state(), { mode: "live", reason: null });
    fail = false;
    assert.equal((await agents.run("move", result)).mode, "live");
  });
}

const seatOf = (options) => JSON.parse(options.body).messages[0].content.match(/You are the (\w+) seat/)[1];
const ok = (options) => reply(200, { choices: [{ message: { content: `${seatOf(options)} provider response` } }] });

test("the three seats are requested in parallel and keep their order", async () => {
  const pending = [];
  const agents = createAgents({
    env: configured,
    fetchProvider: (_url, options) => new Promise((resolve) => pending.push({ role: seatOf(options), resolve: () => resolve(ok(options)) })),
  });
  const running = agents.run("book", result);
  for (let i = 0; i < 10 && pending.length < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 3, "All three seats must be in flight before any answers");
  assert.deepEqual(pending.map((call) => call.role).sort(), ["coordinator", "implementer", "reviewer"]);
  for (const call of [...pending].reverse()) call.resolve();
  const trace = await running;
  assert.equal(trace.mode, "live");
  assert.deepEqual(trace.seats.map((seat) => seat.role), ["coordinator", "implementer", "reviewer"]);
});

test("the default per-action deadline is fifteen seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const answers = [];
  const agents = createAgents({
    env: configured,
    fetchProvider: (_url, options) => new Promise((resolve) => answers.push(() => resolve(ok(options)))),
  });
  const running = agents.run("search", result);
  for (let i = 0; i < 10 && answers.length < 3; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(14_000);
  for (const answer of answers) answer();
  assert.equal((await running).mode, "live", "Answers after 5 seconds but before 15 seconds stay live");
  const slow = createAgents({ env: configured, fetchProvider: () => new Promise(() => {}) });
  const late = slow.run("search", result);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(15_000);
  assert.deepEqual(await late, { mode: "simulated", reason: "provider_error" });
});

for (const [label, error, expected] of [
  ["max_completion_tokens", { message: "Unrecognized request argument supplied: max_completion_tokens", type: "invalid_request_error", param: "max_completion_tokens", code: "unsupported_parameter" }, { max_tokens: 100 }],
  ["reasoning_effort", { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model.", type: "invalid_request_error", param: "reasoning_effort", code: "unsupported_parameter" }, { max_completion_tokens: 600 }],
]) {
  test(`400 unsupported ${label} retries each seat once with the older shape and never claims credits`, async () => {
    const calls = [];
    const agents = createAgents({
      env: configured,
      fetchProvider: async (_url, options) => {
        const payload = JSON.parse(options.body);
        calls.push({ options, payload });
        if (Object.hasOwn(payload, label)) return reply(400, { error });
        return ok(options);
      },
    });
    const trace = await agents.run("book", result);
    assert.equal(trace.mode, "live");
    assert.deepEqual(trace.seats.map((seat) => seat.role), ["coordinator", "implementer", "reviewer"]);
    assert.equal(calls.length, 6, "One retry per seat");
    for (const { options, payload } of calls.filter((call) => !Object.hasOwn(call.payload, label))) {
      assert.ok(!Object.hasOwn(payload, "reasoning_effort"));
      for (const [name, value] of Object.entries(expected)) assert.equal(payload[name], value);
      if (!expected.max_completion_tokens) assert.ok(!Object.hasOwn(payload, "max_completion_tokens"));
      assert.equal(options.headers["api-key"], fakeKey);
      assert.ok(!options.body.includes(fakeKey));
    }
    assert.deepEqual(agents.state(), { mode: "live", reason: null });
  });
}

test("a 400 unsupported parameter that persists after the retry is a provider error, not credits", async () => {
  let calls = 0;
  const agents = createAgents({
    env: configured,
    fetchProvider: async () => { calls++; return reply(400, { error: { message: "max_completion_tokens is not supported; quota exceeded for billing", code: "unsupported_parameter" } }); },
  });
  assert.deepEqual(await agents.run("book", result), { mode: "simulated", reason: "provider_error" });
  assert.equal(calls, 6, "Each seat retries exactly once");
  assert.deepEqual(agents.state(), { mode: "live", reason: null });
  assert.doesNotMatch(agentPresentation(agents.state()).status, /out of API credits/);
});

test("a 401 with both headers retries once with only the api-key header", async () => {
  const calls = [];
  const agents = createAgents({
    env: configured,
    fetchProvider: async (_url, options) => {
      calls.push(options.headers);
      if (options.headers.authorization) return reply(401, { error: { code: "401", message: "Invalid token" } });
      return ok(options);
    },
  });
  const trace = await agents.run("cancel", result);
  assert.equal(trace.mode, "live");
  assert.equal(calls.length, 6);
  assert.equal(calls.filter((headers) => !headers.authorization && headers["api-key"] === fakeKey).length, 3);
  assert.ok(!JSON.stringify(trace).includes(fakeKey));
});

test("empty content (reasoning used the whole budget) is a provider error, not credits", async () => {
  const agents = createAgents({
    env: configured,
    fetchProvider: async () => reply(200, { choices: [{ finish_reason: "length", message: { content: "" } }] }),
  });
  assert.deepEqual(await agents.run("search", result), { mode: "simulated", reason: "provider_error" });
  assert.deepEqual(agents.state(), { mode: "live", reason: null });
});

test("credit exhaustion on one parallel seat latches the credit fallback", async () => {
  let calls = 0;
  const agents = createAgents({
    env: configured,
    fetchProvider: async (_url, options) => {
      calls++;
      return seatOf(options) === "implementer" ? reply(429, { error: { code: "insufficient_quota" } }) : ok(options);
    },
  });
  assert.deepEqual(await agents.run("book", result), { mode: "simulated", reason: "credits" });
  const before = calls;
  assert.deepEqual(await agents.run("move", result), { mode: "simulated", reason: "credits" });
  assert.equal(calls, before, "No provider calls after credits are exhausted");
});
