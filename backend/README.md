# Backend starter

TypeScript starter for authenticated trip rooms, optimistic itinerary edits, and Redis Streams event intake.

## Prerequisites

- Node.js 20 or later
- PostgreSQL with the root `schema.sql` applied
- Redis 6.2 or later
- An application-issued JWT whose `sub` claim is the user's UUID

The database schema uses UUID primary keys supplied by the application or seed data.

## Run

### Run the flight fixture flow with Docker

Install Docker Desktop, then run this from the workspace root in PowerShell:

```powershell
.\scripts\run-fixture.ps1
```

Compose builds the backend image, initializes a fresh PostgreSQL volume with `schema.sql` and `sample-data.sql`, starts Redis and both workers, publishes the flight-delay fixture, and waits for it to appear in `processed_events`. To start the API too, run `docker compose -f compose.yaml up -d api` after the script. The local database password and JWT secret in `compose.yaml` are development-only. PostgreSQL init scripts run only when the data volume is empty; existing volumes are preserved.

### Run with local services

Copy `.env.example` to `.env` and set real local connection strings and a random JWT secret. Then:

```sh
npm ci
npm run dev:api
```

In another terminal, start the worker:

```sh
npm run dev:worker
```

To publish the included fake weather alert, run `npm run publish:fixture` from `backend/` with Redis running and the sample trip inserted in PostgreSQL. The event worker should record it in `processed_events`.

To poll Open-Meteo for one trip, configure `WEATHER_TRIP_ID`, `WEATHER_LATITUDE`, and `WEATHER_LONGITUDE` in `.env`, then run `npm run dev:weather`. It publishes moderate or severe rain/snow/storm forecasts for the next 24 hours at the configured interval. The event worker can propose moving one overlapping planned activity to the first collision-free time after the forecast window. This rule treats itinerary times as UTC and does not know venue indoor/outdoor status or opening hours; its proposal remains pending until accepted. Coordinates and alert thresholds are MVP settings, not trip-aware geofences. Open-Meteo documents the forecast fields in its [Forecast API documentation](https://open-meteo.com/en/docs). The free endpoint is limited to non-commercial use; commercial use requires its subscribed customer endpoint and API key. The data also requires CC BY 4.0 attribution. See [Open-Meteo pricing and licence terms](https://open-meteo.com/en/pricing).

The API exposes `GET /health`. Socket.IO clients authenticate with `{ auth: { token } }`, join with `trip:join` and `{ tripId }`, and edit with `itinerary:update` carrying `tripId`, `itemId`, `expectedVersion`, and a `changes` object. Successful edits increment `version` and broadcast `itinerary:updated` to members in that trip room. A stale version returns `version_conflict`.

Alert decisions use `POST /trips/:tripId/alerts/:alertId/decision` with a bearer JWT and `{"decision":"accept"}` or `{"decision":"decline"}`. Only trip members can decide. Acceptance applies the first stored option in a transaction with itinerary version checks; stale suggestions return HTTP 409 without applying changes. Successful edits are broadcast to the trip Socket.IO room. Declining marks the alert dismissed.

Workers append hash fields to `travel:events:v1`; `payload` must be JSON text. The consumer validates the envelope, records it idempotently in `processed_events`, and acknowledges the stream entry. Malformed events go to `travel:events:v1:dead`. Entries abandoned by a crashed consumer are reclaimed after 60 seconds (configurable with `EVENT_RECLAIM_IDLE_MS`).

Flight status uses a separate normalized inbox stream (`travel:flight-status:inbox:v1`). The provider adapter must write `eventId`, `provider`, `flightNumber`, `scheduledDeparture`, `estimatedDeparture`, and `observedAt` fields, with optional `origin` and `destination`. Add one `flight_subscriptions` row per watched trip flight. The flight worker matches by provider, flight number, and scheduled departure within 30 minutes, then emits `flight_delay` only when the delay reaches `FLIGHT_DELAY_THRESHOLD_MINUTES`. Until a provider is selected, `npm run publish:flight-fixture` supplies the normalized input for the sample trip; this is not connected to a live flight provider.

For the full fixture flow, apply `schema.sql`, then `sample-data.sql`; start `npm run dev:flight` and `npm run dev:worker` in separate terminals; publish with `npm run publish:flight-fixture`. The consumer records the event in `processed_events` and creates a pending suggestion to shift the explicitly linked airport pickup by two hours, without changing the itinerary. Re-planning rules and the prompt contract are in `../prompts/replan.md`.

## Scope and follow-up

This is a starter, not a production deployment. The event worker has deterministic rules for linked flight pickups and overlapping weather-affected activities; it does not call an LLM or send push notifications. Provider-specific authenticated flight adapters and production hardening remain follow-up work. Add TLS, rate limits, structured logging, membership-aware token/session revocation, and operational monitoring before production use. The TypeScript build and Docker flight-fixture flow have been verified locally.
