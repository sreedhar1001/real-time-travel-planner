# Real-Time Travel Planner

A backend starter for shared trip itineraries and event-driven re-planning. PostgreSQL stores trips and itinerary data, Redis Streams carries live events, and Socket.IO broadcasts accepted itinerary changes.

## Run locally with Docker

Prerequisite: Docker Desktop with Compose enabled.

From the project root, start the database, Redis, workers, and publish a sample flight delay:

```powershell
.\scripts\run-fixture.ps1
```

Start the API:

```powershell
docker compose -f compose.yaml up -d api
```

The API base URL is `http://localhost:3000`. The root returns service information, and `GET /health` checks the API and database. The fixture flow inserts sample data into a fresh PostgreSQL volume; the sample destination and venues are placeholders.

To inspect the sample itinerary:

```powershell
docker compose -f compose.yaml exec -T postgres psql -U travel -d travel -c "SELECT t.destination, t.start_date, t.end_date, i.day, i.start_time, i.end_time, i.place_name FROM trips t JOIN itinerary_items i ON i.trip_id = t.id ORDER BY i.day, i.start_time;"
```

## Backend development

See [`backend/README.md`](backend/README.md) for local Node.js setup, API/Socket.IO contracts, event workers, and fixture details. The backend currently has no web or mobile client. Planning prompts and project notes are in [`prompts/`](prompts/), [`agent.md`](agent.md), and [`events.md`](events.md).

## Scope

This is an MVP backend starter. Flight input is fixture-based until a provider adapter is configured. Re-planning creates pending suggestions; changes are applied only after a trip member accepts them. Push notifications and AI itinerary generation are not implemented yet.
