# Real-Time Travel App: Event Flow Walkthrough

Oct 19, 2026 · @sreedhar

## Architecture overview

Clients talk only to the realtime server, while live data reaches the re-planning engine through a queue.

&#91;embedded content: architecture · 7 components, 2 flows\]

Suggestions reach the user by push; the accept decision returns over the WebSocket, updates the stores and syncs to every device.

## Example: a flight delay

A delayed flight travels through seven steps, from detection to every companion's phone, and no change is applied without the user's approval.

1. **Worker detects the event.** A flight-status worker receives a webhook (or polls the API) and sees the flight is delayed 2 hours. It pushes an event such as `{tripId, type: "flight_delay", delayMinutes: 120}` onto the event queue.
2. **Re-planning engine picks it up.** It loads the trip's live state from Redis and the itinerary from PostgreSQL, then checks what the delay affects: the airport pickup, hotel check-in and a 6pm dinner reservation.
3. **Rules run first.** A simple rule shifts the pickup by 2 hours and flags the dinner as at risk. Only when the rules can't resolve the conflict (say, the delay breaks a timed-entry ticket and a tour on the same day) does it call Claude with the itinerary and the event, asking for 1-2 alternative plans as structured JSON.
4. **Suggestion is stored as an alert.** The engine writes a row to `alerts` with `status = pending` and the proposed changes.
5. **Push notification.** FCM sends something like "Your flight is delayed 2h. Move pickup to 8:30pm and shift dinner to tomorrow?" with Accept and Decline buttons.
6. **User accepts.** The client sends the decision over the WebSocket. The server applies the changes to `itinerary_items` (incrementing `version`), updates Redis and marks the alert accepted.
7. **Sync to everyone.** The server broadcasts the updated items to the trip's WebSocket room, so every companion's app updates instantly. Anyone offline gets the changes on reconnect, with `version` resolving conflicts.

## What each component is responsible for

Each component has one job, which keeps a slow data source from ever blocking the app.

| Component | Responsibility |
| --- | --- |
| API/Realtime server | The only thing clients talk to. Handles auth, edits and broadcasting. |
| PostgreSQL | The durable source of truth. |
| Redis | Fast live state (current trip status, who is connected) and pub/sub between server instances. |
| Event queue | Decouples data collection from decision-making, so a slow weather API never blocks the app. |
| Workers | One per data source, each normalizing its data into a common event format. |
| Re-planning engine | Turns events into suggestions, and never applies changes without user approval. |

## Next steps

Three deep-dives are open; pick one to build next.

1. **Claude prompt and JSON format** for itinerary generation and re-planning
2. **Full SQL schema** for the tables
3. **Starter backend code** for the WebSocket sync and event worker
