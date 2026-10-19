type TransferRow = {
  id: string;
  day: number;
  start_time: string;
  end_time: string;
  place_name: string;
  place_id: string | null;
  type: string;
  status: string;
  cost: string | number;
  version: number;
};

type SameDayRow = Pick<TransferRow, "id" | "start_time" | "end_time">;

type ActivityRow = TransferRow;

function minutesAfterMidnight(value: string): number | null {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function timeAtMinute(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function buildWeatherSuggestion(
  event: { startsAt: string; endsAt: string; summary?: string },
  activities: ActivityRow[],
  sameDayItems: SameDayRow[],
) {
  const startsAt = Date.parse(event.startsAt);
  const endsAt = Date.parse(event.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) return null;
  const startMinute = new Date(startsAt).getUTCHours() * 60 + new Date(startsAt).getUTCMinutes();
  const endMinute = new Date(endsAt).getUTCHours() * 60 + new Date(endsAt).getUTCMinutes();
  const activity = activities.find((item) => {
    const start = minutesAfterMidnight(item.start_time);
    const end = minutesAfterMidnight(item.end_time);
    return item.type === "activity" && item.status === "planned" && start !== null && end !== null &&
      start < endMinute && end > startMinute;
  });
  if (!activity) return null;
  const oldStart = minutesAfterMidnight(activity.start_time)!;
  const oldEnd = minutesAfterMidnight(activity.end_time)!;
  const duration = oldEnd - oldStart;
  // This MVP treats itinerary times as UTC. It only proposes a same-day slot
  // after the weather window and never moves an item across midnight.
  let newStart = Math.max(oldStart, endMinute);
  const hasCollision = (candidateStart: number) => sameDayItems.some((item) => {
    if (item.id === activity.id) return false;
    const start = minutesAfterMidnight(item.start_time);
    const end = minutesAfterMidnight(item.end_time);
    return start !== null && end !== null && candidateStart < end && candidateStart + duration > start;
  });
  while (newStart + duration < 24 * 60 && hasCollision(newStart)) newStart++;
  const newEnd = newStart + duration;
  if (newEnd >= 24 * 60 || hasCollision(newStart)) return null;
  return {
    type: "replan",
    summary: `Weather may affect ${activity.place_name}. Move it to ${timeAtMinute(newStart)} after the forecast window?`,
    options: [{
      label: "Move activity after weather",
      changes: [{
        itemId: activity.id, action: "move", day: activity.day,
        startTime: timeAtMinute(newStart), endTime: timeAtMinute(newEnd),
        place: { name: activity.place_name, placeId: activity.place_id ?? "" },
        type: "activity", estimatedCost: Number(activity.cost), expectedVersion: activity.version,
        reason: event.summary ?? "Move this planned activity outside the forecast weather window.",
      }],
      costDelta: 0,
      tradeoffs: "The activity moves later; check venue hours and any timed reservation.",
    }],
  };
}

export function buildFlightDelaySuggestion(
  flightNumber: string,
  delayMinutes: number,
  transfer: TransferRow | undefined,
  sameDayItems: SameDayRow[],
) {
  if (!Number.isInteger(delayMinutes) || delayMinutes <= 0 || !transfer ||
      transfer.type !== "transfer" || transfer.status !== "planned") return null;

  const oldStart = minutesAfterMidnight(transfer.start_time);
  const oldEnd = minutesAfterMidnight(transfer.end_time);
  if (oldStart === null || oldEnd === null) return null;
  const newStart = oldStart + delayMinutes;
  const newEnd = oldEnd + delayMinutes;
  // A pickup that moves past midnight needs timezone and date-aware scheduling.
  if (newEnd >= 24 * 60) return null;

  const collision = sameDayItems.some((item) => {
    if (item.id === transfer.id) return false;
    const start = minutesAfterMidnight(item.start_time);
    const end = minutesAfterMidnight(item.end_time);
    return start !== null && end !== null && newStart < end && newEnd > start;
  });
  if (collision) return null;

  return {
    type: "replan",
    summary: `Flight ${flightNumber} is delayed ${delayMinutes} minutes. Move the linked pickup to ${timeAtMinute(newStart)}?`,
    options: [{
      label: "Shift airport pickup",
      changes: [{
        itemId: transfer.id,
        action: "move",
        day: transfer.day,
        startTime: timeAtMinute(newStart),
        endTime: timeAtMinute(newEnd),
        place: { name: transfer.place_name, placeId: transfer.place_id ?? "" },
        type: "transfer",
        estimatedCost: Number(transfer.cost),
        reason: `Shift this pickup by ${delayMinutes} minutes to follow the updated flight time.`,
        expectedVersion: transfer.version,
      }],
      costDelta: 0,
      tradeoffs: "Pickup time changes; confirm the transfer provider can accommodate it.",
    }],
  };
}
