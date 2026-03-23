import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { formatEventSummary, formatEventDetails } from "../formatting.js";

export function registerEventTools(server: McpServer, client: IntervalsClient): void {

  server.tool(
    "get_events",
    "Get planned events/workouts for the athlete",
    {
      start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: today)"),
      end_date: z.string().optional().describe("End date YYYY-MM-DD (default: 30 days from today)"),
    },
    async ({ start_date, end_date }) => {
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      try {
        const events = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/events`,
          { oldest: start_date ?? today, newest: end_date ?? future }
        );
        if (!events?.length) return { content: [{ type: "text" as const, text: "No events found." }] };
        const text = "Events:\n\n" + events.map(e => formatEventSummary(e)).join("\n\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching events: ${e}` }] };
      }
    }
  );

  server.tool(
    "get_event_by_id",
    "Get detailed information for a specific planned event",
    { event_id: z.string().describe("The Intervals.icu event ID") },
    async ({ event_id }) => {
      try {
        const event = await client.get<Record<string, unknown>>(
          `/athlete/${client.athleteId}/event/${event_id}`
        );
        return { content: [{ type: "text" as const, text: formatEventDetails(event) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error fetching event: ${e}` }] };
      }
    }
  );

  server.tool(
    "delete_event",
    "Delete a single planned event. Permanent — confirm with athlete before calling.",
    { event_id: z.string().describe("The Intervals.icu event ID to delete") },
    async ({ event_id }) => {
      try {
        await client.delete(`/athlete/${client.athleteId}/events/${event_id}`);
        return { content: [{ type: "text" as const, text: `Event ${event_id} deleted.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error deleting event: ${e}` }] };
      }
    }
  );

  server.tool(
    "delete_events_by_date_range",
    "Delete all planned events in a date range. Permanent.",
    {
      start_date: z.string().describe("Start date YYYY-MM-DD"),
      end_date: z.string().describe("End date YYYY-MM-DD"),
    },
    async ({ start_date, end_date }) => {
      try {
        const events = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/events`,
          { oldest: start_date, newest: end_date }
        );
        if (!events?.length) {
          return { content: [{ type: "text" as const, text: "No events found in the specified date range." }] };
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
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error: ${e}` }] };
      }
    }
  );

  server.tool(
    "add_or_update_event",
    "Create or update a planned workout event. See workout_doc for structured interval definitions.",
    {
      name: z.string().describe("Event name (e.g. 'Easy Run', 'Threshold Ride')"),
      workout_type: z.enum(["Ride", "Run", "Swim", "Walk", "Row"]).describe("Sport type"),
      start_date: z.string().optional().describe("Date YYYY-MM-DD (default: today)"),
      event_id: z.string().optional().describe("Provide to update an existing event"),
      moving_time: z.number().int().optional().describe("Expected duration in seconds"),
      distance: z.number().int().optional().describe("Expected distance in metres"),
      workout_doc: z.object({
        description: z.string().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
      }).optional().describe(
        "Structured workout steps. Each step can have: duration (secs), distance (m), " +
        "power/hr/pace/cadence with value+units, reps with nested steps array, warmup/cooldown booleans, text label."
      ),
    },
    async ({ name, workout_type, start_date, event_id, moving_time, distance, workout_doc }) => {
      const date = start_date ?? new Date().toISOString().slice(0, 10);
      const eventData: Record<string, unknown> = {
        start_date_local: `${date}T00:00:00`,
        category: "WORKOUT",
        name,
        type: workout_type,
        moving_time,
        distance,
        description: workout_doc ? JSON.stringify(workout_doc) : undefined,
      };

      try {
        if (event_id) {
          const result = await client.put(
            `/athlete/${client.athleteId}/events/${event_id}`, eventData
          );
          return { content: [{ type: "text" as const, text: `Event updated: ${JSON.stringify(result, null, 2)}` }] };
        } else {
          const result = await client.post(
            `/athlete/${client.athleteId}/events`, eventData
          );
          return { content: [{ type: "text" as const, text: `Event created: ${JSON.stringify(result, null, 2)}` }] };
        }
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error saving event: ${e}` }] };
      }
    }
  );

} // end registerEventTools
