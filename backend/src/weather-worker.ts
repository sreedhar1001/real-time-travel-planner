import "dotenv/config";
import { createHash } from "node:crypto";
import { createClient } from "redis";

const tripId = process.env.WEATHER_TRIP_ID;
const latitude = Number(process.env.WEATHER_LATITUDE);
const longitude = Number(process.env.WEATHER_LONGITUDE);
const stream = process.env.EVENT_STREAM ?? "travel:events:v1";
const intervalMs = Number(process.env.WEATHER_POLL_INTERVAL_MS ?? 30 * 60 * 1000);
const apiUrl = process.env.WEATHER_API_URL ?? "https://api.open-meteo.com/v1/forecast";
const apiKey = process.env.WEATHER_API_KEY;
if (!tripId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
  throw new Error("WEATHER_TRIP_ID, WEATHER_LATITUDE, and WEATHER_LONGITUDE are required");
}

const redis = createClient({ url: process.env.REDIS_URL });
const source = "open-meteo";
const sent = new Set<string>();

type Forecast = {
  hourly?: {
    time?: string[];
    precipitation_probability?: (number | null)[];
    precipitation?: (number | null)[];
    weather_code?: (number | null)[];
  };
};

async function fetchForecast(): Promise<Forecast> {
  const url = new URL(apiUrl);
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "precipitation_probability,precipitation,weather_code",
    forecast_hours: "24",
    timezone: "UTC",
  });
  if (apiKey) params.set("apikey", apiKey);
  url.search = params.toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Open-Meteo returned HTTP ${response.status}`);
  return await response.json() as Forecast;
}

function severityFor(code: number, probability: number, precipitation: number): string | null {
  // WMO codes 95-99 indicate thunderstorms; 65/67 heavy rain and 75/77 heavy snow.
  if ([65, 67, 75, 77, 82, 86, 95, 96, 99].includes(code)) return "severe";
  if (probability >= 60 || precipitation >= 5 || [63, 66, 73, 80, 81, 85].includes(code)) return "moderate";
  return null;
}

async function publishForecastAlerts() {
  const forecast = await fetchForecast();
  const hourly = forecast.hourly;
  if (!hourly?.time || !hourly.precipitation_probability || !hourly.precipitation || !hourly.weather_code) {
    throw new Error("Forecast response is missing expected hourly fields");
  }
  const now = Date.now();
  for (let i = 0; i < hourly.time.length; i++) {
    const rawTime = hourly.time[i];
    if (!rawTime) continue;
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawTime);
    const startsAt = new Date(hasOffset ? rawTime : `${rawTime}Z`);
    if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() < now) continue;
    const probability = hourly.precipitation_probability[i];
    const precipitation = hourly.precipitation[i];
    const code = hourly.weather_code[i];
    if (probability == null || precipitation == null || code == null) continue;
    const severity = severityFor(code, probability, precipitation);
    if (!severity) continue;

    const endsAt = new Date(startsAt.getTime() + 60 * 60 * 1000);
    const condition = code >= 95 ? "thunderstorm" : code >= 71 && code <= 77 ? "snow" : "rain";
    const payload = {
      location: { latitude, longitude },
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      condition,
      severity,
      precipitationProbability: probability,
      precipitationMm: precipitation,
      weatherCode: code,
      summary: `${condition}; ${probability}% precipitation probability, ${precipitation} mm forecast`,
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
    if (sent.has(fingerprint)) continue;

    const event = {
      eventId: `om-${fingerprint}`,
      tripId: tripId!,
      type: "weather_alert",
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      source,
      schemaVersion: "1",
      payload: JSON.stringify(payload),
    };
    await redis.xAdd(stream, "*", event);
    sent.add(fingerprint);
    console.log(JSON.stringify({ eventId: event.eventId, tripId, startsAt: payload.startsAt, severity }));
  }
}

async function main() {
  await redis.connect();
  const run = async () => {
    try { await publishForecastAlerts(); }
    catch (error) { console.error("Weather poll failed", error); }
  };
  await run();
  const timer = setInterval(run, intervalMs);
  const stop = async () => {
    clearInterval(timer);
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(async (error) => {
  console.error(error);
  await redis.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
