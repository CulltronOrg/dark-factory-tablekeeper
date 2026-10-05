# LabLab submission copy

Use these fields on the LabLab project page. Keep every claim inside what is listed under "Honest status" in the root README.

## Title

Tablekeeper by Culltron (Nightshift)

## Short description

A restaurant booking app where you search, book, move, and cancel a table, and three AI agent seats (coordinator, implementer, reviewer) explain each step live.

## Long description

Tablekeeper is a calm reservation app for one restaurant book. A diner searches for a time and party size and sees only the tables that are really free. The table she picks stays selected while she signs up or signs in, so she never starts over. Bookings need no reference code: they live under My bookings, where she can move to another time or table, or cancel with a confirm step and a Keep reservation option.

After every search, booking, move, and cancellation, three agent seats (coordinator, implementer, reviewer) each return a short note from a live model (gpt-5-mini on Azure OpenAI). The reservation engine stays the only authority: it validates every action once, prevents double bookings, and handles joined tables, retries, and restaurant-local times. If the model provider fails or runs out of credits, the app keeps working and clearly shows that the seats are simulated.

Only the action name and its result are sent to the model. No diner details, references, or session tokens leave the service, and keys are read from the environment only.

The service passes 68 local tests and is deployed on Azure Container Apps. It is a reference build for the Tablekeeper track, not a judged Band room run.

## Links

- Live demo: https://tablekeeper-booking.ashyisland-1f4bbbad.eastus.azurecontainerapps.io/
- Repository: https://github.com/CulltronOrg/dark-factory-tablekeeper
- Video: https://youtu.be/6mPcC5qp_Og
- How to test: see "What judges need to do" in the repository README.

## Tags

`multi-agent` `reservations` `azure-openai` `nodejs` `band`

## Media

- Cover: `band-work/pitch/tablekeeper-cover.jpg`
- Deck: `band-work/pitch/tablekeeper-pitch.pptx`
- Video: about 2.5 minutes, a live recording of search, book, move, and cancel with narration.

## Do not claim

- A judged Band room run, a `room.json`, or an isolated harness pass.
- Any model id, cost, or runtime that was not measured.
- That the code was written autonomously by a Band factory.
