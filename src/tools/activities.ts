import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { computeActivityWeather } from "../weather.js";
import { defaultDateRange } from "../utils.js";
import { errorResult, textResult, type ToolTextResult } from "./result.js";

type ActivityRecord = Record<string, unknown>;

const activityObjectSchema = z.record(z.string(), z.unknown());

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
