import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { formatActivitySummary, formatIntervals } from "../formatting.js";
import { computeActivityWeather } from "../weather.js";
import { defaultDateRange, toolHandler } from "../utils.js";

/** Compute sample indices for time-based downsampling. Falls back to stride-based if no time data. */
function computeSampleIndices(timeData: number[], totalPoints: number, intervalSeconds: number): number[] {
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

  server.tool(
    "get_activities",
    "Get a list of activities for the athlete from Intervals.icu",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      limit: z.number().int().optional().default(10).describe("Max activities to return"),
      include_unnamed: z.boolean().optional().default(false).describe("Include unnamed activities"),
    },
    async ({ start_date, end_date, limit, include_unnamed }) => {
      const { start, end } = defaultDateRange();
      const apiLimit = include_unnamed ? limit : limit * 3;
      const params = { oldest: start_date ?? start, newest: end_date ?? end, limit: String(apiLimit) };

      return toolHandler(async () => {
        let activities = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/activities`, params
        );
        if (!include_unnamed) {
          activities = activities.filter(a => a.name && a.name !== "Unnamed");
        }
        activities = activities.slice(0, limit);
        if (!activities.length) return "No activities found in the specified date range.";
        return "Activities:\n\n" + activities.map(a => formatActivitySummary(a)).join("\n\n");
      }, "fetching activities");
    }
  );

  server.tool(
    "get_activity_details",
    "Get detailed information for a specific activity",
    { activity_id: z.string().describe("The Intervals.icu activity ID") },
    async ({ activity_id }) => {
      return toolHandler(async () => {
        const result = await client.get<Record<string, unknown>>(`/activity/${activity_id}`);
        const activity = Array.isArray(result) ? result[0] : result;
        return formatActivitySummary(activity as Record<string, unknown>);
      }, "fetching activity");
    }
  );

  server.tool(
    "get_activity_intervals",
    "Get interval data for a specific activity",
    { activity_id: z.string().describe("The Intervals.icu activity ID") },
    async ({ activity_id }) => {
      return toolHandler(async () => {
        const result = await client.get<Record<string, unknown>>(`/activity/${activity_id}/intervals`);
        if (!result || (!('icu_intervals' in result) && !('icu_groups' in result))) {
          return "No interval data found.";
        }
        return formatIntervals(result);
      }, "fetching intervals");
    }
  );

  server.tool(
    "get_activity_streams",
    "Get time-series stream data for a specific activity. High token cost — use only for decoupling or VI analysis.",
    {
      activity_id: z.string().describe("The Intervals.icu activity ID"),
      stream_types: z.string().optional().describe(
        "Comma-separated stream types (default: time,watts,heartrate,cadence,altitude,distance,velocity_smooth). " +
        "Available: latlng, bearing, temp, grade_smooth, w_bal, and many more — see intervals.icu docs."
      ),
    },
    async ({ activity_id, stream_types }) => {
      const types = stream_types ?? "time,watts,heartrate,cadence,altitude,distance,velocity_smooth";
      return toolHandler(async () => {
        const streams = await client.get<Record<string, unknown>[]>(
          `/activity/${activity_id}/streams`, { types }
        );
        if (!streams?.length) return "No stream data found.";
        let text = `Activity Streams for ${activity_id}:\n\n`;
        for (const s of streams) {
          const data = s.data as unknown[] ?? [];
          const data2 = s.data2 as unknown[] ?? [];
          const isLatlng = s.type === "latlng";
          text += `Stream: ${s.name ?? s.type} (${s.type})\n`;
          text += `  Value Type: ${s.valueType ?? "N/A"}\n`;
          text += `  Data Points: ${data.length}\n`;
          if (data.length <= 10) {
            text += `  ${isLatlng ? "Lat" : "Values"}: ${JSON.stringify(data)}\n`;
          } else {
            text += `  ${isLatlng ? "Lat" : "Values"} first 5: ${JSON.stringify(data.slice(0, 5))}\n`;
            text += `  ${isLatlng ? "Lat" : "Values"} last 5: ${JSON.stringify(data.slice(-5))}\n`;
          }
          if (data2.length) {
            if (data2.length <= 10) text += `  ${isLatlng ? "Lng" : "Data2"}: ${JSON.stringify(data2)}\n`;
            else {
              text += `  ${isLatlng ? "Lng" : "Data2"} first 5: ${JSON.stringify(data2.slice(0, 5))}\n`;
              text += `  ${isLatlng ? "Lng" : "Data2"} last 5: ${JSON.stringify(data2.slice(-5))}\n`;
            }
          }
          text += "\n";
        }
        return text;
      }, "fetching streams");
    }
  );

  server.tool(
    "get_activity_route",
    "Get GPS/route data for an activity, sampled at regular intervals. Use for route analysis, elevation profiles, or waypoint inspection without full stream token cost.",
    {
      activity_id: z.string().describe("The Intervals.icu activity ID"),
      stream_types: z.string().describe("Comma-separated stream types, e.g. 'latlng,bearing'"),
      interval_seconds: z.number().int().optional().default(1800).describe("Sample one point every N seconds (default: 1800 = 30 min)"),
    },
    async ({ activity_id, stream_types, interval_seconds }) => {
      return toolHandler(async () => {
        // Always request 'time' for accurate time-based sampling
        const requestTypes = stream_types.split(",").map(s => s.trim()).includes("time")
          ? stream_types
          : `time,${stream_types}`;
        const streams = await client.get<Record<string, unknown>[]>(
          `/activity/${activity_id}/streams`, { types: requestTypes }
        );
        if (!streams?.length) return "No stream data found.";

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
            output["latlng"] = { lats: sampled, lngs: sampled2 };
          } else if (data2.length) {
            const sampled2 = sampleIndices.filter(i => i < data2.length).map(i => data2[i]);
            output[stream.type as string] = { data: sampled, data2: sampled2 };
          } else {
            output[stream.type as string] = { data: sampled };
          }
        }
        output["interval_seconds"] = interval_seconds;
        output["total_points"] = timeData.length;
        output["sampled_points"] = sampleIndices.length;

        return JSON.stringify(output, null, 2);
      }, "fetching streams");
    }
  );

  server.tool(
    "get_activity_weather",
    "Get weather conditions for an outdoor activity. Fetches GPS streams + Open-Meteo data server-side. " +
    "Returns description, feels-like temp, wind speed/direction, headwind/tailwind %, precipitation flags, and ASCII temp bar.",
    { activity_id: z.string().describe("The Intervals.icu activity ID") },
    async ({ activity_id }) => {
      return toolHandler(async () => {
        const activity = await client.get<Record<string, unknown>>(`/activity/${activity_id}`);
        const startDateLocal = activity.start_date_local as string | undefined;
        if (!startDateLocal) return "Weather unavailable: missing start date.";

        const date = startDateLocal.slice(0, 10);
        const startHour = parseInt(startDateLocal.slice(11, 13), 10);

        const streams = await client.get<Record<string, unknown>[]>(
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
          return "Weather unavailable: no GPS data for this activity.";
        }

        const sampleIndices = computeSampleIndices(timeData, lats.length, 1800);

        const sampledLats = sampleIndices.filter(i => i < lats.length).map(i => lats[i]);
        const sampledLngs = sampleIndices.filter(i => i < lngs.length).map(i => lngs[i]);
        const sampledTime = sampleIndices.filter(i => i < timeData.length).map(i => timeData[i]);

        const result = await computeActivityWeather(
          date, startHour, sampledLats, sampledLngs, bearingData, sampledTime, sampleIndices
        );

        return JSON.stringify(result, null, 2);
      }, "fetching activity weather");
    }
  );

} // end registerActivityTools
