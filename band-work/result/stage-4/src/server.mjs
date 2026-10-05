import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createService } from "./engine.mjs";
import { createAgents, renderAgentPage, reservationAction } from "./agents.mjs";
import { HTTP_API, STAGE, pathEncodingError, queryFromSearch } from "./stage.mjs";

if (STAGE !== 4
  || HTTP_API.search.method !== "GET" || HTTP_API.search.path !== "/availability" || HTTP_API.search.idempotency !== false
  || HTTP_API.book.method !== "POST" || HTTP_API.book.path !== "/reservations" || HTTP_API.book.idempotency !== true
  || HTTP_API.change.method !== "PATCH" || HTTP_API.change.path !== "/reservations/{reference}" || HTTP_API.change.idempotency !== false
  || HTTP_API.cancel.method !== "POST" || HTTP_API.cancel.path !== "/reservations/{reference}/cancel" || HTTP_API.cancel.idempotency !== false
  || HTTP_API.pages.join(",") !== "/,/login,/signup,/lookup"
  || HTTP_API.policies.method !== "POST" || HTTP_API.policies.path !== "/restaurants/{id}/policies" || HTTP_API.policies.idempotency !== true
  || HTTP_API.history.method !== "GET" || HTTP_API.history.path !== "/reservations/{reference}/history"
  || HTTP_API.decision.method !== "GET" || HTTP_API.decision.path !== "/reservations/{reference}/decision"
  || HTTP_API.series.method !== "POST" || HTTP_API.series.path !== "/series" || HTTP_API.series.idempotency !== true
  || HTTP_API.replans.method !== "POST" || HTTP_API.replans.path !== "/restaurants/{id}/replans" || HTTP_API.replans.idempotency !== true
  || HTTP_API.apply.method !== "POST" || HTTP_API.apply.path !== "/restaurants/{id}/replans/{plan_id}/apply" || HTTP_API.apply.idempotency !== true
  || HTTP_API.amend.method !== "POST" || HTTP_API.amend.path !== "/series/{series_id}/amend" || HTTP_API.amend.idempotency !== true) {
  throw new Error("stage-4 HTTP API is misconfigured");
}

const service = createService(STAGE);
const agents = createAgents();
if (process.env.DEMO === "1") {
  const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((weekday) => ({
    weekday, opens: "17:00", closes: "23:00",
  }));
  service.handle("POST", "/_test/reset", {}, {}, JSON.stringify({
    users: [],
    restaurants: [{
      id: "r_late",
      name: "The Late Room",
      timezone: "Europe/Berlin",
      slot_minutes: 30,
      reservation_duration_minutes: 90,
      cancellation_cutoff_minutes: 120,
      opening_hours: days,
      tables: [
        { id: "t_window", label: "Window", capacity: 2 },
        { id: "t_banquette", label: "Banquette", capacity: 4 },
        { id: "t_round", label: "Round", capacity: 6 },
      ],
      combinable: [["t_window", "t_banquette"]],
    }],
    reservations: [],
  }));
}
const page = STAGE >= 2 ? readFileSync(new URL("./app.html", import.meta.url), "utf8") : "";
const fonts = STAGE >= 2 ? {
  "/fonts/literata-400.woff2": readFileSync(new URL("./fonts/literata-400.woff2", import.meta.url)),
  "/fonts/literata-700.woff2": readFileSync(new URL("./fonts/literata-700.woff2", import.meta.url)),
  "/fonts/outfit-400.woff2": readFileSync(new URL("./fonts/outfit-400.woff2", import.meta.url)),
  "/fonts/outfit-600.woff2": readFileSync(new URL("./fonts/outfit-600.woff2", import.meta.url)),
} : {};

let turn = Promise.resolve();

function exclusively(fn) {
  const run = turn.then(() => fn());
  turn = run.then(() => {}, () => {});
  return run;
}

function plainHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = key.toLowerCase();
    if (Array.isArray(value)) out[name] = value[0] == null ? "" : String(value[0]);
    else out[name] = value == null ? "" : String(value);
  }
  return out;
}

function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      sendJson(res, 400, { error: { code: "malformed_request", message: "The request URL is not valid" } });
      return;
    }
    const raw = await readRaw(req);
    if (req.method === "GET" && fonts[url.pathname]) {
      const body = fonts[url.pathname];
      res.writeHead(200, {
        "content-type": "font/woff2",
        "content-length": body.length,
        "cache-control": "public, max-age=86400",
      });
      res.end(body);
      return;
    }
    if (STAGE >= 2 && req.method === "GET" && HTTP_API.pages.includes(url.pathname)) {
      const body = Buffer.from(renderAgentPage(page, agents.state()));
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (pathEncodingError(url.pathname)) {
      sendJson(res, 400, { error: { code: "malformed_request", message: "The request URL is not valid" } });
      return;
    }
    if (process.env.DISABLE_TEST_ROUTES === "1") {
      // Public hosting: harness-only routes are hidden. Internal demo seeding
      // calls the service directly and is unaffected.
      let decoded = url.pathname;
      try { decoded = decodeURIComponent(url.pathname); } catch { /* checked above */ }
      if (decoded.toLowerCase().replace(/\/+/g, "/").startsWith("/_test")) {
        sendJson(res, 404, { error: { code: "not_found", message: "No such resource" } });
        return;
      }
    }
    const query = queryFromSearch(url.search);
    const result = await exclusively(() => service.handle(
      req.method || "GET",
      url.pathname,
      query,
      plainHeaders(req.headers),
      raw,
    ));
    if (res.writableEnded || res.destroyed) return;
    if (result.status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    const action = reservationAction(req.method, url.pathname);
    const agentTrace = action ? await agents.run(action, result) : null;
    sendJson(res, result.status, result.body, agentTrace
      ? { "x-nightshift-agents": encodeURIComponent(JSON.stringify(agentTrace)) } : {});
  } catch (error) {
    const tooLarge = error && error.code === "body_too_large";
    if (!tooLarge) console.error(error);
    if (res.writableEnded || res.destroyed) return;
    const payload = tooLarge
      ? { error: { code: "malformed_request", message: "Request body is too large" } }
      : { error: { code: "internal", message: "The service failed" } };
    sendJson(res, tooLarge ? 400 : 500, payload);
  }
});

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2_000_000) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const error = new Error("body too large");
        error.code = "body_too_large";
        reject(error);
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

const port = Number(process.env.PORT || 8080);
server.listen(port, "0.0.0.0", () => {
  console.log(`listening on ${port}`);
});
