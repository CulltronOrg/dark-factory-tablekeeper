export const CREDIT_NOTICE = "The site is out of API credits. Live agents are unavailable; all three seats are simulated.";
const ROLES = ["coordinator", "implementer", "reviewer"];
const LIVE_NOTICE = "Live agents are configured. Responses will appear after each action.";
const PROVIDER_NOTICE = "Live agents are temporarily unavailable. All three seats are simulated locally.";

export function agentPresentation(state) {
  const simulated = state.mode === "simulated";
  return {
    label: simulated ? "Simulated agents" : "Live agents",
    status: simulated ? (state.reason === "provider_error" ? PROVIDER_NOTICE : CREDIT_NOTICE) : LIVE_NOTICE,
    details: simulated
      ? "Coordinator, implementer and reviewer are simulated locally. No external agent API is called for simulated traces. This is not a judged Band run."
      : "Coordinator, implementer and reviewer use the configured provider. This is not a judged Band run.",
    waiting: simulated
      ? "Coordinator (simulated): waiting to plan. Implementer (simulated): waiting to act. Reviewer (simulated): waiting to check."
      : "Coordinator, implementer and reviewer are waiting for an action.",
  };
}

// Only a non-secret mode description reaches the page. Never serialize env,
// provider errors, request headers or unvalidated provider responses.
export function renderAgentPage(page, state) {
  const copy = agentPresentation(state);
  return page
    .replace('const initialAgentState = { mode: "simulated", reason: "missing_key" };',
      `const initialAgentState = ${JSON.stringify(state)};`)
    .replace(/(<section[^>]*id="agent-panel"[^>]*aria-label=")[^"]*/, `$1${copy.label}`)
    .replace(/(<p[^>]*id="agent-status"[^>]*>)[^<]*/, `$1${copy.status}`)
    .replace(/(<p[^>]*id="agent-details"[^>]*>)[^<]*/, `$1${copy.details}`)
    .replace(/(<div[^>]*id="agent-trace"[^>]*>\s*<p>)[^<]*/, `$1${copy.waiting}`);
}

export function reservationAction(method, pathname) {
  if (method === "GET" && pathname === "/availability") return "search";
  if (method === "POST" && pathname === "/reservations") return "book";
  if (method === "PATCH" && /^\/reservations\/[^/]+$/.test(pathname)) return "move";
  if (method === "POST" && /^\/reservations\/[^/]+\/cancel$/.test(pathname)) return "cancel";
  return null;
}

function creditsGone(status, body) {
  if (status === 402) return true;
  const error = body?.error;
  const detail = [error?.code, error?.type, error?.message, typeof error === "string" ? error : "", body?.message]
    .filter((part) => typeof part === "string").join(" ");
  // A normal rate limit (429) is not evidence that credits are exhausted.
  return /insufficient[_ -](?:quota|credits|balance|funds)|(?:credits?|quota|balance)[_ -](?:exhausted|depleted)|out[_ -]of[_ -]credits|not enough credits|credit balance.*(?:low|insufficient)|exceeded.*(?:quota|billing)|billing[_ -](?:hard[_ -]limit|limit[_ -]reached)/i.test(detail);
}

// A 400 that names a newer request parameter means this deployment wants the
// older shape. It is a request-format problem, never evidence of exhausted credits.
function unsupportedParam(status, body) {
  if (status !== 400) return null;
  const error = body?.error;
  const detail = [error?.code, error?.param, error?.message, typeof error === "string" ? error : "", body?.message]
    .filter((part) => typeof part === "string").join(" ");
  if (/max_completion_tokens/i.test(detail)) return "max_completion_tokens";
  if (/reasoning_effort/i.test(detail)) return "reasoning_effort";
  return null;
}

export function createAgents({ env = process.env, fetchProvider = globalThis.fetch, timeoutMs = 15000 } = {}) {
  // Environment only: no dotenv, credential files, repository config or logs.
  const key = typeof env.BAND_API_KEY === "string" ? env.BAND_API_KEY.trim() : "";
  let exhausted = false;
  let endpoint;
  try {
    const candidate = new URL(env.BAND_AGENT_URL);
    if (candidate.protocol === "https:" && !candidate.username && !candidate.password && !candidate.hash) endpoint = candidate.href;
  } catch { /* Missing/invalid endpoint is a configuration error, not a credit error. */ }
  const model = typeof env.BAND_AGENT_MODEL === "string" ? env.BAND_AGENT_MODEL.trim() : "";
  const state = () => !key
    ? { mode: "simulated", reason: "missing_key" }
    : exhausted ? { mode: "simulated", reason: "credits" } : { mode: "live", reason: null };

  return {
    state,
    async run(action, result) {
      if (state().mode === "simulated") return state();
      if (!endpoint || !model) return { mode: "simulated", reason: "provider_error" };
      const controller = new AbortController();
      let timer;
      try {
        // Provider summaries are advisory. The reservation engine has already
        // handled the action once; no model output can mutate or replay it.
        // Send only the action and outcome, never diner details or session data.
        const outcome = result.status >= 200 && result.status < 300 ? "succeeded" : "refused";
        const post = (role, limits, headers) => fetchProvider(endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: `You are the ${role} seat in a reservation app. Briefly explain the supplied local service outcome from your role in one sentence. The local service performs all actions. Do not claim to have performed a booking or a judged Band run. Do not invent details or expose credentials.` },
              { role: "user", content: JSON.stringify({ action, outcome }) },
            ],
            ...limits,
          }),
        });
        // Azure OpenAI key auth uses `api-key`; OpenAI-compatible endpoints use
        // a bearer token. Both carry the same environment key, never logged.
        const bothHeaders = { "api-key": key, authorization: `Bearer ${key}` };
        const seat = async (role) => {
          if (exhausted) throw new Error("provider_credits");
          if (controller.signal.aborted) throw new Error("provider_unavailable");
          // Reasoning models (for example gpt-5-mini) reject `max_tokens` and
          // spend part of the completion budget on reasoning, so ask for minimal
          // reasoning with room left for the visible sentence.
          let limits = { max_completion_tokens: 600, reasoning_effort: "minimal" };
          let headers = bothHeaders;
          let response = await post(role, limits, headers);
          let body = await response.json().catch(() => null);
          const retry = async (nextLimits, nextHeaders) => {
            if (exhausted) throw new Error("provider_credits");
            if (controller.signal.aborted) throw new Error("provider_unavailable");
            limits = nextLimits;
            headers = nextHeaders;
            response = await post(role, limits, headers);
            body = await response.json().catch(() => null);
          };
          const unsupported = unsupportedParam(response.status, body);
          if (unsupported === "max_completion_tokens") await retry({ max_tokens: 100 }, headers);
          else if (unsupported === "reasoning_effort") await retry({ max_completion_tokens: 600 }, headers);
          else if (response.status === 401 && !creditsGone(response.status, body)) {
            // Some gateways refuse a bearer value that is not an Entra token even
            // when `api-key` is valid; retry once with key-header auth only.
            await retry(limits, { "api-key": key });
          }
          if (!response.ok || body?.error) {
            if (!unsupportedParam(response.status, body) && creditsGone(response.status, body)) exhausted = true;
            throw new Error("provider_unavailable");
          }
          const content = body?.choices?.[0]?.message?.content;
          if (typeof content !== "string" || !content.trim() || content.includes(key)) throw new Error("provider_unavailable");
          return { role, text: content.trim().slice(0, 240) };
        };
        // The three seats are independent explanations of the same outcome, so
        // they run in parallel; order in the trace stays fixed by ROLES.
        const work = async () => ({ mode: "live", reason: null, seats: await Promise.all(ROLES.map(seat)) });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("provider_timeout")); }, timeoutMs);
        });
        const trace = await Promise.race([work(), timeout]);
        return exhausted ? state() : trace;
      } catch {
        // Never log provider errors: diagnostics can echo authentication headers.
        return exhausted ? state() : { mode: "simulated", reason: "provider_error" };
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    },
  };
}
