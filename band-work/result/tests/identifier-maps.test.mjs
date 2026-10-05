import assert from "node:assert/strict";
import test from "node:test";

// These regressions use public routes and empty-user fixtures: no credentials
// or authentication tokens are needed or generated.
const reservedIds = ["__proto__", "constructor", "toString"];
const date = "2030-01-07"; // Monday.

function request(service, method, path, body, query = {}) {
  return service.handle(method, path, query, {}, body === undefined ? "" : JSON.stringify(body));
}

function fixture(id, tableId = "table_1") {
  return {
    users: [],
    reservations: [],
    restaurants: [{
      id,
      name: "Identifier regression",
      timezone: "Europe/Berlin",
      slot_minutes: 30,
      reservation_duration_minutes: 60,
      cancellation_cutoff_minutes: 0,
      opening_hours: [{ weekday: "mon", opens: "18:00", closes: "20:00" }],
      tables: [{ id: tableId, label: "Window", capacity: 2 }],
    }],
  };
}

function roundTrip(service) {
  const exported = request(service, "GET", "/_test/export");
  assert.equal(exported.status, 200);
  assert.equal(request(service, "POST", "/_test/import", exported.body).status, 204);
  return exported.body;
}

function assertMissing(service, stage) {
  for (const id of [...reservedIds, "ordinary_missing_id"]) {
    const detail = request(service, "GET", `/restaurants/${id}`);
    assert.equal(detail.status, 404, `unknown restaurant ${id}`);
    assert.equal(detail.body.error.code, "not_found");
    const available = request(service, "GET", "/availability", undefined, {
      restaurant_id: id, date, party_size: "2",
    });
    assert.equal(available.status, 404, `unknown availability restaurant ${id}`);
    if (stage >= 3) {
      assert.equal(request(service, "GET", `/restaurants/${id}/policies`).status, 404);
    }
  }
}

function assertAvailable(service, restaurantId, tableId) {
  const response = request(service, "GET", "/availability", undefined, {
    restaurant_id: restaurantId, date, party_size: "2",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.slots.length, 3);
  for (const slot of response.body.slots) {
    assert.deepEqual(slot.available_table_ids, [tableId]);
  }
}

for (let stage = 1; stage <= 4; stage++) {
  const { createService } = await import(`../stage-${stage}/src/engine.mjs`);

  test(`stage ${stage}: unknown inherited names return 404`, () => {
    assertMissing(createService(stage), stage);
  });

  test(`stage ${stage}: import preserves missing-ID behavior`, () => {
    const service = createService(stage);
    roundTrip(service);
    assertMissing(service, stage);
  });

  test(`stage ${stage}: reserved restaurant IDs survive reset and import`, () => {
    for (const id of [...reservedIds, "restaurant_1"]) {
      const service = createService(stage);
      assert.equal(request(service, "POST", "/_test/reset", fixture(id)).status, 204);
      for (let pass = 0; pass < 2; pass++) {
        const listed = request(service, "GET", "/restaurants");
        assert.deepEqual(listed.body.restaurants.map(item => item.id), [id]);
        assert.equal(request(service, "GET", `/restaurants/${id}`).body.id, id);
        assertAvailable(service, id, "table_1");
        const exported = roundTrip(service);
        assert.ok(Object.hasOwn(exported.state.restaurants, id));
      }
    }
  });

  test(`stage ${stage}: reserved table IDs retain capacity and availability`, () => {
    for (const tableId of [...reservedIds, "table_1"]) {
      const service = createService(stage);
      assert.equal(request(service, "POST", "/_test/reset", fixture("restaurant_1", tableId)).status, 204);
      for (let pass = 0; pass < 2; pass++) {
        assertAvailable(service, "restaurant_1", tableId);
        const exported = roundTrip(service);
        const capacities = exported.state.restaurants.restaurant_1.policies[0].capacities;
        assert.ok(Object.hasOwn(capacities, tableId));
        assert.equal(capacities[tableId], 2);
      }
    }
  });
}
