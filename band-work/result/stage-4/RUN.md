# Run

## Try the reservation app locally

From this directory:

```sh
npm ci
env -u BAND_API_KEY npm run demo
```

Open `http://localhost:8080`. The populated demo opens The Late Room for dinner.
Choose a date, guest count and table; create an account or sign in to confirm.
Your selected table carries through sign-in. **My bookings** lists your
reservations and lets you move the time, table or party size. Cancellation asks
for confirmation and includes a **Keep reservation** option.

The server reads **`BAND_API_KEY` from its process environment only**. It does
not load `.env`, repository credentials, Band connector configuration, or secret
files. No credential is sent to the browser or included in logs or traces.

With a nonempty key, pages initially show **Live agents are configured.
Responses will appear after each action.** Live calls also require
`BAND_AGENT_URL` (the full HTTPS chat-completions endpoint for that key's
provider) and `BAND_AGENT_MODEL` (that provider's model identifier). Configure
these through the launch environment. There is no guessed endpoint or model,
and redirects are rejected. This is a separate app integration; it does not use
Band connector transport credentials or a provider credential saved in Band.
Each request sends the key in both an `api-key` header (Azure OpenAI key auth)
and an `Authorization: Bearer` header (OpenAI-compatible endpoints), with
`model`, `messages`, `max_completion_tokens` and `reasoning_effort: "minimal"`
(suited to reasoning models such as gpt-5-mini). If the endpoint answers 400
naming `max_completion_tokens` as unsupported, that seat retries once with
`max_tokens`; if it names `reasoning_effort`, the seat retries once without it.
A 401 retries once with only the `api-key` header. These format retries never
count as exhausted credits. Text is read from `choices[0].message.content`.

After each search, booking, move or cancellation, the provider supplies a short
response for each of the coordinator, implementer and reviewer roles. Only the
action name and whether the local service succeeded or refused it are sent;
no diner details, reservation references or session tokens leave the service.
The reservation engine performs and validates the action once, independently
of the provider. Provider responses are advisory, not booking authority or proof
of a judged Band run.

When the key is missing, empty or whitespace, or a provider response reports
exhausted credits, every page shows exactly:

> The site is out of API credits. Live agents are unavailable; all three seats are simulated.

The three seats then show a local trace: coordinator **planned**, implementer
**done**, reviewer **checked**. Refused actions and unanswered requests retain
their failure labels. Simulated traces make no provider calls and stay only in
the current page's memory; navigation or reload clears them. Credit exhaustion
is remembered until the server restarts. The required missing-key notice is a
fallback message, not a billing-balance check.

Missing endpoint/model configuration, authentication errors, ordinary rate
limits and other provider failures also preserve booking operations and use
local simulation, with a separate temporary-unavailability notice. They do not
claim that credits are exhausted, and the next action retries the provider.
The three seats are requested in parallel, with a fifteen-second total deadline
per action. Supply updated environment
configuration and restart the server to change the provider or key.

The app displays restaurant-local times, seating duration and the cancellation
cutoff. Availability includes individual and joined tables; the service validates
every booking and move against the current book. The interface adapts to phones
and uses local fonts and illustrations, with no external asset requests.

`npm start` runs the empty service required by the API harness. `npm run demo`
adds the restaurant fixture. Both use `PORT` (default `8080`). No provider key is
needed. Demo accounts and reservations are held in memory until the server stops.

Run the local regression suites with `env -u BAND_API_KEY npm test`. They cover
identifier handling, the reservation lifecycle, retry safety, ownership,
combined tables, failed changes, startup without provider keys and the page
script. The UI suite executes the page script with an in-process DOM adapter
and the real service, including
selection across sign-in, simulated agent traces, booking management and error
recovery. The demo suite also loads the server in a separate process with a
clean, credential-free environment and exercises its actual search, book, move
and cancel handlers through a request adapter, with outbound clients disabled.
Tests under `tests/` also cover synthetic-key live mode, missing/empty keys,
credit exhaustion, other provider failures, and the reservation lifecycle in
both modes. Provider calls are mocked; no real key or provider call is needed.
These adapters do not render CSS or replace live browser or HTTP listener checks.
These are local checks, separate from the official harness.

## Run with Docker

Build and start the service:

```sh
docker build -t nightshift .
docker run --rm -e PORT=8080 -p 8080:8080 nightshift
```

The process listens on `0.0.0.0` and the port in `PORT` (default `8080`). No other setup is required. `GET /health` returns `{"status":"ok"}` when the service can take requests.

For a populated demo, start the same image with `DEMO=1`:

```sh
docker run --rm -e PORT=8080 -e DEMO=1 -p 8080:8080 nightshift
```

Open `http://localhost:8080/`, create an account at `/signup`, then choose a
date and a table at The Late Room. The demo restaurant opens daily from 17:00
to 23:00 in Europe/Berlin, with 90-minute reservations. Choose a future date
to exercise changes and cancellation before the two-hour cutoff. `/login`
signs in again; `/lookup` lists bookings and looks up a reservation reference.
Without `DEMO=1`, the service starts with an empty restaurant book.

All state is in memory and is lost when the process exits. Dependencies are
installed during image build. Simulation and vendored fonts need no outbound
network at runtime. Live mode needs outbound HTTPS to the configured provider.
To pass already configured variables into Docker without putting values in a
command, add `-e BAND_API_KEY -e BAND_AGENT_URL -e BAND_AGENT_MODEL`.

For local assessment with dependencies already installed (the image uses
Node 22):

```sh
env -u BAND_API_KEY PORT=8080 DEMO=1 node src/server.mjs
```

From the result directory, these checks exercise service logic without opening
a port. The demo checks also parse the page script and verify font files;
they do not replace live HTTP, browser, Docker, or official harness checks.

```sh
env -u BAND_API_KEY node tests/identifier-maps.test.mjs
env -u BAND_API_KEY node tests/stage-4-demo.test.mjs
```

## Public hosting

Set `DISABLE_TEST_ROUTES=1` on a public host so the harness-only `/_test/*` routes return 404. Leave it unset for the judging harness, which needs them.
