import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { errorResult, structuredResult } from "./result.js";

type RecordData = Record<string, unknown>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type WeekRange = { weekStart: string; weekEnd: string };

function assertIsoDate(value: string): void {
  if (!ISO_DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("week_start must be a valid YYYY-MM-DD date");
  }
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    throw new Error("Athlete profile has no valid timezone");
  }
}

function localDate(now: Date, timezone: string): string {
  assertTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getWeekRange(timezone: string, weekStart?: string, now = new Date()): WeekRange {
  assertTimezone(timezone);
  const start = weekStart ?? (() => {
    const today = localDate(now, timezone);
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    return addDays(today, weekday === 0 ? -6 : 1 - weekday);
  })();

  assertIsoDate(start);
  if (new Date(`${start}T00:00:00Z`).getUTCDay() !== 1) {
    throw new Error("week_start must be a Monday");
  }

  return { weekStart: start, weekEnd: addDays(start, 6) };
}

function recordDate(record: RecordData): string | null {
  for (const key of ["start_date_local", "start_date"]) {
    const value = record[key];
    if (typeof value === "string" && ISO_DATE.test(value.slice(0, 10))) return value.slice(0, 10);
  }
  return null;
}

export function groupWeekRecords(
  range: WeekRange,
  activities: RecordData[],
  plannedEvents: RecordData[],
) {
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(range.weekStart, index);
    const activitiesForDay = activities.filter(activity => recordDate(activity) === date);
    const eventsForDay = plannedEvents.filter(event => recordDate(event) === date);
    return {
      date,
      activities: activitiesForDay,
      planned_events: eventsForDay,
      activity_count: activitiesForDay.length,
      planned_event_count: eventsForDay.length,
    };
  });
}

function truncate(value: unknown, max = 2000): { value: string | null; truncated: boolean } {
  if (typeof value !== "string") return { value: null, truncated: false };
  return value.length > max
    ? { value: value.slice(0, max), truncated: true }
    : { value, truncated: false };
}

function activitySummary(activity: RecordData): RecordData {
  return {
    id: String(activity.id ?? ""), name: activity.name ?? null, type: activity.type ?? null,
    start_date_local: activity.start_date_local ?? null, moving_time_seconds: activity.moving_time ?? null,
    distance_meters: activity.distance ?? activity.icu_distance ?? null,
    training_load: activity.icu_training_load ?? null, intensity: activity.icu_intensity ?? null,
    average_hr_bpm: activity.average_heartrate ?? null, max_hr_bpm: activity.max_heartrate ?? null,
    average_power_watts: activity.icu_average_watts ?? null,
    weighted_power_watts: activity.icu_weighted_avg_watts ?? null,
    pace_mps: activity.pace ?? null, elevation_gain_meters: activity.total_elevation_gain ?? null,
    indoor: activity.trainer ?? null, paired_event_id: activity.paired_event_id ?? null,
    compliance: activity.compliance ?? null,
  };
}

function eventSummary(event: RecordData): RecordData {
  const description = truncate(event.description);
  return {
    id: String(event.id ?? ""), name: event.name ?? null, type: event.type ?? null,
    category: event.category ?? null, start_date_local: event.start_date_local ?? null,
    moving_time_seconds: event.moving_time ?? null, distance_meters: event.distance ?? null,
    training_load: event.icu_training_load ?? event.load_target ?? null,
    intensity: event.icu_intensity ?? null, indoor: event.indoor ?? null, target: event.target ?? null,
    tags: Array.isArray(event.tags) ? event.tags : [], paired_activity_id: event.paired_activity_id ?? null,
    description: description.value, description_truncated: description.truncated,
  };
}

export function registerWeeklySnapshotTool(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "get_weekly_snapshot",
    {
      description: "Get the athlete's Monday-Sunday calendar snapshot, grouping completed activities and all planned calendar events by day. Defaults to the current week in the athlete's Intervals.icu timezone.",
      inputSchema: {
        week_start: z.string().optional().describe("Monday date YYYY-MM-DD (default: current week in athlete timezone)"),
      },
      outputSchema: {
        week_start: z.string(),
        week_end: z.string(),
        timezone: z.string(),
        days: z.array(z.object({
          date: z.string(),
          activities: z.array(z.record(z.string(), z.unknown())),
          planned_events: z.array(z.record(z.string(), z.unknown())),
          activity_count: z.number().int(),
          planned_event_count: z.number().int(),
        })),
        totals: z.object({
          activity_count: z.number().int(),
          planned_event_count: z.number().int(),
        }),
      },
    },
    async ({ week_start }) => {
      try {
        const athlete = await client.get<RecordData>(`/athlete/${client.athleteId}`);
        const timezone = athlete.timezone;
        if (typeof timezone !== "string" || !timezone) throw new Error("Athlete profile has no valid timezone");

        const range = getWeekRange(timezone, week_start);
        const [activities, plannedEvents] = await Promise.all([
          client.get<RecordData[]>(`/athlete/${client.athleteId}/activities`, {
            oldest: range.weekStart,
            newest: range.weekEnd,
          }),
          client.get<RecordData[]>(`/athlete/${client.athleteId}/events`, {
            oldest: range.weekStart,
            newest: range.weekEnd,
          }),
        ]);
        const days = groupWeekRecords(range, activities ?? [], plannedEvents ?? []).map(day => ({
          ...day,
          activities: day.activities.map(activitySummary),
          planned_events: day.planned_events.map(eventSummary),
        }));
        const totals = {
          activity_count: activities?.length ?? 0,
          planned_event_count: plannedEvents?.length ?? 0,
        };
        return structuredResult(`Week ${range.weekStart}–${range.weekEnd}: ${totals.activity_count} activities, ${totals.planned_event_count} planned events.`, {
          week_start: range.weekStart,
          week_end: range.weekEnd,
          timezone,
          days,
          totals,
        });
      } catch (error) {
        return errorResult("fetching weekly snapshot", error);
      }
    },
  );
}
