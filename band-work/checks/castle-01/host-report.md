# Castle-01 host-mode report

This file records only commands run in this pass (2026-10-04, after 00:46Z). Isolated Docker was not run. No `room.json` was written. No API key was created or used.

Older JSON under `host/`, `overshoot-stage3/`, and `overshoot-stage4/` was already on disk. This pass did not rerun those directories. The fresh outputs are `host-pass/`, `overshoot-stage3-pass/`, and `overshoot-stage4-pass/`.

## Servers

Checked at `2026-10-04T00:46:40Z`. All four were already listening with `GET /health` 200 `{"status":"ok"}`. None were restarted.

| Stage | Port | PID | Cwd | This pass |
|---|---|---|---|---|
| stage-1 | 8081 | 1462963 | `band-work/result/stage-1` | Already up. Not restarted. |
| stage-2 | 8082 | 1462967 | `band-work/result/stage-2` | Already up. Not restarted. |
| stage-3 | 8083 | 1462972 | `band-work/result/stage-3` | Already up. Not restarted. |
| stage-4 | 8080 | 3924064 | `band-work/result/stage-4` | Already up (`PORT=8080`). Not restarted. Log `/tmp/tk-logs/s4.log`. |

Same moment, `GET /`:

| Port | Status | Type | Bytes |
|---|---|---|---|
| 8081 | 401 | `application/json` | 75 |
| 8082 | 200 | `text/html` | 28476 |
| 8083 | 200 | `text/html` | 28476 |
| 8080 | 200 | `text/html` | 52000 |

`GET /login` was 200 `text/html` on :8080 (52000 bytes), :8082 (28476), and :8083 (28476). `GET /app.js` and `GET /app.css` on those three ports returned 401 `application/json`, 75 bytes. Chromium from `/tmp/df-py` launched headless (`153.0.8010.12`) before the harness.

## Host stages 1–4

Command, from `/tmp/dark-factory-wearedevs`:

```sh
/tmp/df-py/bin/python -m harness run \
  --track tablekeeper --mode host \
  --base-url http://127.0.0.1:8080 \
  --previous-base-url http://127.0.0.1:8083 \
  --stages 1 2 3 4 \
  --out /workspace/dark-factory-tablekeeper/band-work/checks/castle-01/host-pass
```

Harness exit code 0. Report: `band-work/checks/castle-01/host-pass/report.json`.

- Run `ee3e58e642bb40cbb3ee166bec6b4175`
- Mode `host`, provenance `external-url`, state `completed`
- Started `2026-10-04T00:48:08.435715+00:00`, finished `2026-10-04T00:48:59.666496+00:00`
- Suite digest `644c4bc3fcad0c4124cfc4f3fedb82d711ec301e2b288dd667c427ae147f2df1`
- Highest contiguous stage: 4
- `claimed_stage` null
- Upgrade source for stages 2–4: `http://127.0.0.1:8083` (`external-url`)

| Stage | Result | Counts | Log time |
|---|---|---|---|
| 1 | pass | 120 passed, 0 failed, 0 errors | 120 passed in 26.63s |
| 2 | pass | 25 passed, 0 failed, 0 errors | 25 passed in 20.43s |
| 3 | pass | 7 passed, 0 failed, 0 errors | 7 passed in 1.57s |
| 4 | pass | 6 passed, 0 failed, 0 errors | 6 passed in 1.27s |

Stage 2 file counts: `stage_2/test_sample.py` 8/8, `stage_2/test_ui.py` 17/17.

## Overshoot, stage 3 suite against stage-2

Expected to fail. Command, from `/tmp/dark-factory-wearedevs`:

```sh
/tmp/df-py/bin/python -m harness run \
  --track tablekeeper --mode host \
  --base-url http://127.0.0.1:8082 \
  --previous-base-url http://127.0.0.1:8081 \
  --stages 3 \
  --out /workspace/dark-factory-tablekeeper/band-work/checks/castle-01/overshoot-stage3-pass
```

Harness exit code 1. Report: `band-work/checks/castle-01/overshoot-stage3-pass/report.json`.

- Run `bded7249e53840fa95307a5c9c22fcea`
- Started `2026-10-04T00:48:08.435593+00:00`, finished `2026-10-04T00:48:10.589604+00:00`
- Suite digest `5be49d6f9f1db593b758b19f24c2149aca9db712967e07fa5db7a53b22d8a4ac`
- Stage 3: fail. 1 passed, 6 failed, 0 errors. Highest contiguous stage 0. `claimed_stage` null.
- Pytest line `FFF.FFF`. The pass, fourth in `stage_3/test_sample.py`, is `test_availability_is_unchanged_without_explain`.
- Failures: `POST /restaurants/r_anker/policies` 404, `explain` missing on the slot (`test_explain_accounts_for_every_table`, `test_explain_agrees_with_available_table_ids`), `GET /reservations/{ref}/history` 404 (creation and change), adopt `404 == 201`.
- Log time: 6 failed, 1 passed in 1.79s.

## Overshoot, stage 4 suite against stage-3

Expected to fail. Command, from `/tmp/dark-factory-wearedevs`:

```sh
/tmp/df-py/bin/python -m harness run \
  --track tablekeeper --mode host \
  --base-url http://127.0.0.1:8083 \
  --previous-base-url http://127.0.0.1:8082 \
  --stages 4 \
  --out /workspace/dark-factory-tablekeeper/band-work/checks/castle-01/overshoot-stage4-pass
```

Harness exit code 1. Report: `band-work/checks/castle-01/overshoot-stage4-pass/report.json`.

- Run `ec035649900841a695d8f093fd1af5b7`
- Started `2026-10-04T00:49:08.871843+00:00`, finished `2026-10-04T00:49:10.745443+00:00`
- Suite digest `96af408b88b0cbd356a9c36875faed1872cd9bc8c18490b6e943233302394c85`
- Stage 4: fail. 4 passed, 2 failed, 0 errors. Highest contiguous stage 0. `claimed_stage` null.
- Pytest line `....FF`. Failures: `test_series_clock_time_can_be_changed` (`404 == 201`) and `test_a_closure_preview_returns_a_plan` (`POST /restaurants/r_anker/replans` 404).
- The four passes are the earlier tests in that file: `test_available_options_lists_singles_then_pairs`, `test_booking_a_declared_pair`, `test_table_id_is_still_accepted_and_means_a_set_of_one`, `test_combining_is_not_transitive`.
- Log time: 2 failed, 4 passed in 1.54s.

## Not run

Isolated mode (`--repo --mode isolated`) was not run. Docker was not used. `harness check` was not run. No Band account was opened. No model API was called.
