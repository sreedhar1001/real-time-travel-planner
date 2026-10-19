# Normalized travel event format

Workers normalize provider webhooks or polling results into this envelope before appending events to the MVP Redis Stream. The queue message is an observation; it never directly changes an itinerary.

## Envelope

```json
{
  "eventId": "provider event ID or stable generated id",
  "tripId": "UUID",
  "type": "flight_delay",
  "occurredAt": "2026-10-19T10:15:00Z",
  "receivedAt": "2026-10-19T10:16:02Z",
  "source": "provider name",
  "schemaVersion": 1,
  "payload": {}
}
```

`eventId` should be stable across provider retries so consumers can deduplicate. `occurredAt` is when the provider says the event happened; `receivedAt` is when this system received it. Both are ISO 8601 timestamps with timezone. `tripId` must be resolved by the worker from a trusted trip association, not accepted blindly from an external webhook. Include only normalized, relevant fields in `payload`; keep raw provider data separately if needed for debugging and retention policy.

## Event types and payloads

### `flight_delay`

```json
{
  "flightNumber": "XX123",
  "scheduledDeparture": "2026-10-19T14:00:00Z",
  "estimatedDeparture": "2026-10-19T16:00:00Z",
  "delayMinutes": 120,
  "origin": "ABC",
  "destination": "XYZ"
}
```

### `weather_alert`

```json
{
  "location": { "latitude": 0, "longitude": 0 },
  "startsAt": "2026-10-19T12:00:00Z",
  "endsAt": "2026-10-19T18:00:00Z",
  "condition": "heavy_rain",
  "severity": "moderate",
  "summary": "Provider summary"
}
```

### `venue_closure`

```json
{
  "placeId": "verified place identifier",
  "placeName": "Venue name",
  "startsAt": "2026-10-19T00:00:00Z",
  "endsAt": "2026-10-20T00:00:00Z",
  "reason": "Provider notice or null"
}
```

### `traffic_disruption`

```json
{
  "origin": { "latitude": 0, "longitude": 0 },
  "destination": { "latitude": 0, "longitude": 0 },
  "startsAt": "2026-10-19T12:00:00Z",
  "endsAt": "2026-10-19T13:00:00Z",
  "extraMinutes": 25,
  "severity": "moderate",
  "summary": "Provider summary"
}
```

## Redis Streams MVP

- Stream key: `travel:events:v1`
- Append with `XADD travel:events:v1 * eventId ... tripId ... type ... occurredAt ... receivedAt ... source ... schemaVersion 1 payload <JSON>`.
- Consume with a consumer group (for example `replanner`) and acknowledge only after the event has been handled or durably quarantined.
- Deduplicate by `(source, eventId)` in durable storage or a bounded idempotency store. Retries must not create duplicate alerts.
- Validate the envelope and payload against `schemaVersion` before processing. Send malformed or unsupported events to a dead-letter stream with a reason.
- Re-planning rules run first. The AI engine may create a pending suggestion only when rules cannot resolve a conflict. The user must accept before any itinerary change is applied.

### Flight provider intake

Until a provider is selected, provider adapters should normalize flight updates into `travel:flight-status:inbox:v1` with these hash fields: `eventId`, `provider`, `flightNumber`, `scheduledDeparture`, `estimatedDeparture`, `observedAt`, and optional `origin` / `destination`. The flight worker resolves `tripId` from `flight_subscriptions` (provider + flight number + scheduled departure within 30 minutes) and writes matching `flight_delay` events to the common stream. Never trust a trip identifier supplied by a provider webhook.

## Worker handling checklist

1. Verify provider signature where supported and map the external record to the correct trip.
2. Normalize units, timestamps, identifiers, and severity; reject ambiguous or stale data.
3. Set stable event identity and append the envelope to the stream.
4. Retry transient queue failures with bounded backoff; preserve idempotency on retry.
5. Log identifiers and processing outcomes without logging secrets or unnecessary personal data.
