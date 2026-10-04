# Factory

Status of this file: **the judged run has not happened.** Costs, review findings, and stage claims below are only what this workspace could measure. Do not invent the rest at submission time.

## What is done

A spec-faithful Tablekeeper service exists in four stage folders. In this workspace it was checked, in host mode, against the published harness. See the handoff at the bottom for the last commands and results. Docker is not installed here, so gate 3 (isolated build) was not run. Band Desktop is not installed here, so gates 1 and 2 have no real room.

## Seat roster

| Seat | Mandate | Writes the service? | Approves a stage? |
|---|---|---|---|
| coordinator | `mandates/coordinator.md` | No | Only by naming a revision the reviewer accepted |
| implementer | `mandates/implementer.md` | Yes | No |
| reviewer | `mandates/reviewer.md` | No. Also writes independent checks. | Yes, of a revision they built |

Three seats is the minimum. The reviewer is also the tester. The coordinator is not the reviewer.

Harness and model for every seat are `UNCONFIGURED`. Band Desktop must fill those lines with the values it actually shows. Empty lines fail `harness check`. Invented model ids are not acceptable either.

## Why this shape

The product is one Node 22 process with in-memory state. Luxon supplies the IANA zones. Mutations happen after the body is read, on a single thread, so concurrent requests commit in some serial order. Passwords are scrypt. Idempotency is stored per user, method, path and key, after parse and authentication and before field checks. Each stage folder is a complete image so a judge can build it alone. The stage constant in `src/stage.mjs` is what stops an earlier folder from answering a later stage's suite.

The UI is Nightshift, served by the same process from files inside the image.

## Handoff protocol

1. Human dispatches one stage by pasting that stage's requirements to the coordinator. Then the human stops.
2. Coordinator adds the other two seats if they are absent, then sends the implementer a self-contained handoff with the requirements pasted in full.
3. Implementer commits in this repository, under the stage folder only, and replies with the revision and the real command output.
4. Coordinator sends the reviewer the same requirements plus that revision.
5. Reviewer builds that revision, runs the official checks, runs at least one extra check taken from the requirements, and either accepts that revision or rejects with a command the implementer can re-run.
6. Repeat 3–5 until acceptance. Coordinator reports the accepted revision to the human. Next stage is a new dispatch in the **same** room.

Messages that address another seat use Band's `@[[seatId]]` form. There must be at least one exchange in each direction between two of our seats. Export the room with Download full session, not a filtered download.

## What was measured on 3 October 2026

Host mode only, published harness, after the edge-case edits in this session (missing login fields are 422 and wrong JSON types are 400, series and replan fields follow that split, a reset rejects an overlapping or over-capacity seed without replacing state, a body over 2_000_000 bytes returns 400 `malformed_request`). Isolated mode was not run. `docker` is not on `PATH`. Node on this machine is v20.19.2; the image asks for Node 22. Host mode does not prove the image builds. `claimed_stage` is null in every report below because these were `--base-url` runs, not `--repo`.

| Report | What ran | Result |
|---|---|---|
| `band-work/checks/after-edges-s4` | stage-4 on :8080, previous stage-3 on :8083, stages 1–4. Run `a77961d31f6b49aeae011c897d0af13d`, 20:01:11Z–20:02:02Z | pass 120, 25, 7, 6. Highest contiguous stage 4 |
| `band-work/checks/after-edges-s1` | stage-1 on :8081, stage 1 only. Run `b9b9f91e4a52482890405c7087ec4c78`, 20:02:22Z–20:02:50Z | pass 120/120. Highest contiguous stage 1 |
| `band-work/checks/after-edges-s2-overshoot` | stage-2 on :8082, previous stage-1 on :8081, stage 3 only. Run `99c9e307849a4f66a0b478bcbb0b361a` | fail 1/7 passed, 6 failed, 0 errors. Policies, explain, history and adopt are 404 or missing. Highest contiguous stage 0 because stage 3 was the only stage requested |
| `band-work/checks/after-edges-s3-overshoot` | stage-3 on :8083, previous stage-2 on :8082, stage 4 only. Run `ae0e2259789040288bcd40abf7c0a536` | fail 4/6 passed, 2 failed, 0 errors. Series amend and `POST /restaurants/r_anker/replans` are 404. Highest contiguous stage 0 because stage 4 was the only stage requested |
| `band-work/checks/rerun-20261004` | stage-4 on :8080, previous stage-3 on :8083, stages 1–4, after the lookup change form started following party, date and time without waiting for blur, and seat counts from the policy for that date. Run `9cb59e2c6e26422fab88b0055f60e2bd`, 2026-10-03T23:24:36Z–23:25:28Z | pass 120, 25, 7, 6. Highest contiguous stage 4. `claimed_stage` null. Isolated mode was not run |

Older directories under `band-work/checks/` are from earlier engine revisions. They are not the measurement for this tree. The `rerun-20261004` row is a later host-mode run of the same published harness against this tree.

An in-process probe of the stage-4 engine printed `probe ok`. It covered login field types, a normal three-date series amend, replan ranking onto the tighter table, and seed rejection that leaves the previous booking in place. A POST larger than 2_000_000 bytes to :8080 returned 400 `malformed_request`. `GET /` on :8081 returned 401. `GET /` on :8080 returned 200 `text/html` (28476 bytes). At a 375px viewport, signing in, searching party 6, and booking Window + Banquette showed both labels in the summary and in `confirmation-tables`, and `scrollWidth` was 375. That combo check was not repeated at a desktop width in this session.

`python -m harness check` on this tree reports one problem: `room.json` is missing.

## What the factory has not done

- No Band room was opened.
- No agent sent a message to another agent.
- No seat rejected a revision, because no seat ran.
- No token or dollar cost was measured. Do not write a number.
- The commits in this repository, if any, were made while preparing the reference service. They are not agent handoffs. The judged run should use a fresh room and should not pretend these commits are that run. If the rules require the submitted code to come from the room, the implementer seat has to produce the stage folders during that run. Use this tree as the specification of behavior, not as a fake history.

## Known limits of the reference service

- State is memory only. A container restart drops it. The spec allows that.
- Planning searches at most 6 tables, 4 pairs and 6 considered bookings, then returns `planning_limit`.
- Host-mode harness does not prove the image builds. Run isolated mode on a machine with Docker before calling any stage claimed.
- Hidden checks are most of stages 2, 3 and 4. Passing the published files is not a claim on the graded suite.

## Pointing the same factory at another problem

Keep the three mandates. Change only the human's opening message: paste the new requirements, the new result repository path, and the new check command. The seats never learn the product from the mandate files.

## Setup on a machine that can finish the entry

1. Install Band Desktop, sign in, and confirm three seats can join one room.
2. Install Docker and Python 3.12. From the challenge checkout: `python -m venv .venv && .venv/bin/pip install -r harness/requirements.txt && .venv/bin/python -m playwright install --with-deps chromium`.
3. Put the real harness and model on the first line of each mandate.
4. Open a fresh room, add all three seats, dispatch stage 1, and do not steer.
5. After the room accepts stage 4, download the full session to `room.json` at this repository root. Read it for credentials before the repo is public. Rotate anything that leaked.
6. Push the public git history from that run. Clone it somewhere else. Run `python -m harness check <clone> --track tablekeeper` and `python -m harness run --track tablekeeper --repo <clone> --all --mode isolated`.
7. Record the room, then the product, using `SUBMISSION.md`.

## Takeover

```
STATUS
Reference service written and split into stage-1..stage-4.
Judged factory run NOT started.

DONE
- Official specs read from the cloned challenge repo.
- Node 22 service: auth, availability, bookings, moves, idempotency, DST, export/import,
  combined tables, Nightshift UI, policies, history, series, series amend, closure replan.
- Vendored fonts. Dockerfile and RUN.md in every stage folder.
- Generic mandates with UNCONFIGURED harness/model lines.
- In-process probe printed `probe ok` (login types, series amend, replan rank, seed rejection).
- Published harness, host mode, after those edits: see “What was measured on 3 October 2026”.

CURRENT STAGE
Reference behavior is stage 4. Claimed judged stage: none.

LAST GOOD COMMIT
No judged revision. See git log in this repo if a preparation commit exists.

HARNESS RESULTS
Host mode only, against a process started with `node src/server.mjs` (Node v20.19.2).
Stage-4 server, suites 1–4, after the lookup change-form edit: pass 120/25/7/6. Report: band-work/checks/rerun-20261004/report.json. Run `9cb59e2c6e26422fab88b0055f60e2bd`, 2026-10-03T23:24:36Z–23:25:28Z. claimed_stage null. Isolated mode was not run.
Earlier stage-4 server, suites 1–4: pass 120/25/7/6. Report: band-work/checks/after-edges-s4/report.json.
Stage-1 server, suite 1: pass 120/120. Report: band-work/checks/after-edges-s1/report.json.
Stage-2 server, suite 3: fail 1 passed, 6 failed, 0 errors.
Stage-3 server, suite 4: fail 4 passed, 2 failed, 0 errors.
claimed_stage: null on all four reports. Isolated mode: BLOCKED, docker not on PATH.
Suite 2 was not re-run against the stage-1 server in this session.

BAND ROOM / SEATS STATUS
BLOCKED. No Band Desktop, no Band CLI, no seats, no room.json.
`harness check` on 3 October 2026: 1 problem, room.json is missing.

FILES/REPO LOCATION
/workspace/dark-factory-tablekeeper/band-work/result
Challenge package used: /tmp/dark-factory-wearedevs
Harness python: /tmp/df-py/bin/python
Stage servers in this workspace: stage-1 :8081, stage-2 :8082, stage-3 :8083, stage-4 :8080.

FAILURES/BLOCKERS
1. Band Desktop cannot be installed or driven from this sandbox. Without it the entry is not a factory submission.
2. Docker is absent, so `harness run --repo --mode isolated` cannot be executed here.
3. room.json must be downloaded by a human from the Band console. Do not synthesize one.
4. GitHub push was not done. Connect a repo and push only after you decide whether this tree is the public reference or the post-run tree.

NEXT EXACT COMMAND/ACTION
On a machine with Band and Docker:
- Fill Harness and Model in mandates/*.md from the live seats.
- Create a fresh room with coordinator, implementer, reviewer.
- Dispatch stage 1 by pasting tablekeeper/spec/stage-1.md and the path of a fresh result repo.
- Do not send another steering message.
After the run:
  python -m harness check <repo> --track tablekeeper
  python -m harness run --track tablekeeper --repo <repo> --all --mode isolated

To re-check this reference tree in host mode, from the challenge checkout, with stage-4 on :8080 and an earlier stage on :8083:
  cd /tmp/dark-factory-wearedevs
  /tmp/df-py/bin/python -m harness run \
    --track tablekeeper --base-url http://127.0.0.1:8080 --stages 1 2 3 4 \
    --previous-base-url http://127.0.0.1:8083 --out /tmp/nightshift-rerun

SUBMISSION ASSETS COMPLETED
- Working title, short and long copy, tags, cover note, video shot list: SUBMISSION.md
- README, FACTORY, LICENSE, mandates, four stage folders

SUBMISSION ASSETS STILL NEEDED
- Public GitHub URL of the judged run
- room.json full session
- Isolated harness report from a fresh clone
- Video that shows the real Band room and then the product
- LabLab form submit
- Measured time and cost from the actual run

TIME LEFT TO DEADLINE
Deadline is Tuesday 6 October 2026, 06:59 UTC / 08:59 SAST.
```
