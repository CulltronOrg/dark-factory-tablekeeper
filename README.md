# Tablekeeper (Culltron Nightshift)

Entry for the WeAreDevelopers x BAND Dark Factory hackathon, Tablekeeper track. Nightshift is a restaurant reservation app: search for a table, book it, move it, and cancel it. Three AI agent seats (coordinator, implementer, reviewer) add a short note after every action.

- **Live demo:** https://tablekeeper-booking.ashyisland-1f4bbbad.eastus.azurecontainerapps.io/
- **Video:** https://youtu.be/6mPcC5qp_Og
- **Code:** [`band-work/result/stage-4`](band-work/result/stage-4) is the full app. Stages 1 to 3 are the earlier steps of the same service.

## What judges need to do

### Option A: try the live demo (about 2 minutes)

1. Open the live demo link above. The note at the top says whether live agents are connected.
2. On the home page, keep **The Late Room**, pick any future date and a party size, and press **Find a table**.
3. Click an open time, then a free table (for example **Window**). The panel on the right shows your choice.
4. Press **Create an account** (or **Sign in**). Use any made-up email and password; accounts are held in memory only. You come back to the same table, still selected.
5. Press **Confirm reservation**. The three agent seats each add a note.
6. Open **My bookings** and choose the booking.
7. To move it, pick another time or table and press **Save changes**. Only free tables are offered.
8. To cancel, press **Cancel reservation**. You can choose **Keep reservation**, or **Yes, cancel reservation** to free the table.

The live demo restarts with an empty book whenever the container restarts, so old test accounts may disappear. If the agent provider is unavailable or out of credits, the app keeps working and shows that the three seats are simulated.

### Option B: run it locally (Node 22)

```sh
cd band-work/result/stage-4
npm ci
env -u BAND_API_KEY npm run demo
```

Open http://localhost:8080 and follow the same steps as Option A. Without a key the agent seats are simulated, which is expected; no account or key is needed.

### Option C: Docker

```sh
cd band-work/result/stage-4
docker build -t nightshift .
docker run --rm -e PORT=8080 -e DEMO=1 -p 8080:8080 nightshift
```

Drop `-e DEMO=1` to start with an empty restaurant book (this is what the API harness expects).

### Run the tests

```sh
cd band-work/result/stage-4
npm ci
env -u BAND_API_KEY npm test
```

68 local tests cover search, booking, moves, cancellation, retries, combined tables, sign-in carry-over, and both the live and simulated agent modes (provider calls are mocked).

### Official harness

The service listens on `0.0.0.0:$PORT` (default 8080) and `GET /health` returns `{"status":"ok"}`. Leave `DISABLE_TEST_ROUTES` unset when running the harness, because it needs the `/_test/*` routes. See the harness commands in [`band-work/result/README.md`](band-work/result/README.md).

## Optional: live agent seats

The app reads these from its environment only. Nothing is read from files, and no key is ever sent to the browser or written to logs.

| Variable | Purpose |
|---|---|
| `BAND_API_KEY` | Key for an OpenAI-compatible or Azure OpenAI chat endpoint. Leave unset for simulated seats. |
| `BAND_AGENT_URL` | Full HTTPS chat-completions URL for that provider. |
| `BAND_AGENT_MODEL` | Model or deployment name (the demo used gpt-5-mini). |
| `DISABLE_TEST_ROUTES` | Set to `1` on a public host so `/_test/*` returns 404. Leave unset for the harness. |

Only the action name and whether it succeeded are sent to the provider. No diner details, references, or session tokens leave the service. The reservation engine decides every booking; agent notes are advisory.

## Honest status

- The live demo and the video are real recordings of this code running on Azure Container Apps, with live agent notes from gpt-5-mini.
- This is **not** a judged Band room run. No `room.json` exists, and the code was not produced by an autonomous factory session. See [`band-work/result/FACTORY.md`](band-work/result/FACTORY.md).
- Storage is in memory. Restarting the server clears accounts and bookings.
- No keys, tokens, or private endpoints are in this repository.

## Layout

| Path | What it is |
|---|---|
| `band-work/result/stage-1` to `stage-4` | The service at each stage, each with a `Dockerfile` and `RUN.md`. |
| `band-work/result/stage-4/RUN.md` | Full run and configuration notes for the final app. |
| `band-work/result/SUBMISSION.md` | LabLab submission copy. |
| `band-work/result/tests` | Shared regression tests. |
| `band-work/pitch` | Cover, deck, and narration script. |

License: MIT (see `band-work/result/LICENSE`).
