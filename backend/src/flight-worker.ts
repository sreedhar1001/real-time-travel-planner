import "dotenv/config";
import { createHash } from "node:crypto";
import { createClient } from "redis";
import { Pool } from "pg";

const inputStream = process.env.FLIGHT_INPUT_STREAM ?? "travel:flight-status:inbox:v1";
const outputStream = process.env.EVENT_STREAM ?? "travel:events:v1";
const group = process.env.FLIGHT_EVENT_GROUP ?? "flight-normalizer";
const consumer = `flight-${process.pid}`;
const delayThreshold = Number(process.env.FLIGHT_DELAY_THRESHOLD_MINUTES ?? 15);
if (!Number.isInteger(delayThreshold) || delayThreshold < 0) {
  throw new Error("FLIGHT_DELAY_THRESHOLD_MINUTES must be a non-negative integer");
}
const redis = createClient({ url: process.env.REDIS_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type FlightUpdate = {
  eventId: string;
  provider: string;
  flightNumber: string;
  scheduledDeparture: string;
  estimatedDeparture: string;
  origin?: string;
  destination?: string;
  observedAt: string;
};

function parseUpdate(fields: Record<string, string>): FlightUpdate {
  const update = fields as unknown as FlightUpdate;
  if (!update.eventId || !update.provider || !update.flightNumber ||
      !Number.isFinite(Date.parse(update.scheduledDeparture)) ||
      !Number.isFinite(Date.parse(update.estimatedDeparture)) ||
      !Number.isFinite(Date.parse(update.observedAt))) {
    throw new Error("invalid normalized flight update");
  }
  return update;
}

async function deadLetter(redisId: string, fields: Record<string, string>, reason: string) {
  await redis.xAdd(`${inputStream}:dead`, "*", {
    sourceId: redisId,
    reason,
    raw: JSON.stringify(fields),
  });
  await redis.xAck(inputStream, group, redisId);
}

async function processUpdate(redisId: string, fields: Record<string, string>) {
  let update: FlightUpdate;
  try {
    update = parseUpdate(fields);
  } catch (error) {
    await deadLetter(redisId, fields, error instanceof Error ? error.message : "invalid update");
    return;
  }

  const scheduledMs = Date.parse(update.scheduledDeparture);
  const estimatedMs = Date.parse(update.estimatedDeparture);
  const delayMinutes = Math.round((estimatedMs - scheduledMs) / 60_000);
  if (delayMinutes < delayThreshold) {
    await redis.xAck(inputStream, group, redisId);
    return;
  }

  // Do not trust a tripId from an external provider. Resolve subscriptions in
  // our database using provider, flight number, and scheduled departure.
  const subscriptions = await pool.query<{ trip_id: string }>(
    `SELECT trip_id FROM flight_subscriptions
     WHERE status = 'active'
       AND provider = $1
       AND upper(flight_number) = upper($2)
       AND scheduled_departure BETWEEN $3::timestamptz - interval '30 minutes'
                                   AND $3::timestamptz + interval '30 minutes'`,
    [update.provider, update.flightNumber, update.scheduledDeparture],
  );

  for (const { trip_id: tripId } of subscriptions.rows) {
    const eventId = createHash("sha256")
      .update(`${update.provider}|${tripId}|${update.flightNumber.toUpperCase()}|${update.scheduledDeparture}|${update.estimatedDeparture}`)
      .digest("hex").slice(0, 32);
    const payload = {
      flightNumber: update.flightNumber,
      scheduledDeparture: update.scheduledDeparture,
      estimatedDeparture: update.estimatedDeparture,
      delayMinutes,
      origin: update.origin ?? null,
      destination: update.destination ?? null,
    };
    await redis.xAdd(outputStream, "*", {
      eventId: `flight-${eventId}`,
      tripId,
      type: "flight_delay",
      occurredAt: update.observedAt,
      receivedAt: new Date().toISOString(),
      source: update.provider,
      schemaVersion: "1",
      payload: JSON.stringify(payload),
    });
  }

  console.log(JSON.stringify({
    provider: update.provider,
    flightNumber: update.flightNumber,
    delayMinutes,
    matchedTrips: subscriptions.rowCount,
  }));
  await redis.xAck(inputStream, group, redisId);
}

async function main() {
  await redis.connect();
  await pool.query("SELECT 1");
  try {
    await redis.xGroupCreate(inputStream, group, "0", { MKSTREAM: true });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("BUSYGROUP")) throw error;
  }

  console.log(`Consuming ${inputStream} as ${group}/${consumer}; publishing to ${outputStream}`);
  for (;;) {
    const batches = await redis.xReadGroup(group, consumer, [{ key: inputStream, id: ">" }], {
      COUNT: 10,
      BLOCK: 5000,
    });
    for (const batch of batches ?? []) {
      for (const message of batch.messages) {
        await processUpdate(message.id, message.message);
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
