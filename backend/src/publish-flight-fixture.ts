import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "redis";

const path = resolve(process.argv[2] ?? "fixtures/flight-delay.json");
const update = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
for (const key of ["eventId", "provider", "flightNumber", "scheduledDeparture", "estimatedDeparture", "observedAt"]) {
  if (!(key in update)) throw new Error(`Flight fixture is missing ${key}`);
}
const stream = process.env.FLIGHT_INPUT_STREAM ?? "travel:flight-status:inbox:v1";
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
try {
  const id = await redis.xAdd(stream, "*", Object.fromEntries(
    Object.entries(update).map(([key, value]) => [key, String(value)]),
  ));
  console.log(JSON.stringify({ stream, redisId: id, eventId: update.eventId }));
} finally {
  await redis.quit();
}
