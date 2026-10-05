# Culltron Nightshift

Tablekeeper entry for WeAreDevelopers × BAND: Dark Factory. Nightshift is the reservation product: one restaurant book, tables that cannot be held twice, a browser a diner can use at 375px.

This repository is the result repo, separate from `band-ai/dark-factory-wearedevs`.

## Read this first

The service in `stage-1` through `stage-4` is a reference implementation written in this workspace. It is **not** yet the output of a judged Band room. There is no `room.json`, the mandate harness and model lines are `UNCONFIGURED` on purpose, and nothing here should be described as an autonomous factory run. `FACTORY.md` is the takeover note for that run.

## Map

| Path | What it is |
|---|---|
| `stage-1/` … `stage-4/` | Standalone service for that stage. Each has a `Dockerfile` and `RUN.md`. |
| `mandates/` | Generic seat mandates. Fill harness and model before the judged run. |
| `FACTORY.md` | How the factory is supposed to work, and what is blocked. |
| `SUBMISSION.md` | LabLab copy and the video shot list. |
| `LICENSE` | MIT. |

`stage-N` serves only the behavior required through stage N. A later folder is the earlier service plus the next stage's behavior.

## Run a stage

From that stage's folder, follow `RUN.md`. Without Docker:

```sh
cd stage-4
npm ci
PORT=8080 node src/server.mjs
```

`GET /health` returns `{"status":"ok"}`. The process listens on `0.0.0.0` and `$PORT` (default `8080`).

Stages 2, 3 and 4 also serve the Nightshift UI at `/`, `/login`, `/signup` and `/lookup`. Stage 1 is JSON only.

## Checks that were actually run

After `npm ci` in each stage folder, run `node tests/identifier-maps.test.mjs` from this directory for 16 local regression checks. They use public routes and empty-user fixtures to verify unknown IDs and reserved restaurant/table IDs through reset and export/import, without credentials.

Host-mode checks against the official harness are recorded under `../checks/` when present (that directory is not part of the submission). The `rerun-20261004` and later `castle-01/host-0215` runs each record stages 1–4 passing 120/120, 25/25, 7/7 and 6/6 published tests. Both predate the 4 October dictionary fix, which has only focused local checks. Their `claimed_stage` is null because they used `--base-url`; neither is an isolated or judged result. The earlier `after-edges-s4`, `after-edges-s1`, `after-edges-s2-overshoot` and `after-edges-s3-overshoot` reports document preceding host checks and stage boundaries. Other older directories are from earlier engine revisions. Re-run from a checkout of the challenge repo. Stages 2 and later need the previous stage's base URL:

```sh
python -m harness run --track tablekeeper --base-url http://127.0.0.1:8080 --previous-base-url http://127.0.0.1:8083 --stages 1 2 3 4 --out /tmp/nightshift-stage4
```

Isolated mode needs Docker, which this workspace does not have:

```sh
python -m harness run --track tablekeeper --repo . --all --mode isolated
python -m harness check . --track tablekeeper
```

`harness check` cannot pass until a real full-session `room.json` is saved at the repository root and each mandate names the harness and model that seat actually ran.

## Brand

Nightshift. Line: "Tables, held once." Paper, ink, oxblood. Literata and Outfit are vendored in the image; the page does not call a font CDN.
