import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { computeActivityWeather } from "../weather.js";
import { defaultDateRange } from "../utils.js";
import { errorResult, textResult, type ToolTextResult } from "./result.js";
import { localTimestampSchema } from "./events.js";

type ActivityRecord = Record<string, unknown>;

const activityObjectSchema = z.record(z.string(), z.unknown());

const completedActivityInputSchema = z.object({
  name: z.string().trim().min(1).describe("Completed session title"),
  type: z.string().trim().min(1).describe("Sport type, e.g. WeightTraining, Run, Ride, Swim"),
  start_date_local: localTimestampSchema.describe(
    "Athlete-local start time YYYY-MM-DDTHH:mm:ss in the timezone configured in Intervals.icu; do not append Z or an offset"
  ),
  moving_time: z.number().int().positive().describe(
    "Recorded session duration in seconds; for strength training use the session duration, not an estimate of active lifting time"
  ),
  elapsed_time: z.number().int().positive().optional().describe(
    "Total elapsed seconds, at least moving_time; defaults to moving_time"
  ),
  description: z.string().optional().describe(
    "Completed session notes; preserve strength exercises, sets, reps, and weights here"
  ),
  distance: z.number().finite().nonnegative().optional().describe("Recorded distance in metres"),
  external_id: z.string().trim().min(1).optional().describe(
    "Optional source identifier; does not guarantee duplicate prevention"
  ),
  icu_rpe: z.number().int().min(1).max(10).optional().describe(
    "Athlete-reported whole-session effort, 1–10. Intervals.icu derives session_rpe separately; this does not set training load"
  ),
  feel: z.number().int().min(1).max(5).optional().describe(
    "Athlete-reported feel: 1=strong, 3=normal, 5=weak"
  ),
  paired_event_id: z.number().int().positive().optional().describe(
    "Calendar event ID to pair with this completion, not a library workout ID. Does not copy planned training load"
  ),
  icu_training_load: z.number().int().nonnegative().optional().describe(
    "Explicit supplied training load. Do not derive from RPE or copy planned load automatically; session_rpe uses a different scale"
  ),
});

const updateCompletedActivityInputSchema = completedActivityInputSchema.partial().extend({
  activity_id: z.string().trim().min(1).describe("ID of the completed activity to update"),
  elapsed_time: completedActivityInputSchema.shape.elapsed_time.describe(
    "New total elapsed seconds, at least the effective moving_time; omit to preserve the existing elapsed time"
  ),
  paired_event_id: completedActivityInputSchema.shape.paired_event_id.unwrap().nullable().optional().describe(
    "Calendar event ID to pair with this completion, or null to unpair. Omit to preserve the existing pairing"
  ),
});

async function withActivityToolResult(
  errorLabel: string,
  fn: () => Promise<ToolTextResult>,
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(errorLabel, error);
  }
}

/** Compute sample indices for time-based downsampling. Falls back to stride-based if no time data. */
export function computeSampleIndices(timeData: number[], totalPoints: number, intervalSeconds: number): number[] {
  if (timeData.length) {
    const indices = timeData
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t % intervalSeconds === 0)
      .map(({ i }) => i);
    if (!indices.length || indices[0] !== 0) indices.unshift(0);
    return indices;
  }
  return Array.from({ length: Math.ceil(totalPoints / intervalSeconds) }, (_, i) => i * intervalSeconds);
}

export function registerActivityTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "create_completed_activity",
    {
      description: "Create a completed manual activity, including strength sessions (WeightTraining). " +
        "Store exercises, sets, reps, and weights in description. Use only recorded values; never invent RPE, calories, or training load. " +
        "Optional fields record reported RPE/feel, an explicit training load, and a planned calendar event pairing. RPE and pairing do not automatically set training load. " +
        "This creates training history; use add_or_update_event for planned workouts. " +
        "A failed write may have succeeded: inspect activities before retrying to avoid duplicates.",
      inputSchema: completedActivityInputSchema.shape,
      outputSchema: { activity: activityObjectSchema },
    },
    async args => withActivityToolResult("creating completed activity", async () => {
      const input = completedActivityInputSchema.parse(args);
      const elapsedTime = input.elapsed_time ?? input.moving_time;
      if (elapsedTime < input.moving_time) {
        throw new Error("elapsed_time must be at least moving_time");
      }

      try {
        const activity = await client.post<ActivityRecord | null>(
          `/athlete/${client.athleteId}/activities/manual`,
          { ...input, elapsed_time: elapsedTime },
        );
        if (!activity || typeof activity.id !== "string" || !activity.id.trim()) {
          throw new Error("Intervals.icu returned no usable activity ID");
        }
        return textResult({ activity });
      } catch (error) {
        throw new Error(
          `Activity creation outcome is unknown. Inspect activities before retrying to avoid duplicates. ${error}`
        );
      }
    }),
  );

  server.registerTool(
    "update_completed_activity",
    {
      description: "Update an existing completed activity using only explicitly supplied fields. " +
        "Supports notes, title, sport, date/time, duration, distance, source ID, reported RPE/feel, explicit load, and calendar pairing. " +
        "Omitted fields are preserved; paired_event_id=null unpairs. " +
        "Never infer feedback or training load. Ask the athlete for any missing subjective rating they want recorded. " +
        "Use add_or_update_event for planned workouts. A failed write may have succeeded; inspect the activity before retrying.",
      inputSchema: updateCompletedActivityInputSchema.shape,
      outputSchema: { activity: activityObjectSchema },
    },
    async args => withActivityToolResult("updating completed activity", async () => {
      const { activity_id, ...parsedChanges } = updateCompletedActivityInputSchema.parse(args);
      const changes = Object.fromEntries(Object.entries(parsedChanges).filter(([, value]) => value !== undefined));
      if (!Object.keys(changes).length) throw new Error("Provide at least one supported field to update");

      const path = `/activity/${encodeURIComponent(activity_id)}`;
      const current = await client.get<ActivityRecord | null>(path);
      if (!current || current.id !== activity_id) throw new Error("Target activity was not found or its ID did not match");
      if (current.icu_athlete_id != null && current.icu_athlete_id !== client.athleteId) {
        throw new Error("Target activity belongs to a different athlete");
      }

      if (changes.moving_time !== undefined || changes.elapsed_time !== undefined) {
        const movingTime = completedActivityInputSchema.shape.moving_time.safeParse(changes.moving_time ?? current.moving_time);
        const elapsedTime = completedActivityInputSchema.shape.elapsed_time.unwrap().safeParse(changes.elapsed_time ?? current.elapsed_time);
        if (!movingTime.success || !elapsedTime.success) {
          throw new Error("Existing duration is unavailable or invalid; supply both moving_time and elapsed_time");
        }
        if (elapsedTime.data < movingTime.data) throw new Error("elapsed_time must be at least moving_time");
      }

      try {
        const activity = await client.put<ActivityRecord | null>(path, { id: activity_id, ...changes });
        if (!activity || activity.id !== activity_id) {
          throw new Error("Intervals.icu returned no matching activity ID");
        }
        return textResult({ activity });
      } catch (error) {
        throw new Error(
          `Activity update outcome is unknown. Inspect activity ${activity_id} before retrying. ${error}`
        );
      }
    }),
  );

  server.registerTool(
    "get_activities",
    {
      description: "Get a list of activities for the athlete from Intervals.icu",
      inputSchema: {
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
        limit: z.number().int().optional().default(10).describe("Max activities to return"),
        include_unnamed: z.boolean().optional().default(false).describe("Include unnamed activities"),
      },
      outputSchema: {
        activities: z.array(activityObjectSchema),
        count: z.number().int(),
      },
    },
    async ({ start_date, end_date, limit, include_unnamed }) => {
      const { start, end } = defaultDateRange();
      const apiLimit = include_unnamed ? limit : limit * 3;
      const params = { oldest: start_date ?? start, newest: end_date ?? end, limit: String(apiLimit) };

      return withActivityToolResult("fetching activities", async () => {
        let activities = await client.get<ActivityRecord[]>(
          `/athlete/${client.athleteId}/activities`, params
        );
        if (!include_unnamed) {
          activities = activities.filter(a => a.name && a.name !== "Unnamed");
        }
        activities = activities.slice(0, limit);
        if (!activities.length) {
          return textResult({ activities: [], count: 0 });
        }
        return textResult({ activities, count: activities.length });
      });
    }
  );

  server.registerTool(
    "get_activity_details",
    {
      description: "Get detailed information for a specific activity",
      inputSchema: {
        activity_id: z.string().describe("The Intervals.icu activity ID"),
      },
      outputSchema: {
        activity: activityObjectSchema,
      },
    },
    async ({ activity_id }) => {
      return withActivityToolResult("fetching activity", async () => {
        const result = await client.get<ActivityRecord>(`/activity/${activity_id}`);
        const activity = Array.isArray(result) ? result[0] : result;
        return textResult({ activity });
      });
    }
  );

  server.registerTool(
    "get_activity_intervals",
    {
      description: "Get interval data for a specific activity",
      inputSchema: {
        activity_id: z.string().describe("The Intervals.icu activity ID"),
      },
      outputSchema: {
        activity_id: z.string(),
        interval_count: z.number().int(),
        group_count: z.number().int(),
        intervals_data: activityObjectSchema.nullable(),
      },
    },
    async ({ activity_id }) => {
      return withActivityToolResult("fetching intervals", async () => {
        const result = await client.get<ActivityRecord>(`/activity/${activity_id}/intervals`);
        const intervalCount = Array.isArray(result?.icu_intervals) ? result.icu_intervals.length : 0;
        const groupCount = Array.isArray(result?.icu_groups) ? result.icu_groups.length : 0;
        if (!result || (!("icu_intervals" in result) && !("icu_groups" in result))) {
          return textResult({
            activity_id,
            interval_count: 0,
            group_count: 0,
            intervals_data: null,
          });
        }
        return textResult({
          activity_id,
          interval_count: intervalCount,
          group_count: groupCount,
          intervals_data: result,
        });
      });
    }
  );

  server.registerTool(
    "get_activity_streams",
    {
      description: "Get time-series stream data for a specific activity. High token cost — use only for decoupling or VI analysis.",
      inputSchema: {
        activity_id: z.string().describe("The Intervals.icu activity ID"),
        stream_types: z.string().optional().describe(
          "Comma-separated stream types (default: time,watts,heartrate,cadence,altitude,distance,velocity_smooth). " +
          "Available: latlng, bearing, temp, grade_smooth, w_bal, and many more — see intervals.icu docs."
        ),
      },
      outputSchema: {
        activity_id: z.string(),
        requested_stream_types: z.string(),
        streams: z.array(activityObjectSchema),
      },
    },
    async ({ activity_id, stream_types }) => {
      const types = stream_types ?? "time,watts,heartrate,cadence,altitude,distance,velocity_smooth";
      return withActivityToolResult("fetching streams", async () => {
        const streams = await client.get<ActivityRecord[]>(
          `/activity/${activity_id}/streams`, { types }
        );
        if (!streams?.length) {
          return textResult({
            activity_id,
            requested_stream_types: types,
            streams: [],
          });
        }
        return textResult({
          activity_id,
          requested_stream_types: types,
          streams,
        });
      });
    }
  );

  server.registerTool(
    "get_activity_route",
    {
      description: "Get GPS/route data for an activity, sampled at regular intervals. Use for route analysis, elevation profiles, or waypoint inspection without full stream token cost.",
      inputSchema: {
        activity_id: z.string().describe("The Intervals.icu activity ID"),
        stream_types: z.string().describe("Comma-separated stream types, e.g. 'latlng,bearing'"),
        interval_seconds: z.number().int().optional().default(1800).describe("Sample one point every N seconds (default: 1800 = 30 min)"),
      },
      outputSchema: {
        activity_id: z.string(),
        requested_stream_types: z.string(),
        route_data: activityObjectSchema.nullable(),
      },
    },
    async ({ activity_id, stream_types, interval_seconds }) => {
      return withActivityToolResult("fetching streams", async () => {
        const requestTypes = stream_types.split(",").map(s => s.trim()).includes("time")
          ? stream_types
          : `time,${stream_types}`;
        const streams = await client.get<ActivityRecord[]>(
          `/activity/${activity_id}/streams`, { types: requestTypes }
        );
        if (!streams?.length) {
          return textResult({
            activity_id,
            requested_stream_types: stream_types,
            route_data: null,
          });
        }

        const timeStream = streams.find(s => s.type === "time");
        const timeData = (timeStream?.data as number[]) ?? [];
        const total = Math.max(0, ...streams.map(s => ((s.data as unknown[]) ?? []).length));
        const sampleIndices = computeSampleIndices(timeData, total, interval_seconds);

        const output: Record<string, unknown> = {};
        for (const stream of streams) {
          if (stream.type === "time") continue;
          const data = (stream.data as unknown[]) ?? [];
          const data2 = (stream.data2 as unknown[]) ?? [];
          const sampled = sampleIndices.filter(i => i < data.length).map(i => data[i]);
          if (stream.type === "latlng") {
            const sampled2 = sampleIndices.filter(i => i < data2.length).map(i => data2[i]);
            output.latlng = { lats: sampled, lngs: sampled2 };
          } else if (data2.length) {
            const sampled2 = sampleIndices.filter(i => i < data2.length).map(i => data2[i]);
            output[stream.type as string] = { data: sampled, data2: sampled2 };
          } else {
            output[stream.type as string] = { data: sampled };
          }
        }
        output.interval_seconds = interval_seconds;
        output.total_points = timeData.length;
        output.sampled_points = sampleIndices.length;

        return textResult({
          activity_id,
          requested_stream_types: stream_types,
          route_data: output,
        });
      });
    }
  );

  server.registerTool(
    "get_activity_weather",
    {
      description:
        "Get weather conditions for an outdoor activity. Fetches GPS streams + Open-Meteo data server-side. " +
        "Returns description, feels-like temp, wind speed/direction, headwind/tailwind %, precipitation flags, and ASCII temp bar.",
      inputSchema: {
        activity_id: z.string().describe("The Intervals.icu activity ID"),
      },
      outputSchema: {
        activity_id: z.string(),
        weather_available: z.boolean(),
        reason: z.string().nullable(),
        weather: activityObjectSchema.nullable(),
      },
    },
    async ({ activity_id }) => {
      return withActivityToolResult("fetching activity weather", async () => {
        const activity = await client.get<ActivityRecord>(`/activity/${activity_id}`);
        const startDateLocal = activity.start_date_local as string | undefined;
        if (!startDateLocal) {
          return textResult({
            activity_id,
            weather_available: false,
            reason: "missing start date",
            weather: null,
          });
        }

        const date = startDateLocal.slice(0, 10);
        const startHour = parseInt(startDateLocal.slice(11, 13), 10);

        const streams = await client.get<ActivityRecord[]>(
          `/activity/${activity_id}/streams`,
          { types: "time,latlng,bearing" }
        );

        const timeStream = streams.find(s => s.type === "time");
        const latlngStream = streams.find(s => s.type === "latlng");
        const bearingStream = streams.find(s => s.type === "bearing");

        const timeData = (timeStream?.data as number[]) ?? [];
        const lats = (latlngStream?.data as number[]) ?? [];
        const lngs = (latlngStream?.data2 as number[]) ?? [];
        const bearingData = (bearingStream?.data as (number | null)[]) ?? [];

        if (!lats.length || !lngs.length) {
          return textResult({
            activity_id,
            weather_available: false,
            reason: "no GPS data for this activity",
            weather: null,
          });
        }

        const sampleIndices = computeSampleIndices(timeData, lats.length, 1800);
        const sampledLats = sampleIndices.filter(i => i < lats.length).map(i => lats[i]);
        const sampledLngs = sampleIndices.filter(i => i < lngs.length).map(i => lngs[i]);
        const sampledTime = sampleIndices.filter(i => i < timeData.length).map(i => timeData[i]);

        const weather = await computeActivityWeather(
          date, startHour, sampledLats, sampledLngs, bearingData, sampledTime, sampleIndices
        );

        return textResult({
          activity_id,
          weather_available: true,
          reason: null,
          weather,
        });
      });
    }
  );
}
