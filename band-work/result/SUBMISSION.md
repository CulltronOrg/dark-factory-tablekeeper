# LabLab copy

Do not submit until `FACTORY.md` says a real room finished and isolated checks passed. The paragraphs below are drafts.

## Title

Culltron Nightshift

## Short

A three-seat Band factory that plans, builds, and rejects its own work. Nightshift is the proof: a reservation book that will not hold the same table twice.

## Long

Nightshift is a restaurant reservation service built as the workload for a reusable software factory in Band Desktop.

Three seats share one room. The coordinator only hands out complete requirements. The implementer owns the service and its image. The reviewer builds that revision from scratch, runs the official checks, and adds at least one check the implementer did not choose. A stage is accepted only when the reviewer names the revision they actually ran. The human dispatches a stage and then stops.

The product covers search, booking, change, and cancel; idempotent retries; combined tables; a browser flow that survives a lost response; dated booking policies; history; recurring reservations; and a manager's preview-then-apply seating repair when a table is closed. Tables stay free of double bookings under concurrent requests. Local times follow Europe/Berlin and America/New_York, including the 2026 daylight-saving transitions.

The running image does not call the network. Fonts, code, and dependencies are inside the container.

## Tags

`band` `multi-agent` `dark-factory` `reservations` `nodejs`

## Cover

Paper background `#f3eee6`, oxblood wordmark `#7c2f2a`, one line under it: "Tables, held once." No screenshot of a dashboard grid. A single set table at night is enough if you shoot one. Do not use another company's reservation UI as the image.

## Video

The video is a disqualification if it does not show the real Band Desktop room that produced the submitted code. Do not cut in a mock transcript.

Shot list for whoever records. Timecodes are durations, not claims about a recording that does not exist yet.

1. 10–15s. Say the problem in one sentence, then: "We built the factory, not only the app."
2. Band Desktop with the three seats visible in the room: coordinator, implementer, reviewer.
3. A real handoff: coordinator message that `@[[…]]` mentions the implementer, and a reply the other way. If a rejection happened, show that too. Do not scroll past it.
4. The accepted revision the reviewer named, and the stage folders in the repo.
5. Nightshift in the browser: search, an available cell, a confirmation reference, then lookup. If you can, show a second booking of the same table failing.
6. The isolated harness summary on screen, including the claimed stage line. If a stage did not claim, say the line that printed.
7. One sentence on measured time and cost from the run, and one limitation you actually hit.

Record the room first, while it is still open. Export `room.json` after the recording so the download does not change what you filmed.

## What not to say on the form

- Do not claim a stage the isolated harness did not claim.
- Do not quote a model id, a token cost, or a runtime you did not measure.
- Do not describe this reference tree as agent-written if the room did not produce it.
