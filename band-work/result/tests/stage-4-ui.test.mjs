import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script, createContext } from "node:vm";
import { createService } from "../stage-4/src/engine.mjs";

// Executes the shipped page script with a small DOM adapter and the real service.
// These are in-process interaction tests, not browser, CSS/layout or HTTP tests.
// Run with BAND_API_KEY unset. Disposable credentials and sessions stay in memory.
const page = readFileSync(new URL("../stage-4/src/app.html", import.meta.url), "utf8");
const script = new Script(page.match(/<script>([\s\S]*?)<\/script>/)[1], { filename: "stage-4/src/app.html" });
const day = "2035-01-08";
const password = "disposable-ui-password";
const settle = () => new Promise((resolve) => setImmediate(resolve));
const dataKey = (name) => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this._text = "";
    this._value = undefined;
    this.classList = {
      add: (name) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(" "); },
      remove: (name) => { this.className = this.className.split(/\s+/).filter((value) => value !== name).join(" "); },
    };
  }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get options() { return this.children.filter((child) => child.tagName === "OPTION"); }
  get value() { return this._value ?? (this.tagName === "SELECT" ? this.options[0]?.value || "" : ""); }
  set value(value) { this._value = String(value); }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = "";
    if (this.tagName === "SELECT") this._value = undefined;
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) {
    if (name.startsWith("data-")) this.dataset[dataKey(name)] = String(value);
    else this.attributes.set(name, String(value));
  }
  getAttribute(name) { return name.startsWith("data-") ? this.dataset[dataKey(name)] ?? null : this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  matches(selector) {
    if (/^[a-z]+$/i.test(selector)) return this.tagName.toLowerCase() === selector.toLowerCase();
    if (/^(\.[\w-]+)+$/.test(selector)) return selector.slice(1).split(".").every((name) => this.className.split(/\s+/).includes(name));
    const attr = selector.match(/^\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\]$/);
    if (attr) return attr[2] === undefined ? this.getAttribute(attr[1]) !== null : this.getAttribute(attr[1]) === attr[2];
    throw new Error(`DOM adapter does not implement selector: ${selector}`);
  }
  querySelectorAll(selector) {
    const options = selector.split(",").map((part) => part.trim());
    return this.children.flatMap((child) => [
      ...(options.some((option) => child.matches(option)) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  dispatchEvent(event) {
    event.target = this;
    event.preventDefault ||= () => { event.defaultPrevented = true; };
    for (const callback of this.listeners.get(event.type) || []) callback(event);
    this[`on${event.type}`]?.(event);
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    const defaultAllowed = this.dispatchEvent({ type: "click" });
    if (defaultAllowed && this.tagName === "BUTTON" && this.type === "submit") {
      let form = this.parentElement;
      while (form && form.tagName !== "FORM") form = form.parentElement;
      form?.dispatchEvent({ type: "submit" });
    }
  }
  focus() {}
  scrollIntoView() {}
}

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

function request(service, method, path, body, headers = {}, query = {}) {
  return service.handle(method, path, query, headers, body === undefined ? "" : JSON.stringify(body));
}

function setup() {
  const service = createService(4);
  assert.equal(request(service, "POST", "/_test/reset", {
    users: [], reservations: [],
    restaurants: [{
      id: "ui-demo", name: "UI demo restaurant", timezone: "Europe/Berlin",
      slot_minutes: 30, reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120,
      opening_hours: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((weekday) => ({ weekday, opens: "17:00", closes: "23:00" })),
      tables: [{ id: "window", label: "Window", capacity: 2 }, { id: "banquette", label: "Banquette", capacity: 4 }],
      combinable: [["window", "banquette"]],
    }],
  }).status, 204);
  const localStorage = storage();
  const sessionStorage = storage();
  const requests = [];
  const responses = [];
  function authorized(method, path, body, headers = {}) {
    const session = JSON.parse(localStorage.getItem("nightshift.session"));
    return request(service, method, path, body, { ...headers, authorization: `Bearer ${session.token}` });
  }
  return {
    service, requests, authorized,
    failNext(method, path, response) { responses.push({ method, path, response }); },
    bookings() {
      const result = authorized("GET", "/reservations");
      assert.equal(result.status, 200);
      return result.body.reservations;
    },
    async open(path) {
      const location = new URL(path, "http://local.test");
      const document = new Element("document");
      document.createElement = (tag) => new Element(tag);
      // The static shell nodes the inline script expects; layout is not modeled.
      for (const id of ["view", "who", "account-link", "agent-status", "agent-trace"]) {
        const markup = page.match(new RegExp(`<([a-z]+)([^>]*\\bid="${id}"[^>]*)>([\\s\\S]*?)<\\/\\1>`));
        assert.ok(markup, `Expected static shell node ${id}`);
        const node = new Element(markup[1]);
        node.id = id;
        for (const [, name, value] of markup[2].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(name, value);
        node.textContent = markup[3].replace(/<[^>]*>/g, "");
        document.append(node);
      }
      document.getElementById = (id) => {
        const walk = (node) => node.id === id ? node : node.children.map(walk).find(Boolean);
        return walk(document);
      };
      const window = new Element("window");
      script.runInContext(createContext({
        document, window, location, localStorage, sessionStorage, URLSearchParams,
        crypto: { randomUUID },
        CustomEvent: class { constructor(type) { this.type = type; } },
        history: { replaceState: (_state, _title, url) => { location.href = new URL(url, location).href; } },
        fetch: async (path, options = {}) => {
          const url = new URL(path, location);
          assert.equal(url.origin, location.origin, "The simulated agents must never call an external API");
          const method = options.method || "GET";
          requests.push({ method, path: url.pathname });
          const failure = responses.findIndex((item) => item.method === method && item.path === url.pathname);
          const result = failure >= 0 ? responses.splice(failure, 1)[0].response
            : service.handle(method, url.pathname, Object.fromEntries(url.searchParams), options.headers || {}, options.body || "");
          if (result instanceof Error) throw result;
          return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => structuredClone(result.body) };
        },
      }));
      await settle();
      return {
        document, location,
        get(id) {
          const node = document.querySelector(`[data-testid='${id}']`);
          assert.ok(node, `Expected rendered control ${id}`);
          return node;
        },
        async input(id, value) {
          const node = this.get(id);
          node.value = value;
          node.dispatchEvent({ type: "input" });
          await settle();
        },
        async click(node) {
          if (typeof node === "string") node = this.get(node);
          assert.ok(node, "Expected control to click");
          assert.equal(node.disabled, false, "Control must be enabled");
          for (let parent = node; parent; parent = parent.parentElement) assert.equal(parent.hidden, false, "Control must be visible");
          node.click();
          await settle();
        },
      };
    },
  };
}

async function selectAndAuthenticate(app, mode) {
  let ui = await app.open("/");
  await ui.input("date-input", day);
  await ui.click("search-button");
  await ui.click("slot-window-17:00");
  assert.match(ui.get("booking-summary").textContent, /Window/);
  const link = ui.get("booking-form").querySelectorAll("a").find((node) => node.href.startsWith(`/${mode}?`));
  assert.ok(link, `Selected table offers ${mode}`);
  ui = await app.open(link.href);
  await ui.input(`${mode}-email`, "diner@example.test");
  await ui.input(`${mode}-password`, password);
  if (mode === "signup") await ui.input("signup-display-name", "UI diner");
  await ui.click(`${mode}-submit`);
  assert.ok(ui.get("auth-success"));
  const resume = ui.document.querySelectorAll("a").find((node) => node.textContent === "Continue your reservation");
  assert.ok(resume, "Authentication offers to continue the selected reservation");
  ui = await app.open(resume.href);
  assert.equal(ui.get("date-input").value, day);
  assert.equal(ui.get("party-size-input").value, "2");
  assert.match(ui.get("booking-summary").textContent, /Window/);
  assert.equal(ui.get("slot-window-17:00").getAttribute("aria-pressed"), "true");
  await ui.click("booking-submit");
  assert.ok(ui.get("confirmation-reference").textContent);
  assert.match(ui.get("confirmation-details").textContent, /until 18:30/, "Booking end time must use Europe/Berlin, not UTC");
  assert.equal(app.bookings().length, 1);
  assert.equal(app.bookings()[0].starts_at_local, `${day}T17:00`);
  assert.equal(app.bookings()[0].table_id, "window");
  return ui;
}

function assertSimulatedAction(ui, action) {
  const status = ui.get("agent-status");
  assert.match(status.textContent, /out of API credits/);
  assert.match(status.textContent, /live agents.*unavailable/i);
  const trace = ui.get(`agent-trace-${action}`);
  for (let node = trace; node; node = node.parentElement) assert.equal(node.hidden, false, "The simulated trace must be visible");
  assert.match(trace.textContent, /coordinator\s*\(simulated\).*planned:/i);
  assert.match(trace.textContent, /implementer\s*\(simulated\).*done:/i);
  assert.match(trace.textContent, /reviewer\s*\(simulated\).*checked:/i);
}

test("stage 4 UI fallback: no provider key, visible credit status and three simulated seats for search, book, move and cancel", async () => {
  // The page runs without a provider configuration or a key-bearing environment.
  // Its fetch adapter permits only same-origin calls into the local booking service.
  const app = setup();
  let ui = await app.open("/");
  await ui.input("date-input", day);
  await ui.click("search-button");
  assert.ok(ui.get("slot-window-17:00"));
  assertSimulatedAction(ui, "search");

  ui = await selectAndAuthenticate(app, "signup");
  assertSimulatedAction(ui, "book");
  const original = app.bookings()[0];
  ui = await app.open(`/lookup?ref=${original.reference}`);
  await ui.input("change-time", "19:00");
  await ui.click("change-submit");
  assert.equal(app.bookings()[0].starts_at_local, `${day}T19:00`);
  assertSimulatedAction(ui, "move");

  await ui.click("reservation-cancel-button");
  await ui.click("reservation-cancel-button");
  assert.equal(app.bookings()[0].status, "cancelled");
  assertSimulatedAction(ui, "cancel");
  assert.match(page.slice(page.indexOf("<body>"), page.indexOf("<script>")), /not a judged Band run/i);
});

test("stage 4 UI script: signup keeps table; book, find without reference, move, keep and cancel", async () => {
  const app = setup();
  await selectAndAuthenticate(app, "signup");
  let ui = await app.open("/lookup");
  assert.equal(ui.get("lookup-reference-input").value, "");
  const card = ui.get("booking-card");
  assert.match(card.textContent, /UI demo restaurant/);
  assert.match(card.textContent, /17:00/);
  assert.match(card.textContent, /Window/);
  const manage = card.querySelector("a");
  ui = await app.open(manage.href);
  assert.equal(ui.get("reservation-status").textContent, "confirmed");
  await ui.input("change-party-size", "3");
  await ui.input("change-time", "19:00");
  await ui.click("change-seat-banquette");
  await ui.click("change-submit");
  assert.match(ui.get("change-saved").textContent, /19:00/);
  assert.equal(ui.get("reservation-tables").textContent, "Banquette");
  const moved = app.bookings()[0];
  assert.equal(moved.starts_at_local, `${day}T19:00`);
  assert.equal(moved.party_size, 3);
  assert.equal(moved.table_id, "banquette");

  const cancellationCount = () => app.requests.filter((item) => item.method === "POST" && item.path.endsWith("/cancel")).length;
  await ui.click("reservation-cancel-button");
  assert.equal(ui.get("reservation-cancel-button").textContent, "Yes, cancel reservation");
  assert.equal(cancellationCount(), 0, "The first cancel click must only ask for confirmation");
  assert.equal(ui.document.querySelector("[data-testid='agent-trace-cancel']"), null, "Asking for confirmation must not simulate a cancellation");
  const keep = ui.document.querySelectorAll("button").find((node) => node.textContent === "Keep reservation");
  await ui.click(keep);
  assert.equal(ui.get("reservation-cancel-button").textContent, "Cancel reservation");
  assert.equal(keep.hidden, true);
  assert.equal(app.bookings()[0].status, "confirmed");
  assert.equal(cancellationCount(), 0, "Keeping a reservation must not call cancel");
  assert.equal(ui.document.querySelector("[data-testid='agent-trace-cancel']"), null, "Keeping the reservation must not claim a cancellation occurred");
  await ui.click("reservation-cancel-button");
  await ui.click("reservation-cancel-button");
  assert.equal(cancellationCount(), 1);
  assert.equal(ui.get("reservation-status").textContent, "cancelled");
  assert.ok(ui.get("cancellation-confirmed"));
  assert.equal(ui.document.querySelector("[data-testid='change-form']"), null);
  assert.equal(ui.document.querySelector("[data-testid='reservation-cancel-button']"), null);
  assert.equal(app.bookings()[0].status, "cancelled");
  ui = await app.open("/lookup");
  assert.match(ui.get("booking-card").textContent, /cancelled/);
});

test("stage 4 UI script: signing into an existing account keeps the anonymous table selection", async () => {
  const app = setup();
  assert.equal(request(app.service, "POST", "/auth/signup", {
    email: "diner@example.test", password, display_name: "Returning diner",
  }).status, 201);
  await selectAndAuthenticate(app, "login");
});

test("stage 4 UI script: expired-session lookup offers sign in and keeps the booking destination", async () => {
  const app = setup();
  await selectAndAuthenticate(app, "signup");
  const reference = app.bookings()[0].reference;
  app.failNext("GET", `/reservations/${reference}`, {
    status: 401, body: { error: { code: "unauthorized", message: "Sign in to continue." } },
  });
  const ui = await app.open(`/lookup?ref=${reference}`);
  assert.equal(ui.document.getElementById("account-link").hidden, false);
  const login = ui.document.querySelectorAll("a").find((node) => node.href?.startsWith("/login?next="));
  assert.ok(login, "An expired session must offer a direct sign-in recovery link");
  assert.equal(new URL(login.href, "http://local.test").searchParams.get("next"), `/lookup?ref=${reference}`);
});

test("stage 4 UI script: failed move availability is explained and can be retried", async () => {
  const app = setup();
  await selectAndAuthenticate(app, "signup");
  const original = app.bookings()[0];
  const ui = await app.open(`/lookup?ref=${original.reference}`);
  app.failNext("GET", "/availability", {
    status: 503, body: { error: { code: "unavailable", message: "Temporarily unavailable." } },
  });
  await ui.input("change-time", "19:00");
  assert.ok(ui.get("change-availability-error"));
  assert.equal(ui.get("change-submit").disabled, true);
  assert.match(ui.get("change-seat-window").textContent, /Unavailable/);
  await ui.click("change-availability-retry");
  assert.equal(ui.document.querySelector("[data-testid='change-availability-error']"), null);
  assert.equal(ui.get("change-seat-window").disabled, false);
  assert.equal(ui.get("change-submit").disabled, false);
  assert.deepEqual(app.bookings()[0], original, "Checking availability must leave the booking untouched");
});

test("stage 4 UI script: a move into an adjacent booking is checked on save and preserves the original", async () => {
  const app = setup();
  await selectAndAuthenticate(app, "signup");
  const original = app.bookings()[0];
  assert.equal(app.authorized("POST", "/reservations", {
    restaurant_id: "ui-demo", table_id: "window", party_size: 2, starts_at_local: `${day}T18:30`,
  }, { "idempotency-key": "adjacent-ui-booking" }).status, 201);
  const ui = await app.open(`/lookup?ref=${original.reference}`);
  await ui.input("change-time", "17:30");
  assert.match(ui.get("change-seat-window").textContent, /Check on save/);
  await ui.click("change-submit");
  assert.ok(ui.get("change-error"));
  assert.deepEqual(app.bookings().find((booking) => booking.reference === original.reference), original);
  assert.equal(ui.get("reservation-status").textContent, "confirmed");
  const trace = ui.get("agent-trace-move").textContent;
  assert.match(trace, /implementer\s*\(simulated\).*not completed:/i);
  assert.match(trace, /reviewer\s*\(simulated\).*checked: refusal received/i);
  assert.doesNotMatch(trace, /done:/i);
});

test("stage 4 UI fallback: a lost local response stays unconfirmed instead of claiming the agents checked success", async () => {
  const app = setup();
  await selectAndAuthenticate(app, "signup");
  const original = app.bookings()[0];
  const ui = await app.open(`/lookup?ref=${original.reference}`);
  await ui.input("change-time", "19:00");
  app.failNext("PATCH", `/reservations/${original.reference}`, new TypeError("Local service unreachable"));
  await ui.click("change-submit");
  assert.deepEqual(app.bookings()[0], original);
  const trace = ui.get("agent-trace-move").textContent;
  assert.match(trace, /coordinator\s*\(simulated\).*planned:/i);
  assert.match(trace, /implementer\s*\(simulated\).*unconfirmed:/i);
  assert.match(trace, /reviewer\s*\(simulated\).*not checked:/i);
  assert.doesNotMatch(trace, /done:/i);
});
