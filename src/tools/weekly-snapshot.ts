import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { canonicalDiscipline, numberValue } from "../analysis.js";
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

export function localDate(now: Date, timezone: string): string {
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

function ratio(completed: number | null, planned: number | null): number | null {
  return completed == null || planned == null || planned <= 0 ? null : completed / planned;
}

function pairedComparison(activity: RecordData, event: RecordData): RecordData {
  const completedDuration = numberValue(activity.moving_time); const plannedDuration = numberValue(event.moving_time);
  const completedLoad = numberValue(activity.icu_training_load); const plannedLoad = numberValue(event.icu_training_load ?? event.load_target);
  const completedIntensity = numberValue(activity.icu_intensity); const plannedIntensity = numberValue(event.icu_intensity);
  return {
    planned_duration_seconds: plannedDuration, completed_duration_seconds: completedDuration,
    duration_absolute_delta_seconds: completedDuration == null || plannedDuration == null ? null : Math.abs(completedDuration - plannedDuration),
    duration_ratio: ratio(completedDuration, plannedDuration),
    planned_load: plannedLoad, completed_load: completedLoad,
    load_absolute_delta: completedLoad == null || plannedLoad == null ? null : Math.abs(completedLoad - plannedLoad),
    load_ratio: ratio(completedLoad, plannedLoad),
    intensity_comparison: completedIntensity == null || plannedIntensity == null ? null : {
      planned: plannedIntensity, completed: completedIntensity,
      absolute_delta: Math.abs(completedIntensity - plannedIntensity), ratio: ratio(completedIntensity, plannedIntensity),
    },
  };
}

function activitySummary(activity: RecordData, event: RecordData | null): RecordData {
  const paired = activity.paired_event_id != null;
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
    status: paired ? "COMPLETED" : "UNPAIRED_COMPLETION",
    compliance: paired ? activity.compliance ?? null : null,
    paired_comparison: paired && event ? pairedComparison(activity, event) : null,
  };
}

function eventSummary(event: RecordData, activity: RecordData | null, today: string): RecordData {
  const description = truncate(event.description);
  const paired = activity != null;
  return {
    id: String(event.id ?? ""), name: event.name ?? null, type: event.type ?? null,
    category: event.category ?? null, start_date_local: event.start_date_local ?? null,
    moving_time_seconds: event.moving_time ?? null, distance_meters: event.distance ?? null,
    training_load: event.icu_training_load ?? event.load_target ?? null,
    intensity: event.icu_intensity ?? null, indoor: event.indoor ?? null, target: event.target ?? null,
    tags: Array.isArray(event.tags) ? event.tags : [], paired_activity_id: paired ? String(activity.id ?? "") : event.paired_activity_id ?? null,
    description: description.value, description_truncated: description.truncated,
    status: paired ? "COMPLETED" : (recordDate(event) ?? today) < today ? "MISSED" : "PLANNED",
    paired_comparison: paired ? pairedComparison(activity, event) : null,
  };
}

type Totals = { duration_seconds: number; load: number; distance_meters: number };

function emptyTotals(): Totals { return { duration_seconds: 0, load: 0, distance_meters: 0 }; }

function addRecordTotals(total: Totals, record: RecordData, planned: boolean): void {
  total.duration_seconds += numberValue(record.moving_time) ?? 0;
  total.load += numberValue(record.icu_training_load ?? (planned ? record.load_target : null)) ?? 0;
  total.distance_meters += numberValue(record.distance ?? record.icu_distance) ?? 0;
}

function aggregateTotals(activities: RecordData[], events: RecordData[]): RecordData {
  const overall = { completed: emptyTotals(), planned: emptyTotals() };
  const byDiscipline = Object.fromEntries(["BIKE", "RUN", "SWIM", "OTHER"].map(key => [key, { completed: emptyTotals(), planned: emptyTotals() }])) as Record<string, { completed: Totals; planned: Totals }>;
  for (const activity of activities) {
    const discipline = canonicalDiscipline(activity.type) ?? "OTHER";
    addRecordTotals(overall.completed, activity, false); addRecordTotals(byDiscipline[discipline].completed, activity, false);
  }
  for (const event of events) {
    const discipline = canonicalDiscipline(event.type) ?? "OTHER";
    addRecordTotals(overall.planned, event, true); addRecordTotals(byDiscipline[discipline].planned, event, true);
  }
  return { activity_count: activities.length, planned_event_count: events.length, overall, by_discipline: byDiscipline };
}

export function weekProgress(range: WeekRange, today: string): { today: string; elapsed_days: number; remaining_days: number; week_status: "UPCOMING" | "IN_PROGRESS" | "COMPLETE" } {
  if (today < range.weekStart) return { today, elapsed_days: 0, remaining_days: 7, week_status: "UPCOMING" };
  if (today > range.weekEnd) return { today, elapsed_days: 7, remaining_days: 0, week_status: "COMPLETE" };
  const elapsed = Math.floor((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${range.weekStart}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  return { today, elapsed_days: elapsed, remaining_days: 7 - elapsed, week_status: "IN_PROGRESS" };
}

export function registerWeeklySnapshotTool(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "get_weekly_snapshot",
    {
      description: "Get an athlete-local Monday-Sunday snapshot with completed/planned totals and pairing-derived COMPLETED, UNPAIRED_COMPLETION, MISSED, or PLANNED statuses. Compliance is only reported for paired activities.",
      inputSchema: {
        week_start: z.string().optional().describe("Monday date YYYY-MM-DD (default: current week in athlete timezone)"),
      },
      outputSchema: {
        week_start: z.string(),
        week_end: z.string(),
        timezone: z.string(),
        today: z.string(),
        elapsed_days: z.number().int(),
        remaining_days: z.number().int(),
        week_status: z.enum(["UPCOMING", "IN_PROGRESS", "COMPLETE"]),
        days: z.array(z.object({
          date: z.string(),
          activities: z.array(z.record(z.string(), z.unknown())),
          planned_events: z.array(z.record(z.string(), z.unknown())),
          activity_count: z.number().int(),
          planned_event_count: z.number().int(),
        })),
        totals: z.record(z.string(), z.unknown()),
      },
    },
    async ({ week_start }) => {
      try {
        const athlete = await client.get<RecordData>(`/athlete/${client.athleteId}`);
        const timezone = athlete.timezone;
        if (typeof timezone !== "string" || !timezone) throw new Error("Athlete profile has no valid timezone");

        const range = getWeekRange(timezone, week_start);
        const today = localDate(new Date(), timezone);
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
        const eventById = new Map((plannedEvents ?? []).map(event => [String(event.id ?? ""), event]));
        const activityByEventId = new Map((activities ?? []).filter(activity => activity.paired_event_id != null).map(activity => [String(activity.paired_event_id), activity]));
        const days = groupWeekRecords(range, activities ?? [], plannedEvents ?? []).map(day => ({
          ...day,
          activities: day.activities.map(activity => activitySummary(activity, activity.paired_event_id == null ? null : eventById.get(String(activity.paired_event_id)) ?? null)),
          planned_events: day.planned_events.map(event => eventSummary(event, activityByEventId.get(String(event.id ?? "")) ?? null, today)),
        }));
        const totals = aggregateTotals(activities ?? [], plannedEvents ?? []);
        const progress = weekProgress(range, today);
        return structuredResult(`Week ${range.weekStart}–${range.weekEnd}: ${totals.activity_count} activities, ${totals.planned_event_count} planned events.`, {
          week_start: range.weekStart,
          week_end: range.weekEnd,
          timezone,
          ...progress,
          days,
          totals,
        });
      } catch (error) {
        return errorResult("fetching weekly snapshot", error);
      }
    },
  );
}
