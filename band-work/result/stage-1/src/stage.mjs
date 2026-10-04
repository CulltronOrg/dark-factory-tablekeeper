export const STAGE = 1;

// Ash's key slot, 4 Oct 2026. Empty until he sets BAND_API_KEY.
// Do not invent a key, open an account, or send this value anywhere.
const bandApiKey = process.env.BAND_API_KEY;
export const ASH_KEY_SLOT = Object.freeze({
  env: "BAND_API_KEY",
  value: typeof bandApiKey === "string" ? bandApiKey : "",
});

// Stage 1 is search, then book, then change, plus cancel.
// Screens, combined tables, policies, history, series, and replans are later stages.
// Only booking is idempotent. Change and cancel must not require a key.
export const HTTP_API = Object.freeze({
  search: Object.freeze({ method: "GET", path: "/availability", idempotency: false }),
  book: Object.freeze({ method: "POST", path: "/reservations", idempotency: true }),
  change: Object.freeze({ method: "PATCH", path: "/reservations/{reference}", idempotency: false }),
  cancel: Object.freeze({ method: "POST", path: "/reservations/{reference}/cancel", idempotency: false }),
});

// Query values stay as the client wrote them. A literal "+" is not a space, so
// party_size=+4 remains the invalid token the spec names. A broken % escape is
// left in the value, same as the platform parser, so the engine can answer 422.
export function queryFromSearch(search) {
  const out = {};
  const raw = search == null ? "" : String(search);
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  if (q === "") return out;
  for (const part of q.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawVal = eq === -1 ? "" : part.slice(eq + 1);
    out[decodeQueryPart(rawKey)] = decodeQueryPart(rawVal);
  }
  return out;
}

function decodeQueryPart(text) {
  const protectedPlus = String(text).replace(/\+/g, "%2B");
  try {
    return decodeURIComponent(protectedPlus);
  } catch {
    const repaired = protectedPlus.replace(/%(?![0-9A-Fa-f]{2})/g, "%25");
    try {
      return decodeURIComponent(repaired);
    } catch {
      // Invalid UTF-8 stays a literal token. Search answers 422. A throw here
      // would become a 500, which the API does not allow.
      return repaired;
    }
  }
}

export function pathEncodingError(pathname) {
  try {
    decodeURIComponent(pathname);
    return false;
  } catch {
    return true;
  }
}
