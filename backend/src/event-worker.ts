import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createClient, RedisClientType } from "redis";
import { Pool, PoolClient } from "pg";
import { buildFlightDelaySuggestion, buildWeatherSuggestion } from "./replan.js";

const stream = process.env.EVENT_STREAM ?? "travel:events:v1";
const group = process.env.EVENT_GROUP ?? "replanner";
const consumer = `worker-${process.pid}`;
const reclaimIdleMs = Number(process.env.EVENT_RECLAIM_IDLE_MS ?? 60_000);
const redis: RedisClientType = createClient({ url: process.env.REDIS_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type EventEnvelope = {
  eventId: string;
  tripId: string;
  type: "flight_delay" | "weather_alert" | "venue_closure" | "traffic_disruption";
  occurredAt: string;
  receivedAt: string;
  source: string;
  schemaVersion: 1;
  payload: Record<string, unknown>;
};

function parseEvent(fields: Record<string, string>): EventEnvelope {
  const event = {
    eventId: fields.eventId,
    tripId: fields.tripId,
    type: fields.type,
    occurredAt: fields.occurredAt,
    receivedAt: fields.receivedAt,
    source: fields.source,
    schemaVersion: Number(fields.schemaVersion),
    payload: JSON.parse(fields.payload ?? "{}"),
  } as EventEnvelope;
  const allowed = ["flight_delay", "weather_alert", "venue_closure", "traffic_disruption"];
  if (!event.eventId || !event.tripId || !event.source || event.schemaVersion !== 1 ||
      !allowed.includes(event.type) || !Number.isFinite(Date.parse(event.occurredAt)) ||
      !Number.isFinite(Date.parse(event.receivedAt)) || typeof event.payload !== "object" || event.payload === null) {
    throw new Error("invalid event envelope");
  }
  return event;
}

async function makeSuggestion(client: PoolClient, event: EventEnvelope) {
  if (event.type === "weather_alert") {
    const startsAt = event.payload.startsAt;
    const endsAt = event.payload.endsAt;
    if (typeof startsAt !== "string" || typeof endsAt !== "string" ||
        !Number.isFinite(Date.parse(startsAt)) || !Number.isFinite(Date.parse(endsAt))) return null;
    const dayResult = await client.query(
      `SELECT ( $2::date - start_date + 1 )::integer AS day
       FROM trips WHERE id = $1 AND $2::date BETWEEN start_date AND end_date`,
      [event.tripId, new Date(startsAt).toISOString().slice(0, 10)],
    );
    const day = dayResult.rows[0]?.day;
    if (!day) return null;
    const rows = await client.query(
      `SELECT id, day, start_time::text, end_time::text, place_name, place_id,
              type, status, cost, version
       FROM itinerary_items WHERE trip_id = $1 AND day = $2 AND status <> 'cancelled'
       ORDER BY start_time`,
      [event.tripId, day],
    );
    const activities = rows.rows.filter((item) => item.type === "activity");
    return buildWeatherSuggestion({ startsAt, endsAt, summary: String(event.payload.summary ?? "") }, activities, rows.rows);
  }
  if (event.type !== "flight_delay") return null;
  const flightNumber = event.payload.flightNumber;
  const delayMinutes = Number(event.payload.delayMinutes);
  const provider = event.source;
  const scheduledDeparture = event.payload.scheduledDeparture;
  if (typeof flightNumber !== "string" || typeof provider !== "string" ||
      typeof scheduledDeparture !== "string" || !Number.isFinite(Date.parse(scheduledDeparture))) return null;

  const found = await client.query(
    `SELECT i.id, i.day, i.start_time::text, i.end_time::text, i.place_name,
            i.place_id, i.type, i.status, i.cost, i.version
     FROM itinerary_items AS i
     JOIN flight_subscriptions AS f ON f.id = i.flight_subscription_id
     WHERE i.trip_id = $1 AND f.trip_id = $1 AND f.provider = $2
       AND upper(f.flight_number) = upper($3) AND f.status = 'active'
       AND f.trip_day = i.day
       AND f.scheduled_departure BETWEEN $4::timestamptz - interval '30 minutes'
                                     AND $4::timestamptz + interval '30 minutes'
       AND i.type = 'transfer' AND i.status = 'planned'
     ORDER BY i.start_time
     LIMIT 1`,
    [event.tripId, provider, flightNumber, scheduledDeparture],
  );
  const transfer = found.rows[0];
  if (!transfer) return null;
  const sameDay = await client.query(
    `SELECT id, start_time::text, end_time::text
     FROM itinerary_items WHERE trip_id = $1 AND day = $2 AND status <> 'cancelled'`,
    [event.tripId, transfer.day],
  );
  return buildFlightDelaySuggestion(flightNumber, delayMinutes, transfer, sameDay.rows);
}

async function processMessage(id: string, fields: Record<string, string>) {
  let event: EventEnvelope;
  try {
    event = parseEvent(fields);
  } catch (error) {
    await redis.xAdd(`${stream}:dead`, "*", {
      sourceId: id,
      reason: error instanceof Error ? error.message : "invalid event",
      raw: JSON.stringify(fields),
    });
    await redis.xAck(stream, group, id);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO processed_events (trip_id, source, event_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (trip_id, source, event_id) DO NOTHING
       RETURNING event_id`,
      [event.tripId, event.source, event.eventId, JSON.stringify(event)],
    );
    if (result.rowCount === 1) {
      const suggestion = await makeSuggestion(client, event);
      if (suggestion) {
        await client.query(
          `INSERT INTO alerts (id, trip_id, source, event_id, payload, suggested_change, status)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'pending')`,
          [randomUUID(), event.tripId, event.source, event.eventId, JSON.stringify(event), JSON.stringify(suggestion)],
        );
      }
      console.log(JSON.stringify({ eventId: event.eventId, firstDelivery: true, suggestionCreated: Boolean(suggestion) }));
    }
    await client.query("COMMIT");
    await redis.xAck(stream, group, id);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  await redis.connect();
  await pool.query("SELECT 1");
  try {
    await redis.xGroupCreate(stream, group, "0", { MKSTREAM: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }
  console.log(`Consuming ${stream} as ${group}/${consumer}`);
  let reclaimCursor = "0-0";
  for (;;) {
    // Reclaim entries abandoned by a crashed consumer after they have been idle.
    const reclaimed = await redis.xAutoClaim(stream, group, consumer, reclaimIdleMs, reclaimCursor, { COUNT: 10 });
    reclaimCursor = reclaimed.nextId;
    for (const message of reclaimed.messages) {
      if (!message) continue;
      await processMessage(message.id, message.message);
    }
    const batches = await redis.xReadGroup(group, consumer, [{ key: stream, id: ">" }], {
      COUNT: 10,
      BLOCK: 5000,
    });
    for (const batch of batches ?? []) {
      for (const message of batch.messages) {
        await processMessage(message.id, message.message);
      }
    }
  }
}

main().catch(async (error) => {
  console.error(error);
  await redis.disconnect().catch(() => undefined);
  await pool.end();
  process.exitCode = 1;
});

async function shutdown() {
  await redis.quit().catch(() => undefined);
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
