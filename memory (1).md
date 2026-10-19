# Project Memory: Real-Time Travel Planner

Last updated: 2026-10-19

## Project summary
A real-time travel planner app that builds an itinerary and keeps it current as live events (delays, weather, closures) change the trip. Updates sync instantly across travel companions' devices.

## Decisions made
| Area | Decision |
| --- | --- |
| Client | React Native (Android + iOS) or Next.js for web |
| Backend | Node.js with NestJS or Express, Socket.IO for WebSockets |
| Database | PostgreSQL (durable truth) + Redis (live state, pub/sub) |
| Event pipeline | Redis Streams for MVP; Kafka only if scale demands it |
| Push | Firebase Cloud Messaging |
| Maps / places | Google Maps Platform or Mapbox; Google Places for venue validation |
| AI layer | Claude API for itinerary generation and complex re-planning |
| Live data | Flights (AviationStack, FlightAware or Amadeus), weather (OpenWeather or Tomorrow.io), traffic, venue hours, currency |

## Architecture in one paragraph
Clients talk only to the API/Realtime server over WebSocket. Workers (one per data source) normalize external data into events on a queue. The re-planning engine runs rules first and calls Claude only for conflicts rules cannot solve. Its suggestion is stored as a pending alert, pushed to the user via FCM, and applied only after the user accepts. The server then updates PostgreSQL and Redis and broadcasts to the trip's WebSocket room.

## Data model (tables)
- `users`: id, name, email, preferences (JSON), push_token
- `trips`: id, owner_id, destination, start_date, end_date, budget, status
- `trip_members`: trip_id, user_id, role
- `itinerary_items`: id, trip_id, day, start_time, end_time, place_id, type, status, cost, version
- `bookings`: id, trip_id, type, provider_ref, confirmation_no, cancel_policy
- `alerts`: id, trip_id, source, payload, suggested_change, status (pending, accepted, dismissed)
- `expenses`: id, trip_id, user_id, amount, category, timestamp

The `version` column on `itinerary_items` resolves conflicts when two people edit at once.

## Principles to keep
- Suggestions never apply without user approval.
- Validate every AI-suggested venue against Google Places.
- Poll external APIs sparingly; prefer webhooks.
- Offline-first: cache the itinerary locally and sync on reconnect.
- Limit background location use and get clear consent.

## Build plan and status
1. Foundation: schema, sample data, authenticated API, and Docker Compose local setup created and verified with the flight fixture flow
2. Itinerary generation prompt drafted; backend integration and Places validation not started
3. Real-time sync: Socket.IO rooms and optimistic itinerary edits implemented; multi-client sync has not been separately verified
4. Live data workers: weather publisher, provider-neutral flight normalizer, and fixtures created; Docker flight fixture verified; provider adapter pending
5. Re-planning engine: pending alert, linked pickup delay rule, and basic weather-window activity move suggestions implemented; AI fallback pending
6. Notifications: alert accept/decline API implemented with member checks, transaction, and version checks; FCM push not started
7. Location and offline support (not started)
8. Polish: expenses, group voting, export to PDF or calendar (not started)

**MVP scope:** steps 1-4 plus basic push alerts.

## Artifacts created
- Claude Doc: "Real-Time Travel App: Event Flow Walkthrough" (architecture diagram, flight-delay example, component responsibilities)
- `agent.md`: instructions for the planning agent
- `schema.sql`: PostgreSQL schema applied by Docker Compose on fresh volumes
- `sample-data.sql`: placeholder user, trip and itinerary rows loaded by Docker Compose on fresh volumes
- `prompts/itinerary.md`: generation prompt and JSON contract; backend function and live Places validation remain
- `prompts/replan.md` and `backend/src/replan.ts`: re-planning prompt and safe linked-pickup rule; suggestion is stored pending without applying it
- `events.md`: normalized event envelope, payload examples, Redis Streams handling notes
- `backend/`: TypeScript API, Redis Streams consumer with pending-entry recovery, Open-Meteo weather publisher, provider-neutral flight worker, fixture publishers, alert decision endpoint, and weather re-planning rule; dependencies installed and TypeScript build passes
- `compose.yaml` and `scripts/run-fixture.ps1`: local PostgreSQL/Redis stack and verified end-to-end flight-fixture runner

## Open questions
- Web, mobile, or both for the first release?
- Which flight data provider fits the budget and coverage needs?
- Which deep-dive comes next: starter backend code or implementation of the remaining build steps?
- Group features: shared edits only, or voting on options too?
