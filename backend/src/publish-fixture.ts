import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "redis";

const fixturePath = resolve(process.argv[2] ?? "fixtures/weather-alert.json");
const stream = process.env.EVENT_STREAM ?? "travel:events:v1";
const parsed: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
if (!parsed || typeof parsed !== "object") throw new Error("Fixture must be an event object");
const event = parsed as Record<string, unknown>;
for (const key of ["eventId", "tripId", "type", "occurredAt", "receivedAt", "source", "schemaVersion", "payload"]) {
  if (!(key in event)) throw new Error(`Fixture is missing ${key}`);
}

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
try {
  const fields = Object.fromEntries(Object.entries(event).map(([key, value]) => [
    key,
    key === "payload" ? JSON.stringify(value) : String(value),
  ]));
  const id = await redis.xAdd(stream, "*", fields);
  console.log(JSON.stringify({ stream, redisId: id, eventId: event.eventId }));
} finally {
  await redis.quit();
}
