import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { DateTime, IANAZone } from "luxon";
import { STAGE } from "./stage.mjs";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const REF_RE = /^[A-Z0-9]{6,12}$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const PLAIN_INT_RE = /^(0|[1-9][0-9]*)$/;

// Stage 1 only. A higher stage argument cannot turn on the next stage.
const STAGE_CAP = STAGE;

export function createService(stage) {
  const requested = Number(stage);
  const ctx = { stage: Math.min(Number.isFinite(requested) ? requested : STAGE_CAP, STAGE_CAP), state: emptyState() };
  return {
    handle(method, path, query, headers, raw) {
      try {
        return dispatch(ctx, method, path, query, headers, raw);
      } catch (err) {
        console.error(err);
        return fail(500, "internal", "The service failed while handling the request");
      }
    },
  };
}

function emptyState() {
  return {
    users: Object.create(null),
    restaurants: Object.create(null),
    reservations: Object.create(null),
    series: Object.create(null),
    plans: Object.create(null),
    idem: Object.create(null),
  };
}

function dispatch(ctx, method, path, query, headers, raw) {
  const route = matchRoute(path);
  if (route.kind === "malformed") {
    return fail(400, "malformed_request", "The request URL is not valid");
  }

  if (method === "GET" && path === "/health") {
    return ok(200, { status: "ok" });
  }
  if (method === "POST" && path === "/_test/reset") {
    const parsed = parseObject(raw);
    if (parsed.error) return parsed.error;
    const loaded = loadFixture(parsed.value);
    if (loaded.error) return loaded.error;
    ctx.state = loaded.state;
    return noContent();
  }
  if (method === "GET" && path === "/_test/export") {
    return ok(200, exportState(ctx));
  }
  if (method === "POST" && path === "/_test/import") {
    const parsed = parseObject(raw);
    if (parsed.error) return parsed.error;
    const loaded = importState(parsed.value);
    if (loaded.error) return loaded.error;
    ctx.state = loaded.state;
    return noContent();
  }
  if (method === "POST" && path === "/auth/signup") return signup(ctx, raw);
  if (method === "POST" && path === "/auth/login") return login(ctx, raw);
  if (method === "GET" && path === "/restaurants") return listRestaurants(ctx);
  if (method === "GET" && route.kind === "restaurant") return restaurantDetail(ctx, route.id);
  if (method === "GET" && path === "/availability") return availability(ctx, query);

  const auth = requireUser(ctx, headers);
  if (auth.error) return auth.error;
  const user = auth.user;

  if (method === "POST" && path === "/reservations") return createReservation(ctx, user, headers, raw);
  if (method === "GET" && path === "/reservations") return listReservations(ctx, user);
  if (method === "GET" && route.kind === "reservation") return getReservation(ctx, user, route.ref);
  if (method === "POST" && route.kind === "cancel") return cancelReservation(ctx, user, route.ref, raw);
  if (method === "PATCH" && route.kind === "reservation") return patchReservation(ctx, user, route.ref, raw);
  if (method === "POST" && path === "/reservation-moves") return reservationMoves(ctx, user, headers, raw);


  return fail(404, "not_found", "No such resource");
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function matchRoute(path) {
  let m;
  // Search, book, change, and cancel only.
  if ((m = /^\/reservations\/([^/]+)\/cancel$/.exec(path))) {
    const ref = decodePathPart(m[1]);
    if (ref == null) return { kind: "malformed" };
    return { kind: "cancel", ref };
  }
  if ((m = /^\/reservations\/([^/]+)$/.exec(path))) {
    const ref = decodePathPart(m[1]);
    if (ref == null) return { kind: "malformed" };
    return { kind: "reservation", ref };
  }
  if ((m = /^\/restaurants\/([^/]+)$/.exec(path))) {
    const id = decodePathPart(m[1]);
    if (id == null) return { kind: "malformed" };
    return { kind: "restaurant", id };
  }
  return { kind: "none" };
}

function ok(status, body) {
  return { status, body };
}
function noContent() {
  return { status: 204, body: null };
}
function fail(status, code, message) {
  return { status, body: { error: { code, message } } };
}

function parseObject(raw) {
  if (raw == null || String(raw).trim() === "") {
    return { error: fail(400, "malformed_request", "Request body must be a JSON object") };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: fail(400, "malformed_request", "Request body is not valid JSON") };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: fail(400, "malformed_request", "Request body must be a JSON object") };
  }
  // A few dozen levels is enough for any real booking body. Deeper input overflows
  // the stack while comparing idempotent bodies, and a crash must not become a 500.
  if (!withinJsonDepth(value, 32)) {
    return { error: fail(400, "malformed_request", "Request body is nested too deeply") };
  }
  return { value };
}

function withinJsonDepth(value, max) {
  const stack = [{ value, depth: 1 }];
  while (stack.length) {
    const item = stack.pop();
    const current = item.value;
    if (!current || typeof current !== "object") continue;
    if (item.depth > max) return false;
    const children = Array.isArray(current) ? current : Object.values(current);
    for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
  }
  return true;
}

function header(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value == null ? "" : String(value);
}

function requireUser(ctx, headers) {
  const raw = header(headers, "authorization");
  if (!raw) return { error: fail(401, "unauthenticated", "Authentication is required") };
  const match = /^Bearer\s+(\S+)\s*$/.exec(raw);
  if (!match) return { error: fail(401, "unauthenticated", "Authentication is required") };
  const user = userByToken(ctx, match[1]);
  if (!user) return { error: fail(401, "unauthenticated", "Authentication is required") };
  return { user };
}

function userByToken(ctx, token) {
  for (const user of Object.values(ctx.state.users)) {
    if (user.tokens.includes(token)) return user;
  }
  return null;
}

function idemKeyOf(headers) {
  return header(headers, "idempotency-key");
}

function idemId(userId, method, path, key) {
  return JSON.stringify([userId, method, path, key]);
}

function beginIdem(ctx, user, method, path, headers, body) {
  const key = idemKeyOf(headers);
  if (!key) return { error: fail(400, "missing_idempotency_key", "Idempotency-Key is required") };
  if ([...key].length > 255) {
    return { error: fail(422, "validation_failed", "Idempotency-Key must be 1 to 255 characters") };
  }
  const rec = ctx.state.idem[idemId(user.id, method, path, key)];
  if (!rec) return { key };
  if (!sameJson(rec.body, body)) {
    return { error: fail(409, "idempotency_key_reuse", "This key was already used for a different request") };
  }
  return { replay: ok(200, rec.response) };
}

function rememberIdem(ctx, user, method, path, key, body, response) {
  ctx.state.idem[idemId(user.id, method, path, key)] = {
    body: structuredClone(body),
    response: structuredClone(response),
  };
}

function sameJson(a, b) {
  try {
    return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value && typeof value === "object") {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) out[key] = canon(value[key]);
    return out;
  }
  return value;
}

function isInt(value) {
  return typeof value === "number" && Number.isInteger(value);
}
function isString(value) {
  return typeof value === "string";
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384;
  const r = 8;
  const p = 1;
  const hash = scryptSync(password, salt, 32, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  let actual;
  try {
    actual = scryptSync(password, Buffer.from(saltB64, "base64"), 32, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  const expected = Buffer.from(hashB64, "base64");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function newId(prefix) {
  return prefix + randomBytes(9).toString("hex");
}
function newReference(ctx) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let n = 0; n < 8; n++) {
    const bytes = randomBytes(8);
    let ref = "";
    for (const byte of bytes) ref += alphabet[byte % alphabet.length];
    if (!ctx.state.reservations[ref]) return ref;
  }
  return newId("").slice(0, 12).toUpperCase();
}
function newToken() {
  return randomBytes(24).toString("hex");
}

function nowIso() {
  return DateTime.utc().toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
}
function fmt(dt) {
  return dt.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
}
function toMin(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fromMin(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = DateTime.fromObject({ year: y, month: m, day: d }, { zone: "utc" });
  return WEEKDAYS[dt.weekday - 1];
}
function validDateString(dateStr) {
  const match = DATE_RE.exec(dateStr);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = DateTime.fromObject({ year, month, day }, { zone: "utc" });
  return dt.isValid && dt.toFormat("yyyy-MM-dd") === dateStr;
}
function validZone(zone) {
  return IANAZone.isValidZone(zone);
}

function resolveLocal(zone, local) {
  const match = LOCAL_RE.exec(local);
  if (!match) return { error: "format" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    return { error: "format" };
  }
  const date = DateTime.fromObject({ year, month, day }, { zone });
  if (!date.isValid || date.toFormat("yyyy-MM-dd") !== `${match[1]}-${match[2]}-${match[3]}`) {
    return { error: "format" };
  }
  const dt = DateTime.fromObject(
    { year, month, day, hour, minute, second: 0, millisecond: 0 },
    { zone, disambiguation: "earlier" },
  );
  if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm") !== local) return { error: "gap" };
  return { dt };
}

function policyZero(restaurant) {
  const capacities = Object.create(null);
  for (const table of restaurant.tables) capacities[table.id] = table.capacity;
  return {
    policy_version: 0,
    effective_from: null,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: structuredClone(restaurant.opening_hours),
    capacities,
  };
}

function termsOf(policy) {
  return {
    policy_version: policy.policy_version,
    slot_minutes: policy.slot_minutes,
    reservation_duration_minutes: policy.reservation_duration_minutes,
    cancellation_cutoff_minutes: policy.cancellation_cutoff_minutes,
    opening_hours: structuredClone(policy.opening_hours),
    capacities: structuredClone(policy.capacities),
  };
}

function selectPolicy(restaurant, dateStr) {
  let selected = restaurant.policies[0];
  for (const policy of restaurant.policies) {
    if (policy.policy_version === 0 || policy.effective_from > dateStr) continue;
    const laterDate = selected.policy_version === 0 || policy.effective_from > selected.effective_from;
    const sameDate = selected.policy_version !== 0 && policy.effective_from === selected.effective_from;
    if (laterDate || (sameDate && policy.policy_version > selected.policy_version)) selected = policy;
  }
  return selected;
}

function classify(policy, zone, local) {
  const resolved = resolveLocal(zone, local);
  if (resolved.error === "format") return { error: fail(422, "validation_failed", "The local time is not valid") };
  if (resolved.error === "gap") return { error: fail(422, "invalid_local_time", "That local time does not exist") };
  const date = local.slice(0, 10);
  const hhmm = local.slice(11);
  const hours = policy.opening_hours.find((entry) => entry.weekday === weekdayOf(date));
  if (!hours) return { error: fail(422, "outside_opening_hours", "The restaurant is closed then") };
  const open = toMin(hours.opens);
  const close = toMin(hours.closes);
  const start = toMin(hhmm);
  if (start < open || start + policy.reservation_duration_minutes > close) {
    return { error: fail(422, "outside_opening_hours", "That time is outside opening hours") };
  }
  if ((start - open) % policy.slot_minutes !== 0) {
    return { error: fail(422, "not_on_slot_grid", "That time is not on the booking grid") };
  }
  const end = resolved.dt.plus({ minutes: policy.reservation_duration_minutes });
  return {
    starts_at_local: local,
    starts_at: fmt(resolved.dt),
    ends_at: fmt(end),
    startMs: resolved.dt.toMillis(),
    endMs: end.toMillis(),
    policy,
  };
}

function slotsFor(policy, zone, dateStr) {
  if (!isInt(policy.slot_minutes) || policy.slot_minutes < 1) return [];
  if (!isInt(policy.reservation_duration_minutes) || policy.reservation_duration_minutes < 1) return [];
  const hours = policy.opening_hours.find((entry) => entry.weekday === weekdayOf(dateStr));
  if (!hours) return [];
  const open = toMin(hours.opens);
  const close = toMin(hours.closes);
  const slots = [];
  for (let t = open; t + policy.reservation_duration_minutes <= close; t += policy.slot_minutes) {
    const local = `${dateStr}T${fromMin(t)}`;
    const resolved = resolveLocal(zone, local);
    if (resolved.error) continue;
    const end = resolved.dt.plus({ minutes: policy.reservation_duration_minutes });
    slots.push({
      starts_at_local: local,
      starts_at: fmt(resolved.dt),
      hhmm: fromMin(t),
      startMs: resolved.dt.toMillis(),
      endMs: end.toMillis(),
    });
  }
  return slots;
}

function tableMap(restaurant) {
  return new Map(restaurant.tables.map((table) => [table.id, table]));
}

function canonicalTables(restaurant, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: fail(422, "validation_failed", "A table selection is required") };
  }
  if (ids.some((id) => typeof id !== "string")) {
    return { error: fail(400, "malformed_request", "Table identifiers must be strings") };
  }
  if (new Set(ids).size !== ids.length) {
    return { error: fail(422, "validation_failed", "A table was named more than once") };
  }
  const tables = tableMap(restaurant);
  for (const id of ids) {
    if (!tables.has(id)) return { error: fail(404, "not_found", "Unknown table") };
  }
  if (ids.length !== 1) {
    return { error: fail(422, "validation_failed", "A reservation uses one table") };
  }
  return { ids: [ids[0]] };
}

function sameIds(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function syncSchedule(res) {
  res.scheduled_date = res.starts_at_local.slice(0, 10);
  res.scheduled_time = res.starts_at_local.slice(11, 16);
}

function capacityOf(policy, ids) {
  return ids.reduce((sum, id) => sum + Number(policy.capacities[id] ?? 0), 0);
}

function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

function blocked(ctx, restaurant, tableIds, startMs, endMs, ignore) {
  for (const res of Object.values(ctx.state.reservations)) {
    if (ignore.has(res.reference)) continue;
    if (res.status !== "confirmed" || res.restaurant_id !== restaurant.id) continue;
    if (!overlaps(startMs, endMs, res.startMs, res.endMs)) continue;
    if (res.table_ids.some((id) => tableIds.includes(id))) return true;
  }
  for (const closure of restaurant.closures || []) {
    if (!overlaps(startMs, endMs, closure.startMs, closure.endMs)) continue;
    if (tableIds.includes(closure.table_id)) return true;
  }
  return false;
}

function cutoffPassed(res, now = Date.now()) {
  const minutes = res.accepted_terms.cancellation_cutoff_minutes;
  return now >= res.startMs - minutes * 60 * 1000;
}

function viewReservation(ctx, res) {
  return {
    reservation_id: res.id,
    reference: res.reference,
    restaurant_id: res.restaurant_id,
    table_id: res.table_ids[0],
    party_size: res.party_size,
    status: res.status,
    starts_at_local: res.starts_at_local,
    starts_at: res.starts_at,
    ends_at: res.ends_at,
    created_at: res.created_at,
  };
}
function bumpRestaurant(restaurant) {
  restaurant.revision += 1;
}

function pushHistory(res, event, changes, extra = {}) {
  res.history.push({
    seq: res.history.length + 1,
    at: nowIso(),
    event,
    changes,
    revision: res.revision,
    accepted_terms: structuredClone(res.accepted_terms),
    ...extra,
  });
}

function tableHistory(before, after) {
  if (before.length > 1 || after.length > 1) {
    return { field: "table_ids", from: before.length ? [...before] : null, to: [...after] };
  }
  return { field: "table_id", from: before[0] ?? null, to: after[0] };
}

function makeReservation(ctx, user, restaurant, fields) {
  const policy = fields.policy;
  const res = {
    id: fields.id || newId("res_"),
    reference: fields.reference || newReference(ctx),
    user_id: user.id,
    restaurant_id: restaurant.id,
    table_ids: [...fields.table_ids],
    party_size: fields.party_size,
    status: fields.status || "confirmed",
    starts_at_local: fields.starts_at_local,
    starts_at: fields.starts_at,
    ends_at: fields.ends_at,
    startMs: fields.startMs,
    endMs: fields.endMs,
    created_at: fields.created_at || nowIso(),
    revision: fields.revision || 1,
    accepted_terms: termsOf(policy),
    history: [],
    series_id: null,
    series_index: null,
    exception: false,
    scheduled_date: fields.starts_at_local.slice(0, 10),
    scheduled_time: fields.starts_at_local.slice(11),
  };
  const created = [tableHistory([], res.table_ids)];
  created[0].from = null;
  created.push(
    { field: "starts_at_local", from: null, to: res.starts_at_local },
    { field: "party_size", from: null, to: res.party_size },
  );
  pushHistory(res, "created", created);
  return res;
}

function readParty(value, { required }) {
  if (value === undefined) {
    return required
      ? { error: fail(422, "validation_failed", "party_size is required") }
      : { absent: true };
  }
  if (!isInt(value) || value < 1) {
    return { error: fail(422, "validation_failed", "party_size must be a positive integer") };
  }
  return { value };
}

function readLocal(value, { required }) {
  if (value === undefined) {
    return required
      ? { error: fail(422, "validation_failed", "starts_at_local is required") }
      : { absent: true };
  }
  if (!isString(value)) return { error: fail(400, "malformed_request", "starts_at_local must be a string") };
  if (!LOCAL_RE.test(value)) {
    return { error: fail(422, "validation_failed", "starts_at_local must be YYYY-MM-DDTHH:MM") };
  }
  return { value };
}

function selectionFromBody(ctx, body, { required }) {
  if (Object.prototype.hasOwnProperty.call(body, "table_id")) {
    if (!isString(body.table_id)) return { error: fail(400, "malformed_request", "table_id must be a string") };
    return { ids: [body.table_id] };
  }
  return required
    ? { error: fail(422, "validation_failed", "A table is required") }
    : { absent: true };
}
function sameMembers(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, index) => id === right[index]);
}

function describeSeat(restaurant, ids, local, party) {
  const chosen = canonicalTables(restaurant, ids);
  if (chosen.error) return chosen;
  const date = local.slice(0, 10);
  const policy = selectPolicy(restaurant, date);
  const when = classify(policy, restaurant.timezone, local);
  if (when.error) return when;
  if (party > capacityOf(policy, chosen.ids)) {
    return { error: fail(422, "party_exceeds_capacity", "The party is larger than the table") };
  }
  return { table_ids: chosen.ids, party, party_size: party, ...when };
}

function place(ctx, restaurant, ids, local, party, ignore) {
  const seated = describeSeat(restaurant, ids, local, party);
  if (seated.error) return seated;
  if (blocked(ctx, restaurant, seated.table_ids, seated.startMs, seated.endMs, ignore)) {
    return { error: fail(409, "table_unavailable", "That table is already held") };
  }
  return seated;
}

function owned(ctx, user, ref) {
  const res = ctx.state.reservations[ref];
  if (!res || res.user_id !== user.id) return { error: fail(404, "not_found", "No such reservation") };
  return { res };
}

function signup(ctx, raw) {
  const parsed = parseObject(raw);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  for (const field of ["email", "password", "display_name"]) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) {
      return fail(422, "validation_failed", `${field} is required`);
    }
    if (!isString(body[field])) return fail(400, "malformed_request", `${field} must be a string`);
  }
  const email = body.email;
  if (!EMAIL_RE.test(email)) return fail(422, "validation_failed", "Enter an email address");
  if ([...body.password].length < 8) {
    return fail(422, "validation_failed", "Password must be at least 8 characters");
  }
  const emailKey = email.toLowerCase();
  if (Object.values(ctx.state.users).some((user) => user.emailKey === emailKey)) {
    return fail(409, "email_taken", "That email is already registered");
  }
  const user = {
    id: newId("u_"),
    email,
    emailKey,
    passwordHash: hashPassword(body.password),
    displayName: body.display_name,
    tokens: [newToken()],
  };
  ctx.state.users[user.id] = user;
  return ok(201, { user_id: user.id, display_name: user.displayName, token: user.tokens[0] });
}

function login(ctx, raw) {
  const parsed = parseObject(raw);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  if (!Object.prototype.hasOwnProperty.call(body, "email") || !Object.prototype.hasOwnProperty.call(body, "password")) {
    return fail(422, "validation_failed", "Email and password are required");
  }
  if (!isString(body.email) || !isString(body.password)) {
    return fail(400, "malformed_request", "Email and password must be strings");
  }
  const emailKey = body.email.toLowerCase();
  const user = Object.values(ctx.state.users).find((entry) => entry.emailKey === emailKey);
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    return fail(401, "unauthenticated", "Email or password is incorrect");
  }
  const token = newToken();
  user.tokens.push(token);
  return ok(200, { user_id: user.id, display_name: user.displayName, token });
}

function listRestaurants(ctx) {
  return ok(200, {
    restaurants: Object.values(ctx.state.restaurants).map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      timezone: restaurant.timezone,
    })),
  });
}

function restaurantDetail(ctx, id) {
  const restaurant = ctx.state.restaurants[id];
  if (!restaurant) return fail(404, "not_found", "Unknown restaurant");
  const body = {
    id: restaurant.id,
    name: restaurant.name,
    timezone: restaurant.timezone,
    slot_minutes: restaurant.slot_minutes,
    reservation_duration_minutes: restaurant.reservation_duration_minutes,
    cancellation_cutoff_minutes: restaurant.cancellation_cutoff_minutes,
    opening_hours: structuredClone(restaurant.opening_hours),
    tables: restaurant.tables.map((table) => ({
      id: table.id,
      label: table.label,
      capacity: table.capacity,
    })),
  };
  return ok(200, body);
}

function availability(ctx, query) {
  const restaurantId = query.restaurant_id;
  const date = query.date;
  const partyRaw = query.party_size;
  if (restaurantId == null || restaurantId === "" || date == null || date === "" || partyRaw == null || partyRaw === "") {
    return fail(422, "validation_failed", "restaurant_id, date and party_size are required");
  }
  if (!PLAIN_INT_RE.test(partyRaw)) {
    return fail(422, "validation_failed", "party_size must be a plain integer");
  }
  const party = Number(partyRaw);
  if (party < 1) return fail(422, "validation_failed", "party_size must be at least 1");
  if (!validDateString(date)) return fail(422, "validation_failed", "date must be a real YYYY-MM-DD");
  const restaurant = ctx.state.restaurants[restaurantId];
  if (!restaurant) return fail(404, "not_found", "Unknown restaurant");

  const policy = selectPolicy(restaurant, date);
  const slots = slotsFor(policy, restaurant.timezone, date).map((slot) => {
    const available = [];
    for (const table of restaurant.tables) {
      const cap = Number(policy.capacities[table.id]);
      const free = party <= cap && !blocked(ctx, restaurant, [table.id], slot.startMs, slot.endMs, new Set());
      if (free) available.push(table.id);
    }
    return {
      starts_at_local: slot.starts_at_local,
      starts_at: slot.starts_at,
      available_table_ids: available,
    };
  });

  return ok(200, {
    restaurant_id: restaurant.id,
    date,
    timezone: restaurant.timezone,
    slots,
  });
}
function createReservation(ctx, user, headers, raw) {
  const parsed = parseObject(raw);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  const gate = beginIdem(ctx, user, "POST", "/reservations", headers, body);
  if (gate.error) return gate.error;
  if (gate.replay) return gate.replay;

  if (!Object.prototype.hasOwnProperty.call(body, "restaurant_id")) {
    return fail(422, "validation_failed", "restaurant_id is required");
  }
  if (!isString(body.restaurant_id)) return fail(400, "malformed_request", "restaurant_id must be a string");
  const party = readParty(body.party_size, { required: true });
  if (party.error) return party.error;
  const local = readLocal(body.starts_at_local, { required: true });
  if (local.error) return local.error;
  const selection = selectionFromBody(ctx, body, { required: true });
  if (selection.error) return selection.error;
  const restaurant = ctx.state.restaurants[body.restaurant_id];
  if (!restaurant) return fail(404, "not_found", "Unknown restaurant");
  const placed = place(ctx, restaurant, selection.ids, local.value, party.value, new Set());
  if (placed.error) return placed.error;

  const res = makeReservation(ctx, user, restaurant, placed);
  ctx.state.reservations[res.reference] = res;
  bumpRestaurant(restaurant);
  const response = viewReservation(ctx, res);
  rememberIdem(ctx, user, "POST", "/reservations", gate.key, body, response);
  return ok(201, response);
}

function listReservations(ctx, user) {
  const mine = Object.values(ctx.state.reservations)
    .filter((res) => res.user_id === user.id)
    .sort((a, b) => b.startMs - a.startMs || (a.reference < b.reference ? 1 : -1));
  return ok(200, { reservations: mine.map((res) => viewReservation(ctx, res)) });
}

function getReservation(ctx, user, ref) {
  const found = owned(ctx, user, ref);
  if (found.error) return found.error;
  return ok(200, viewReservation(ctx, found.res));
}

function cancelReservation(ctx, user, ref, raw) {
  // A broken body is not a cancel. Check it before lookup so a bad payload
  // does not reveal whether this caller owns the reference. No idempotency key.
  if (raw != null && String(raw).trim() !== "") {
    const parsed = parseObject(raw);
    if (parsed.error) return parsed.error;
  }
  const found = owned(ctx, user, ref);
  if (found.error) return found.error;
  const res = found.res;
  if (res.status === "cancelled") return ok(200, viewReservation(ctx, res));
  if (cutoffPassed(res)) return fail(409, "cutoff_passed", "It is too late to change this reservation");
  res.status = "cancelled";
  res.revision += 1;
  pushHistory(res, "cancelled", []);
  const restaurant = ctx.state.restaurants[res.restaurant_id];
  bumpRestaurant(restaurant);
  if (res.series_id && ctx.state.series[res.series_id]) {
    ctx.state.series[res.series_id].revision += 1;
  }
  return ok(200, viewReservation(ctx, res));
}

function patchReservation(ctx, user, ref, raw) {
  const parsed = parseObject(raw);
  if (parsed.error) return parsed.error;
  const found = owned(ctx, user, ref);
  if (found.error) return found.error;
  const outcome = amendReservation(ctx, found.res, parsed.value);
  if (outcome.error) return outcome.error;
  return ok(200, viewReservation(ctx, found.res));
}

function amendReservation(ctx, res, body) {
  if (res.status === "cancelled") return { error: fail(409, "reservation_cancelled", "This reservation is cancelled") };

  const party = readParty(body.party_size, { required: false });
  const local = readLocal(body.starts_at_local, { required: false });
  const selection = selectionFromBody(ctx, body, { required: false });
  const parsed = party.error ? party : local.error ? local : selection.error ? selection : null;
  // A clean no-op is not a change, so the cutoff does not apply. Any real change,
  // including one whose fields are invalid, reports cutoff_passed before those errors.
  if (!parsed) {
    const nextParty = party.absent ? res.party_size : party.value;
    const nextLocal = local.absent ? res.starts_at_local : local.value;
    let pendingIds = null;
    if (!selection.absent && !sameMembers(selection.ids, res.table_ids)) pendingIds = selection.ids;
    if (!pendingIds && nextParty === res.party_size && nextLocal === res.starts_at_local) return { noop: true };
  }
  if (cutoffPassed(res)) return { error: fail(409, "cutoff_passed", "It is too late to change this reservation") };
  if (parsed) return parsed;

  const nextParty = party.absent ? res.party_size : party.value;
  const nextLocal = local.absent ? res.starts_at_local : local.value;
  const restaurant = ctx.state.restaurants[res.restaurant_id];
  let nextIds = res.table_ids;
  let pendingIds = null;
  if (!selection.absent) {
    if (sameMembers(selection.ids, res.table_ids)) nextIds = res.table_ids;
    else pendingIds = selection.ids;
  }
  const placed = place(ctx, restaurant, pendingIds || nextIds, nextLocal, nextParty, new Set([res.reference]));
  if (placed.error) return placed;

  const before = [...res.table_ids];
  const beforeLocal = res.starts_at_local;
  const beforeParty = res.party_size;
  res.table_ids = placed.table_ids;
  res.party_size = placed.party;
  res.starts_at_local = placed.starts_at_local;
  res.starts_at = placed.starts_at;
  res.ends_at = placed.ends_at;
  res.startMs = placed.startMs;
  res.endMs = placed.endMs;
  res.accepted_terms = termsOf(placed.policy);
  res.revision += 1;
  if (!res.series_id) syncSchedule(res);
  const changes = [];
  if (!sameIds(before, res.table_ids)) changes.push(tableHistory(before, res.table_ids));
  if (beforeLocal !== res.starts_at_local) {
    changes.push({ field: "starts_at_local", from: beforeLocal, to: res.starts_at_local });
  }
  if (beforeParty !== res.party_size) changes.push({ field: "party_size", from: beforeParty, to: res.party_size });
  pushHistory(res, "changed", changes);
  bumpRestaurant(restaurant);
  if (res.series_id && ctx.state.series[res.series_id]) {
    res.exception = true;
    ctx.state.series[res.series_id].revision += 1;
  }
  return { changed: true };
}

function reservationMoves(ctx, user, headers, raw) {
  const parsed = parseObject(raw);
  if (parsed.error) return parsed.error;
  const body = parsed.value;
  const gate = beginIdem(ctx, user, "POST", "/reservation-moves", headers, body);
  if (gate.error) return gate.error;
  if (gate.replay) return gate.replay;

  if (!Array.isArray(body.moves) || body.moves.length < 1 || body.moves.length > 8) {
    return fail(422, "validation_failed", "moves must contain 1 to 8 entries");
  }
  const refs = [];
  for (const move of body.moves) {
    if (!move || typeof move !== "object" || Array.isArray(move) || !isString(move.reference)) {
      return fail(422, "validation_failed", "Each move needs a reference");
    }
    refs.push(move.reference);
  }
  if (new Set(refs).size !== refs.length) return fail(422, "validation_failed", "Move references must be distinct");

  const loaded = [];
  for (const move of body.moves) {
    const found = owned(ctx, user, move.reference);
    if (found.error) return found.error;
    loaded.push({ move, res: found.res });
  }
  const restaurantId = loaded[0].res.restaurant_id;
  if (loaded.some((entry) => entry.res.restaurant_id !== restaurantId)) {
    return fail(422, "validation_failed", "Moves must stay in one restaurant");
  }

  const planned = [];
  for (const entry of loaded) {
    const outcome = planMove(ctx, entry.res, entry.move);
    if (outcome.error) return outcome.error;
    planned.push(outcome);
  }
  // No-op moves keep their current tables. Leave them visible to the occupancy
  // check; ignoring every listed reference hid a later no-op from an earlier move.
  const ignore = new Set(planned.filter((item) => !item.noop).map((item) => item.res.reference));
  const restaurant = ctx.state.restaurants[restaurantId];
  for (let i = 0; i < planned.length; i++) {
    const item = planned[i];
    if (item.noop) continue;
    if (blocked(ctx, restaurant, item.ids, item.startMs, item.endMs, ignore)) {
      return fail(409, "table_unavailable", "Those tables cannot all be held together");
    }
    for (let j = 0; j < planned.length; j++) {
      if (j === i) continue;
      const other = planned[j];
      if (!overlaps(item.startMs, item.endMs, other.startMs, other.endMs)) continue;
      if (item.ids.some((id) => other.ids.includes(id))) {
        return fail(409, "table_unavailable", "Those tables cannot all be held together");
      }
    }
  }

  const touchedSeries = new Set();
  let any = false;
  for (const item of planned) {
    if (item.noop) continue;
    any = true;
    const res = item.res;
    const before = [...res.table_ids];
    const beforeLocal = res.starts_at_local;
    const beforeParty = res.party_size;
    res.table_ids = item.ids;
    res.party_size = item.party;
    res.starts_at_local = item.starts_at_local;
    res.starts_at = item.starts_at;
    res.ends_at = item.ends_at;
    res.startMs = item.startMs;
    res.endMs = item.endMs;
    res.accepted_terms = termsOf(item.policy);
    res.revision += 1;
    if (!res.series_id) syncSchedule(res);
    const changes = [];
    if (!sameIds(before, res.table_ids)) changes.push(tableHistory(before, res.table_ids));
    if (beforeLocal !== res.starts_at_local) {
      changes.push({ field: "starts_at_local", from: beforeLocal, to: res.starts_at_local });
    }
    if (beforeParty !== res.party_size) changes.push({ field: "party_size", from: beforeParty, to: res.party_size });
    pushHistory(res, "changed", changes);
    if (res.series_id) {
      res.exception = true;
      touchedSeries.add(res.series_id);
    }
  }
  if (any) {
    bumpRestaurant(restaurant);
    for (const seriesId of touchedSeries) {
      if (ctx.state.series[seriesId]) ctx.state.series[seriesId].revision += 1;
    }
  }
  const response = { reservations: loaded.map((entry) => viewReservation(ctx, entry.res)) };
  rememberIdem(ctx, user, "POST", "/reservation-moves", gate.key, body, response);
  return ok(201, response);
}

function planMove(ctx, res, move) {
  if (res.status === "cancelled") return { error: fail(409, "reservation_cancelled", "This reservation is cancelled") };
  const party = readParty(move.party_size, { required: false });
  const local = readLocal(move.starts_at_local, { required: false });
  const selection = selectionFromBody(ctx, move, { required: false });
  const parsed = party.error ? party : local.error ? local : selection.error ? selection : null;
  const nextParty = !parsed && !party.absent ? party.value : res.party_size;
  const nextLocal = !parsed && !local.absent ? local.value : res.starts_at_local;
  let pendingIds = null;
  if (!parsed && !selection.absent && !sameMembers(selection.ids, res.table_ids)) pendingIds = selection.ids;
  if (!parsed && !pendingIds && nextParty === res.party_size && nextLocal === res.starts_at_local) {
    return {
      res,
      noop: true,
      ids: res.table_ids,
      party: res.party_size,
      starts_at_local: res.starts_at_local,
      starts_at: res.starts_at,
      ends_at: res.ends_at,
      startMs: res.startMs,
      endMs: res.endMs,
      policy: null,
    };
  }
  if (cutoffPassed(res)) return { error: fail(409, "cutoff_passed", "It is too late to change this reservation") };
  if (parsed) return parsed;
  const restaurant = ctx.state.restaurants[res.restaurant_id];
  let nextIds = res.table_ids;
  if (!selection.absent) {
    if (sameMembers(selection.ids, res.table_ids)) nextIds = res.table_ids;
    else pendingIds = selection.ids;
  }
  const seated = describeSeat(restaurant, pendingIds || nextIds, nextLocal, nextParty);
  if (seated.error) return seated;
  return { res, noop: false, ids: seated.table_ids, party: nextParty, policy: seated.policy, ...seated };
}

function validateHours(hours) {
  if (!Array.isArray(hours)) return { error: fail(422, "validation_failed", "opening_hours must be a list") };
  const seen = new Set();
  const value = [];
  for (const entry of hours) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: fail(422, "validation_failed", "An opening-hours entry is invalid") };
    }
    if (!WEEKDAYS.includes(entry.weekday) || seen.has(entry.weekday)) {
      return { error: fail(422, "validation_failed", "Weekdays must be known and unique") };
    }
    if (!isString(entry.opens) || !isString(entry.closes) || !HHMM_RE.test(entry.opens) || !HHMM_RE.test(entry.closes)) {
      return { error: fail(422, "validation_failed", "Opening hours must be HH:MM") };
    }
    if (toMin(entry.closes) <= toMin(entry.opens)) {
      return { error: fail(422, "validation_failed", "Closing time must be later the same day") };
    }
    seen.add(entry.weekday);
    value.push({ weekday: entry.weekday, opens: entry.opens, closes: entry.closes });
  }
  return { value };
}

function exportState(ctx) {
  return { track: "tablekeeper", format_version: 1, state: structuredClone(ctx.state) };
}

function importState(body) {
  if (body.track !== "tablekeeper" || body.format_version !== 1 || !body.state || typeof body.state !== "object") {
    return { error: fail(422, "validation_failed", "The import is not a tablekeeper state") };
  }
  const state = structuredClone(body.state);
  if (!state.users || !state.restaurants || !state.reservations) {
    return { error: fail(422, "validation_failed", "The import is missing state") };
  }
  // structuredClone returns ordinary objects; restore safe lookup maps on import.
  for (const key of ["users", "restaurants", "reservations", "series", "plans", "idem"]) {
    state[key] = Object.assign(Object.create(null), state[key] || {});
  }
  for (const user of Object.values(state.users)) {
    user.tokens ||= [];
    if (!user.emailKey && isString(user.email)) user.emailKey = user.email.toLowerCase();
  }
  for (const restaurant of Object.values(state.restaurants)) {
    restaurant.closures ||= [];
    restaurant.policies ||= [policyZero(restaurant)];
    restaurant.revision = restaurant.revision || 0;
    restaurant.combinable ||= [];
    restaurant.manager_user_ids ||= [];
  }
  for (const res of Object.values(state.reservations)) {
    if (!res.table_ids) res.table_ids = res.table_id ? [res.table_id] : [];
    const restaurant = state.restaurants[res.restaurant_id];
    if (restaurant && !res.accepted_terms) res.accepted_terms = termsOf(restaurant.policies[0]);
    res.revision = res.revision || 1;
    res.history ||= [];
    res.exception = Boolean(res.exception);
    res.scheduled_date ||= String(res.starts_at_local || "").slice(0, 10);
    res.scheduled_time ||= String(res.starts_at_local || "").slice(11, 16);
  }
  return { state };
}

function loadFixture(body) {
  if (!Array.isArray(body.users) || !Array.isArray(body.restaurants) || !Array.isArray(body.reservations)) {
    return { error: fail(422, "validation_failed", "Fixture must include users, restaurants and reservations") };
  }
  const state = emptyState();
  const userIds = new Set();
  const restaurantIds = new Set();
  for (const user of body.users) {
    if (!user || typeof user !== "object") return { error: fail(422, "validation_failed", "A user is invalid") };
    if (!validId(user.id) || userIds.has(user.id) || !isString(user.email) || !isString(user.password) || !isString(user.display_name)) {
      return { error: fail(422, "validation_failed", "A user is invalid") };
    }
    userIds.add(user.id);
    const emailKey = user.email.toLowerCase();
    if (Object.values(state.users).some((entry) => entry.emailKey === emailKey)) {
      return { error: fail(422, "validation_failed", "Duplicate email") };
    }
    state.users[user.id] = {
      id: user.id,
      email: user.email,
      emailKey,
      passwordHash: hashPassword(user.password),
      displayName: user.display_name,
      tokens: [],
    };
  }
  for (const raw of body.restaurants) {
    const built = loadRestaurant(raw, restaurantIds);
    if (built.error) return built;
    state.restaurants[built.restaurant.id] = built.restaurant;
  }
  const seenRefs = new Set();
  const reservationIds = new Set();
  for (const raw of body.reservations) {
    const built = loadSeedReservation(state, raw, reservationIds, seenRefs);
    if (built.error) return built;
    state.reservations[built.res.reference] = built.res;
  }
  return { state };
}

function validId(id) {
  return isString(id) && id.length >= 1 && id.length <= 64;
}

function loadRestaurant(raw, restaurantIds) {
  if (!raw || typeof raw !== "object" || !validId(raw.id) || restaurantIds.has(raw.id) || !isString(raw.name) || !isString(raw.timezone) || !validZone(raw.timezone)) {
    return { error: fail(422, "validation_failed", "A restaurant is invalid") };
  }
  restaurantIds.add(raw.id);
  if (!isInt(raw.slot_minutes) || raw.slot_minutes < 1 || raw.slot_minutes > 1440) {
    return { error: fail(422, "validation_failed", "slot_minutes is invalid") };
  }
  if (!isInt(raw.reservation_duration_minutes) || raw.reservation_duration_minutes < 1) {
    return { error: fail(422, "validation_failed", "reservation duration is invalid") };
  }
  if (!isInt(raw.cancellation_cutoff_minutes) || raw.cancellation_cutoff_minutes < 0) {
    return { error: fail(422, "validation_failed", "cancellation cutoff is invalid") };
  }
  const hours = validateHours(raw.opening_hours || []);
  if (hours.error) return hours;
  if (!Array.isArray(raw.tables) || raw.tables.length === 0) {
    return { error: fail(422, "validation_failed", "A restaurant needs tables") };
  }
  const tables = [];
  const tableIds = new Set();
  for (const table of raw.tables) {
    if (!table || !validId(table.id) || tableIds.has(table.id) || !isString(table.label) || !isInt(table.capacity) || table.capacity < 1) {
      return { error: fail(422, "validation_failed", "A table is invalid") };
    }
    tableIds.add(table.id);
    tables.push({ id: table.id, label: table.label, capacity: table.capacity });
  }
  const restaurant = {
    id: raw.id,
    name: raw.name,
    timezone: raw.timezone,
    slot_minutes: raw.slot_minutes,
    reservation_duration_minutes: raw.reservation_duration_minutes,
    cancellation_cutoff_minutes: raw.cancellation_cutoff_minutes,
    opening_hours: hours.value,
    tables,
    combinable: [],
    manager_user_ids: [],
    policies: [],
    revision: 0,
    closures: [],
  };
  restaurant.policies = [policyZero(restaurant)];
  return { restaurant };
}

function loadSeedReservation(state, raw, reservationIds, seenRefs) {
  if (!raw || typeof raw !== "object") return { error: fail(422, "validation_failed", "A reservation is invalid") };
  if (!validId(raw.id) || reservationIds.has(raw.id) || !isString(raw.reference) || !REF_RE.test(raw.reference) || seenRefs.has(raw.reference)) {
    return { error: fail(422, "validation_failed", "A reservation reference or id is invalid") };
  }
  reservationIds.add(raw.id);
  seenRefs.add(raw.reference);
  const user = state.users[raw.user_id];
  const restaurant = state.restaurants[raw.restaurant_id];
  if (!user || !restaurant) return { error: fail(422, "validation_failed", "A reservation points at an unknown owner or restaurant") };
  // table_ids belongs to the next stage. Stage 1 ignores it, including when
  // table_id is also present. Unknown fixture fields are not an error.
  const hasId = Object.prototype.hasOwnProperty.call(raw, "table_id");
  const ids = hasId ? [raw.table_id] : null;
  if (!ids) return { error: fail(422, "validation_failed", "A reservation needs a table") };
  const chosen = canonicalTables(restaurant, ids);
  if (chosen.error) return { error: fail(422, "validation_failed", "A reservation names a table that cannot be seated") };
  if (!isInt(raw.party_size) || raw.party_size < 1) return { error: fail(422, "validation_failed", "party_size is invalid") };
  if (!isString(raw.starts_at_local)) return { error: fail(422, "validation_failed", "starts_at_local is invalid") };
  const status = raw.status || "confirmed";
  if (status !== "confirmed" && status !== "cancelled") {
    return { error: fail(422, "validation_failed", "status is invalid") };
  }
  const policy = selectPolicy(restaurant, raw.starts_at_local.slice(0, 10));
  const when = classify(policy, restaurant.timezone, raw.starts_at_local);
  if (when.error) return { error: fail(422, "validation_failed", "starts_at_local cannot be seated") };
  if (raw.party_size > capacityOf(policy, chosen.ids)) {
    return { error: fail(422, "validation_failed", "party_size exceeds the table") };
  }
  const res = makeReservation(stateCtx(state), user, restaurant, {
    ...when,
    id: raw.id,
    reference: raw.reference,
    party_size: raw.party_size,
    table_ids: chosen.ids,
    status,
  });
  if (res.status === "confirmed") {
    for (const other of Object.values(state.reservations)) {
      if (other.status !== "confirmed" || other.restaurant_id !== res.restaurant_id) continue;
      if (!overlaps(res.startMs, res.endMs, other.startMs, other.endMs)) continue;
      if (res.table_ids.some((id) => other.table_ids.includes(id))) {
        return { error: fail(422, "validation_failed", "Seeded reservations overlap on a table") };
      }
    }
  }
  return { res };
}

function stateCtx(state) {
  return { state };
}
