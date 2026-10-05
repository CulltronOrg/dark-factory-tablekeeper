import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../stage-4/src/engine.mjs";

// Run with BAND_API_KEY unset. These disposable users and sessions remain in
// memory; assertions never print authentication tokens or export service state.
const day = "2035-01-08";
const at = (time) => `${day}T${time}`;

function request(service, method, path, body, headers = {}, query = {}) {
  return service.handle(method, path, query, headers, body === undefined ? "" : JSON.stringify(body));
}

function setup() {
  const service = createService(4);
  const reset = request(service, "POST", "/_test/reset", {
    users: [], reservations: [],
    restaurants: [{
      id: "guard-demo", name: "Guard demo", timezone: "Europe/Berlin",
      slot_minutes: 30, reservation_duration_minutes: 90, cancellation_cutoff_minutes: 120,
      opening_hours: [{ weekday: "mon", opens: "17:00", closes: "23:00" }],
      tables: [
        { id: "a", label: "Window", capacity: 2 },
        { id: "b", label: "Banquette", capacity: 4 },
        { id: "c", label: "Round", capacity: 6 },
      ],
      combinable: [["a", "b"]],
    }],
  });
  assert.equal(reset.status, 204);
  return service;
}

function account(service, email) {
  const created = request(service, "POST", "/auth/signup", {
    email, password: "disposable-guard-password", display_name: "Guard diner",
  });
  assert.equal(created.status, 201);
  const login = request(service, "POST", "/auth/login", {
    email, password: "disposable-guard-password",
  });
  assert.equal(login.status, 200);
  return { authorization: `Bearer ${login.body.token}` };
}

function book(service, auth, overrides = {}) {
  return request(service, "POST", "/reservations", {
    restaurant_id: "guard-demo", table_id: "a", party_size: 2,
    starts_at_local: at("17:00"), ...overrides,
  }, { ...auth, "idempotency-key": "guard-booking" });
}

function availability(service, time) {
  const result = request(service, "GET", "/availability", undefined, {}, {
    restaurant_id: "guard-demo", date: day, party_size: "2",
  });
  assert.equal(result.status, 200);
  return result.body.slots.find((slot) => slot.starts_at_local === at(time)).available_table_ids;
}

test("stage 4 guards: only the owner can move or cancel a reservation", () => {
  const service = setup();
  const owner = account(service, "owner@example.test");
  const outsider = account(service, "outsider@example.test");
  const created = book(service, owner);
  assert.equal(created.status, 201);
  const path = `/reservations/${created.body.reference}`;

  assert.equal(request(service, "GET", "/reservations").status, 401);
  assert.equal(request(service, "POST", "/reservations", {}).status, 401);
  assert.equal(request(service, "PATCH", path, { starts_at_local: at("19:00") }).status, 401);
  assert.equal(request(service, "POST", `${path}/cancel`).status, 401);
  assert.equal(request(service, "PATCH", path, { starts_at_local: at("19:00") }, outsider).status, 404);
  assert.equal(request(service, "POST", `${path}/cancel`, undefined, outsider).status, 404);
  assert.equal(request(service, "GET", `${path}/history`, undefined, outsider).status, 404);
  assert.equal(request(service, "GET", `${path}/decision`, undefined, outsider).status, 404);
  assert.equal(request(service, "GET", "/reservations", undefined, outsider).body.reservations.length, 0);
  assert.deepEqual(request(service, "GET", path, undefined, owner).body, created.body);
});

test("stage 4 guards: a combined booking releases both tables after a move", () => {
  const service = setup();
  const owner = account(service, "combined@example.test");
  const created = request(service, "POST", "/reservations", {
    restaurant_id: "guard-demo", table_ids: ["b", "a"], party_size: 5, starts_at_local: at("17:00"),
  }, { ...owner, "idempotency-key": "combined-booking" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.table_ids, ["a", "b"]);
  assert.deepEqual(availability(service, "17:00"), ["c"]);
  const path = `/reservations/${created.body.reference}`;
  const moved = request(service, "PATCH", path, {
    table_ids: ["c"], starts_at_local: at("19:00"), expected_revision: created.body.revision,
  }, owner);
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.table_ids, ["c"]);
  assert.deepEqual(availability(service, "17:00"), ["a", "b", "c"]);
  assert.deepEqual(availability(service, "19:00"), ["a", "b"]);
  assert.equal(request(service, "POST", `${path}/cancel`, undefined, owner).status, 200);
  assert.deepEqual(availability(service, "19:00"), ["a", "b", "c"]);
  const cancelledChange = request(service, "PATCH", path, { party_size: 4 }, owner);
  assert.equal(cancelledChange.status, 409);
  assert.equal(cancelledChange.body.error.code, "reservation_cancelled");
});

test("stage 4 guards: a move may overlap its own original table and retains it on invalid edits", () => {
  const service = setup();
  const owner = account(service, "move@example.test");
  const created = book(service, owner);
  assert.equal(created.status, 201);
  const path = `/reservations/${created.body.reference}`;
  const moved = request(service, "PATCH", path, {
    starts_at_local: at("17:30"), expected_revision: created.body.revision,
  }, owner);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.starts_at_local, at("17:30"));
  assert.equal(moved.body.table_id, "a");
  for (const edit of [{ party_size: 3 }, { starts_at_local: at("17:45") }, { starts_at_local: at("23:00") }]) {
    assert.equal(request(service, "PATCH", path, edit, owner).status, 422);
    assert.deepEqual(request(service, "GET", path, undefined, owner).body, moved.body);
  }
  assert.ok(availability(service, "19:00").includes("a"));
});
