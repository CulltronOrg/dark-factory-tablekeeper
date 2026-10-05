import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

// Run the shipped mode/trace code with a minimal DOM. These checks make no
// network calls and neither inherit nor inspect provider environment values.
const page = readFileSync(new URL("../src/app.html", import.meta.url), "utf8");
const initial = 'const initialAgentState = { mode: "simulated", reason: "missing_key" };';
const modeStart = page.indexOf(initial);
const modeEnd = page.indexOf("    function field(", modeStart);
const readerStart = page.indexOf("    async function readJson(");
const readerEnd = page.indexOf("    function el(", readerStart);
assert.ok(modeStart >= 0 && modeEnd > modeStart);
assert.ok(readerStart >= 0 && readerEnd > readerStart);
const shippedCode = page.slice(modeStart, modeEnd) + page.slice(readerStart, readerEnd);
const creditStatus = "The site is out of API credits. Live agents are unavailable; all three seats are simulated.";
const roles = ["coordinator", "implementer", "reviewer"];
const liveState = {
  mode: "live", reason: null,
  seats: roles.map((role) => ({ role, text: `${role} provider response` })),
};
const booking = { reference: "LOCAL-TEST", status: "confirmed" };

class Element {
  constructor(text = "") {
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this._text = text;
    this.parent = null;
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(" "); }
  set textContent(text) { this.replaceChildren(); this._text = String(text); }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren() {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this._text = "";
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

function setup(mode = "simulated") {
  const nodes = new Map(["agent-status", "agent-details", "agent-panel", "agent-trace"].map((id) => [id, new Element()]));
  const context = createContext({
    document: { getElementById: (id) => nodes.get(id) },
    el: (_tag, _className, text) => new Element(text),
  });
  const source = mode === "live"
    ? shippedCode.replace(initial, 'const initialAgentState = { mode: "live", reason: null };')
    : shippedCode;
  runInContext(source, context);
  return {
    status: () => nodes.get("agent-status").textContent,
    details: () => nodes.get("agent-details").textContent,
    begin: (action) => runInContext("beginAction", context)(action),
    read: (response) => runInContext("readJson", context)(response),
    trace(action) {
      const node = nodes.get("agent-trace").children.find((child) => child.dataset.action === action);
      assert.ok(node, `Expected an agent trace for ${action}`);
      return node.textContent;
    },
    traceCount: () => nodes.get("agent-trace").children.length,
  };
}

function response(state, body = booking) {
  return {
    ok: true,
    headers: { get: () => state === undefined ? null : encodeURIComponent(JSON.stringify(state)) },
    json: async () => body,
  };
}

function assertSimulated(app, action) {
  const trace = app.trace(action);
  assert.match(trace, /Coordinator \(simulated\) — planned:/);
  assert.match(trace, /Implementer \(simulated\) — done:/);
  assert.match(trace, /Reviewer \(simulated\) — checked:/);
  assert.doesNotMatch(trace, /\(live\)/);
}

test("agent UI: missing-key mode shows the exact credits banner and local traces", () => {
  const app = setup();
  assert.equal(app.status(), creditStatus);
  assert.match(app.details(), /No external agent API is called for simulated traces/);
  assert.match(app.details(), /not a judged Band run/);
  for (const action of ["search", "book", "move", "cancel"]) {
    const body = action === "search" ? { slots: [] }
      : { ...booking, status: action === "cancel" ? "cancelled" : "confirmed" };
    app.begin(action).complete(response(undefined, body), body);
    assertSimulated(app, action);
  }
});

test("agent UI: live configuration avoids the credit banner and shows actual seat responses", () => {
  const app = setup("live");
  assert.doesNotMatch(app.status(), /out of API credits/);
  const trace = app.begin("book");
  assert.match(app.trace("book"), /waiting for live agents/);
  trace.complete(response(liveState), booking);
  for (const role of roles) assert.ok(app.trace("book").includes(`(live) — ${role} provider response`));
  assert.doesNotMatch(app.trace("book"), /simulated|planned:|done:|checked:/);
  assert.match(app.details(), /not a judged Band run/);
});

test("agent UI: missing or malformed metadata leaves live responses unconfirmed", async () => {
  for (const providerResponse of [
    response(),
    { ...response(), headers: { get: () => "%not-json" } },
    { ...response(), headers: { get: () => { throw new Error("Unreadable headers"); } } },
    response({ mode: "live", seats: [{ role: "coordinator", text: "Incomplete output" }] }),
  ]) {
    const app = setup("live");
    assert.deepEqual(await app.read(providerResponse), booking);
    assert.doesNotThrow(() => app.begin("book").complete(providerResponse, booking));
    assert.match(app.trace("book"), /agent responses unconfirmed/);
    assert.doesNotMatch(app.trace("book"), /simulated|planned:|done:|checked:/);
    assert.doesNotMatch(app.status(), /out of API credits/);
  }
});

test("agent UI: exhausted credits replace pending live agents with local simulation", () => {
  const app = setup("live");
  app.begin("book").complete(response({ mode: "simulated", reason: "credits" }), booking);
  assert.equal(app.status(), creditStatus);
  assertSimulated(app, "book");
});

test("agent UI: temporary provider failures can recover to live responses", () => {
  const app = setup("live");
  app.begin("book").complete(response({ mode: "simulated", reason: "provider_error" }), booking);
  assert.match(app.status(), /temporarily unavailable/);
  assert.doesNotMatch(app.status(), /out of API credits/);
  assertSimulated(app, "book");
  app.begin("move").complete(response(liveState), booking);
  assert.match(app.status(), /Live agents are configured/);
  assert.match(app.trace("move"), /Coordinator \(live\) — coordinator provider response/);
  assert.doesNotMatch(app.trace("move"), /simulated/);
});

test("agent UI: background responses update credits before body parsing and stale live replies cannot reset them", async () => {
  const app = setup("live");
  const earlierAction = app.begin("move");
  let finishBody;
  const backgroundResponse = {
    ...response({ mode: "simulated", reason: "credits" }),
    json: () => new Promise((resolve) => { finishBody = resolve; }),
  };
  const reading = app.read(backgroundResponse);
  assert.equal(app.status(), creditStatus);
  assert.equal(app.traceCount(), 1, "A background refresh must not manufacture an action trace");
  finishBody({ slots: [] });
  assert.equal((await reading).slots.length, 0);

  await app.read(response(liveState));
  earlierAction.complete(response(liveState), booking);
  assert.equal(app.status(), creditStatus);
  assert.match(app.trace("move"), /Coordinator \(live\) — coordinator provider response/);
  app.begin("book").complete(response(), booking);
  assertSimulated(app, "book");
});
