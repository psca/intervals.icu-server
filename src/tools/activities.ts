import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { formatActivitySummary, formatIntervals } from "../formatting.js";

function defaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
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

      try {
        let activities = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/activities`, params
        );
        if (!include_unnamed) {
          activities = activities.filter(a => a.name && a.name !== "Unnamed");
        }
        activities = activities.slice(0, limit);
        if (!activities.length) {
          return { content: [{ type: "text" as const, text: "No activities found in the specified date range." }] };
        }
        const text = "Activities:\n\n" + activities.map(a => formatActivitySummary(a)).join("\n\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching activities: ${e}` }] };
      }
    }
  );

  server.tool(
    "get_activity_details",
    "Get detailed information for a specific activity",
    { activity_id: z.string().describe("The Intervals.icu activity ID") },
    async ({ activity_id }) => {
      try {
        const result = await client.get<Record<string, unknown>>(`/activity/${activity_id}`);
        const activity = Array.isArray(result) ? result[0] : result;
        return { content: [{ type: "text" as const, text: formatActivitySummary(activity as Record<string, unknown>) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching activity: ${e}` }] };
      }
    }
  );

  server.tool(
    "get_activity_intervals",
    "Get interval data for a specific activity",
    { activity_id: z.string().describe("The Intervals.icu activity ID") },
    async ({ activity_id }) => {
      try {
        const result = await client.get<Record<string, unknown>>(`/activity/${activity_id}/intervals`);
        if (!result || (!('icu_intervals' in result) && !('icu_groups' in result))) {
          return { content: [{ type: "text" as const, text: "No interval data found." }] };
        }
        return { content: [{ type: "text" as const, text: formatIntervals(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching intervals: ${e}` }] };
      }
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
      try {
        const streams = await client.get<Record<string, unknown>[]>(
          `/activity/${activity_id}/streams`, { types }
        );
        if (!streams?.length) return { content: [{ type: "text" as const, text: "No stream data found." }] };
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
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching streams: ${e}` }] };
      }
    }
  );

  server.tool(
    "get_activity_stream_sampled",
    "Get sampled stream data at regular time intervals. Designed for GPS/route analysis without full token cost.",
    {
      activity_id: z.string().describe("The Intervals.icu activity ID"),
      stream_types: z.string().describe("Comma-separated stream types, e.g. 'latlng,bearing'"),
      interval_seconds: z.number().int().optional().default(1800).describe("Sample one point every N seconds (default: 1800 = 30 min)"),
    },
    async ({ activity_id, stream_types, interval_seconds }) => {
      try {
        const streams = await client.get<Record<string, unknown>[]>(
          `/activity/${activity_id}/streams`, { types: stream_types }
        );
        if (!streams?.length) return { content: [{ type: "text" as const, text: "No stream data found." }] };

        const timeStream = streams.find(s => s.type === "time");
        const timeData = (timeStream?.data as number[]) ?? [];

        let sampleIndices: number[];
        if (timeData.length) {
          sampleIndices = timeData
            .map((t, i) => ({ t, i }))
            .filter(({ t }) => t % interval_seconds === 0)
            .map(({ i }) => i);
          if (!sampleIndices.length || sampleIndices[0] !== 0) sampleIndices.unshift(0);
        } else {
          const total = Math.max(...streams.map(s => ((s.data as unknown[]) ?? []).length));
          sampleIndices = Array.from({ length: Math.ceil(total / interval_seconds) }, (_, i) => i * interval_seconds);
        }

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

        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching streams: ${e}` }] };
      }
    }
  );

  // get_activity_weather registered in Task 9 (weather chunk)

} // end registerActivityTools
