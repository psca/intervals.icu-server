import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { formatWellnessEntry } from "../formatting.js";

function defaultDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

export function registerWellnessTools(server: McpServer, client: IntervalsClient): void {
  server.tool(
    "get_wellness_data",
    "Get wellness data (HRV, resting HR, CTL, ATL, TSB, weight, sleep) for the athlete",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
    },
    async ({ start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      const params = { oldest: start_date ?? start, newest: end_date ?? end };

      try {
        const result = await client.get<unknown[]>(
          `/athlete/${client.athleteId}/wellness`,
          params
        );
        if (!result || (Array.isArray(result) && result.length === 0)) {
          return { content: [{ type: "text" as const, text: "No wellness data found for the specified date range." }] };
        }
        const entries = Array.isArray(result) ? result : Object.values(result as object);
        const text = "Wellness Data:\n\n" + entries
          .map(e => formatWellnessEntry(e as Record<string, unknown>))
          .join("\n\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching wellness data: ${e}` }] };
      }
    }
  );
}
