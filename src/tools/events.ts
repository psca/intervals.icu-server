import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { formatEventSummary, formatEventDetails } from "../formatting.js";
import { toolHandler } from "../utils.js";

export function registerEventTools(server: McpServer, client: IntervalsClient): void {

  server.registerTool(
    "get_events",
    {
      description: "Get planned events/workouts for the athlete",
      inputSchema: {
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: today)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: 30 days from today)"),
      },
    },
    async ({ start_date, end_date }) => {
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      return toolHandler(async () => {
        const events = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/events`,
          { oldest: start_date ?? today, newest: end_date ?? future }
        );
        if (!events?.length) return "No events found.";
        return "Events:\n\n" + events.map(e => formatEventSummary(e)).join("\n\n");
      }, "fetching events");
    }
  );

  server.registerTool(
    "get_event_by_id",
    {
      description: "Get detailed information for a specific planned event",
      inputSchema: {
        event_id: z.string().describe("The Intervals.icu event ID"),
      },
    },
    async ({ event_id }) => {
      return toolHandler(async () => {
        const event = await client.get<Record<string, unknown>>(
          `/athlete/${client.athleteId}/event/${event_id}`
        );
        return formatEventDetails(event);
      }, "fetching event");
    }
  );

  server.registerTool(
    "delete_event",
    {
      description: "Delete a single planned event. Permanent — confirm with athlete before calling.",
      inputSchema: {
        event_id: z.string().describe("The Intervals.icu event ID to delete"),
      },
    },
    async ({ event_id }) => {
      return toolHandler(async () => {
        await client.delete(`/athlete/${client.athleteId}/events/${event_id}`);
        return `Event ${event_id} deleted.`;
      }, "deleting event");
    }
  );

  server.registerTool(
    "delete_events_by_date_range",
    {
      description: "Delete all planned events in a date range. Permanent.",
      inputSchema: {
        start_date: z.string().describe("Start date YYYY-MM-DD"),
        end_date: z.string().describe("End date YYYY-MM-DD"),
      },
    },
    async ({ start_date, end_date }) => {
      return toolHandler(async () => {
        const events = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/events`,
          { oldest: start_date, newest: end_date }
        );
        if (!events?.length) {
          return "No events found in the specified date range.";
        }

        const TRUNCATION_BOUNDARIES = [100, 200, 500, 1000];
        const truncationWarning = TRUNCATION_BOUNDARIES.includes(events.length)
          ? ` Warning: exactly ${events.length} events returned — the API may have truncated results. Consider using a narrower date range.`
          : "";

        let deleted = 0;
        const failed: unknown[] = [];
        await Promise.all(events.map(async e => {
          try {
            await client.delete(`/athlete/${client.athleteId}/events/${e.id}`);
            deleted++;
          } catch {
            failed.push(e.id);
          }
        }));
        let text = `Deleted ${deleted} events.`;
        if (failed.length) text += ` Failed: ${failed.length} (${failed.join(", ")})`;
        text += truncationWarning;
        return text;
      }, "deleting events");
    }
  );

  server.registerTool(
    "add_or_update_event",
    {
      description: "Create or update a planned workout event. Use description for workout steps — the server parses it into structured steps and computes training load. workout_doc is a server-generated field returned on reads; avoid sending it on writes.",
      inputSchema: {
        name: z.string().describe("Event name (e.g. 'Easy Run', 'Threshold Ride')"),
        workout_type: z.enum(["Ride", "Run", "Swim", "Walk", "Row"]).describe("Sport type"),
        start_date: z.string().optional().describe("Date YYYY-MM-DD (default: today)"),
        event_id: z.string().optional().describe("Provide to update an existing event"),
        moving_time: z.number().int().optional().describe("Expected duration in seconds"),
        distance: z.number().int().optional().describe("Expected distance in metres"),
        description: z.string().optional().describe(
          "Workout steps in intervals.icu text syntax — the server parses this into structured steps and computes training load (TSS, duration, intensity). " +
          "Use '- ' prefix for steps, plain lines for section headers. " +
          "Examples: '- 10km 89% LTHR', '- 30m Z2 HR', '- 8x\\n- 400m 5:00/km Pace\\n- 200m easy'. " +
          "Always use this field for defining workout content — do not use workout_doc on writes."
        ),
        workout_doc: z.object({
          description: z.string().optional(),
          steps: z.array(z.record(z.string(), z.unknown())).optional(),
        }).optional().describe(
          "Server-generated workout structure returned on reads. Sending this on writes is not recommended — " +
          "the step format is undocumented and the server does not compute training load from raw steps. Use description instead."
        ),
      },
    },
    async ({ name, workout_type, start_date, event_id, moving_time, distance, description, workout_doc }) => {
      const date = start_date ?? new Date().toISOString().slice(0, 10);
      const eventData: Record<string, unknown> = {
        start_date_local: `${date}T00:00:00`,
        category: "WORKOUT",
        name,
        type: workout_type,
        moving_time,
        distance,
        description,
        workout_doc,
      };

      return toolHandler(async () => {
        if (event_id) {
          const result = await client.put(
            `/athlete/${client.athleteId}/events/${event_id}`, eventData
          );
          return `Event updated: ${JSON.stringify(result, null, 2)}`;
        } else {
          const result = await client.post(
            `/athlete/${client.athleteId}/events`, eventData
          );
          return `Event created: ${JSON.stringify(result, null, 2)}`;
        }
      }, "saving event");
    }
  );

} // end registerEventTools
