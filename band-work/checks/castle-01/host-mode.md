# Castle-01 host-mode report

This file records only commands run in this pass (2026-10-04, probe at 00:51:25Z, harness from 00:52:13Z to 00:53:13Z). Product source was not edited. Nothing was pushed.

Isolated Docker was not run. Do not treat any number below as an isolated or claimed-stage result. `claimed_stage` is null in every report this pass because these were `--base-url` host runs.

No Band account was opened. No `room.json` was written. No model API was called.

## Ash key slot

Left empty for Ash. This pass did not create, request, or spend an API key.

```
BAND_OR_MODEL_API_KEY=
```

Search, book, change, and cancel were not sent to a model. The published host harness called the local stage-4 service on `http://127.0.0.1:8080` directly. That run's stage-1 suite includes availability search, create, patch, and cancel (`stage_1/test_reservations.py`, `stage_1/test_restaurants_availability.py`, `stage_1/test_sample.py`). Stage 2 UI includes search, book, change, and cancel (`stage_2/test_ui.py`). Those files passed inside the host run below. No separate hand-written tool transcript was added.

## Stage servers

Probed `2026-10-04T00:51:25Z` (`GET /health`) and `2026-10-04T00:51:48Z` (`GET /`). All four were already listening. None were restarted.

| Stage | Port | PID | Cwd | Log | This pass |
| --- | --- | --- | --- | --- | --- |
| stage-1 | 8081 | 1462963 | `band-work/result/stage-1` | `/tmp/tk-logs/s1.log` (`listening on 8081`) | Already up. Not restarted. |
| stage-2 | 8082 | 1462967 | `band-work/result/stage-2` | `/tmp/tk-logs/s2.log` (`listening on 8082`) | Already up. Not restarted. |
| stage-3 | 8083 | 1462972 | `band-work/result/stage-3` | `/tmp/tk-logs/s3.log` (`listening on 8083`) | Already up. Not restarted. |
| stage-4 | 8080 | 3924064 | `band-work/result/stage-4` | `/tmp/tk-logs/s4.log` (`listening on 8080`) | Already up. Not restarted. |

`GET /health` was 200 `application/json` `{"status":"ok"}` (15 bytes) on 8081, 8082, 8083, and 8080.

`GET /` at `2026-10-04T00:51:48Z`:

| Port | Status | Type | Bytes |
| --- | --- | --- | --- |
| 8081 | 401 | `application/json` | 75 |
| 8082 | 200 | `text/html` | 28476 |
| 8083 | 200 | `text/html` | 28476 |
| 8080 | 200 | `text/html` | 52000 |

## Host stages 1–4

Command, from `/tmp/dark-factory-wearedevs`, Python `/tmp/df-py/bin/python`:

```sh
/tmp/df-py/bin/python -m harness run \
  --track tablekeeper --mode host \
  --base-url http://127.0.0.1:8080 \
  --previous-base-url http://127.0.0.1:8083 \
  --stages 1 2 3 4 \
  --out /workspace/dark-factory-tablekeeper/band-work/checks/castle-01/host-0051
```

Harness exit code 0. Report: `band-work/checks/castle-01/host-0051/report.json`.

- Run `dc1f3feefea74f6e9ddd6445acdcad8a`
- Mode `host`, provenance `external-url`, state `completed`
- Started `2026-10-04T00:52:13.004835+00:00`, finished `2026-10-04T00:53:03.594778+00:00`
- Suite digest `644c4bc3fcad0c4124cfc4f3fedb82d711ec301e2b288dd667c427ae147f2df1`
- Highest contiguous stage: 4
- `claimed_stage` null
- Upgrade source for stages 2–4: `http://127.0.0.1:8083` (`external-url`)

| Stage | Result | Counts | Log time |
| --- | --- | --- | --- |
| 1 | pass | 120 passed, 0 failed, 0 errors | 120 passed in 26.92s |
| 2 | pass | 25 passed, 0 failed, 0 errors | 25 passed in 19.09s |
| 3 | pass | 7 passed, 0 failed, 0 errors | 7 passed in 1.81s |
| 4 | pass | 6 passed, 0 failed, 0 errors | 6 passed in 1.37s |

Stage 2 file counts: `stage_2/test_sample.py` 8/8, `stage_2/test_ui.py` 17/17. Pytest lines were all dots: 120, 25, 7, and 6.

## Overshoot, stage 3 suite against stage-2

Expected to fail. Command, from `/tmp/dark-factory-wearedevs`:

```sh
/tmp/df-py/bin/python -m harness run \
  --track tablekeeper --mode host \
  --base-url http://127.0.0.1:8082 \
  --previous-base-url http://127.0.0.1:8081 \
  --stages 3 \
  --out /workspace/dark-factory-tablekeeper/band-work/checks/castle-01/overshoot-stage3-0051
```

Harness exit code 1. Report: `band-work/checks/castle-01/overshoot-stage3-0051/report.json`.

- Run `7065cde5cdb04116ad00079a7c48570a`
- Started `2026-10-04T00:52:13.007469+00:00`, finished `2026-10-04T00:52:15.367467+00:00`
- Suite digest `5be49d6f9f1db593b758b19f24c2149aca9db712967e07fa5db7a53b22d8a4ac`
- Stage 3: fail. 1 passed, 6 failed, 0 errors. Highest contiguous stage 0. `claimed_stage` null.
- Upgrade source: `http://127.0.0.1:8081` (`external-url`)
- Pytest line `FFF.FFF`. The pass, fourth in `stage_3/test_sample.py`, is `test_availability_is_unchanged_without_explain`.
- Failures: `POST /restaurants/r_anker/policies` 404 (`test_booking_carries_the_effective_policy_and_decision`), `explain` missing (`test_explain_accounts_for_every_table`, `test_explain_agrees_with_available_table_ids`), `GET /reservations/{ref}/history` 404 (`test_history_records_the_creation`, `test_history_records_a_change_with_the_old_value`), adopt `404 == 201` (`test_adopt_one_booking_as_a_recurring_agreement`).
- Log time: 6 failed, 1 passed in 1.93s.

## Overshoot, stage 4 suite against stage-3

Expected to fail. Command, from `/tmp/dark-factory-wearedevs`:

```sh
/tmp/df-py/bin/python -m harness run \
  --track tablekeeper --mode host \
  --base-url http://127.0.0.1:8083 \
  --previous-base-url http://127.0.0.1:8082 \
  --stages 4 \
  --out /workspace/dark-factory-tablekeeper/band-work/checks/castle-01/overshoot-stage4-0051
```

Harness exit code 1. Report: `band-work/checks/castle-01/overshoot-stage4-0051/report.json`.

- Run `a425ac02d1b0464aa493f96127cc6c13`
- Started `2026-10-04T00:53:11.447434+00:00`, finished `2026-10-04T00:53:13.265817+00:00`
- Suite digest `96af408b88b0cbd356a9c36875faed1872cd9bc8c18490b6e943233302394c85`
- Stage 4: fail. 4 passed, 2 failed, 0 errors. Highest contiguous stage 0. `claimed_stage` null.
- Upgrade source: `http://127.0.0.1:8082` (`external-url`)
- Pytest line `....FF`. Failures: `test_series_clock_time_can_be_changed` (`404 == 201`) and `test_a_closure_preview_returns_a_plan` (`POST /restaurants/r_anker/replans` 404).
- The four passes are the earlier tests in that file: `test_available_options_lists_singles_then_pairs`, `test_booking_a_declared_pair`, `test_table_id_is_still_accepted_and_means_a_set_of_one`, `test_combining_is_not_transitive`.
- Log time: 2 failed, 4 passed in 1.48s.

## Not run

Isolated mode (`--repo --mode isolated`) was not run. Docker was not invoked. `harness check` was not run. No Band account was opened. No model API was called. The key slot above is empty.
