import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { errorResult, textResult, type ToolTextResult } from "./result.js";

type EventRecord = Record<string, unknown>;

const eventObjectSchema = z.record(z.string(), z.unknown());

const targetMetricSchema = z.enum(["AUTO", "POWER", "HR", "PACE"]);

function stripUndefinedFields(value: EventRecord): EventRecord {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined));
}

async function withEventToolResult(
  errorLabel: string,
  fn: () => Promise<ToolTextResult>,
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(errorLabel, error);
  }
}

export function registerEventTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "get_events",
    {
      description: "Get planned events/workouts for the athlete",
      inputSchema: {
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: today)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: 30 days from today)"),
      },
      outputSchema: {
        events: z.array(eventObjectSchema),
        count: z.number().int(),
      },
    },
    async ({ start_date, end_date }) => {
      const today = new Date().toISOString().slice(0, 10);
      const future = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      return withEventToolResult("fetching events", async () => {
        const events = await client.get<EventRecord[]>(
          `/athlete/${client.athleteId}/events`,
          { oldest: start_date ?? today, newest: end_date ?? future }
        );
        if (!events?.length) {
          return textResult({ events: [], count: 0 });
        }
        return textResult({ events, count: events.length });
      });
    }
  );

  server.registerTool(
    "get_event_by_id",
    {
      description: "Get detailed information for a specific planned event",
      inputSchema: {
        event_id: z.string().describe("The Intervals.icu event ID"),
      },
      outputSchema: {
        event: eventObjectSchema,
      },
    },
    async ({ event_id }) => {
      return withEventToolResult("fetching event", async () => {
        const event = await client.get<EventRecord>(
          `/athlete/${client.athleteId}/events/${event_id}`
        );
        return textResult({ event });
      });
    }
  );

  server.registerTool(
    "delete_event",
    {
      description: "Delete a single planned event. Permanent — confirm with athlete before calling.",
      inputSchema: {
        event_id: z.string().describe("The Intervals.icu event ID to delete"),
      },
      outputSchema: {
        event_id: z.string(),
        deleted: z.boolean(),
      },
    },
    async ({ event_id }) => {
      return withEventToolResult("deleting event", async () => {
        await client.delete(`/athlete/${client.athleteId}/events/${event_id}`);
        return textResult({ event_id, deleted: true });
      });
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
      outputSchema: {
        deleted_count: z.number().int(),
        failed_event_ids: z.array(z.string()),
        truncation_warning: z.string().nullable(),
      },
    },
    async ({ start_date, end_date }) => {
      return withEventToolResult("deleting events", async () => {
        const events = await client.get<EventRecord[]>(
          `/athlete/${client.athleteId}/events`,
          { oldest: start_date, newest: end_date }
        );
        if (!events?.length) {
          return textResult({
            deleted_count: 0,
            failed_event_ids: [],
            truncation_warning: null,
          });
        }

        const truncationBoundaries = [100, 200, 500, 1000];
        const truncationWarning = truncationBoundaries.includes(events.length)
          ? `Warning: exactly ${events.length} events returned — the API may have truncated results. Consider using a narrower date range.`
          : null;

        let deleted = 0;
        const failed: string[] = [];
        await Promise.all(events.map(async event => {
          try {
            await client.delete(`/athlete/${client.athleteId}/events/${event.id}`);
            deleted++;
          } catch {
            failed.push(String(event.id));
          }
        }));

        return textResult({
          deleted_count: deleted,
          failed_event_ids: failed,
          truncation_warning: truncationWarning,
        });
      });
    }
  );

  server.registerTool(
    "add_or_update_event",
    {
      description: "Create or update a planned workout event. Use description for workout steps — the server parses it into structured steps and computes training load. workout_doc is a server-generated field returned on reads; avoid sending it on writes.",
      inputSchema: {
        name: z.string().describe("Event name (e.g. 'Easy Run', 'Threshold Ride')"),
        type: z.string().optional().describe("Sport type, e.g. Run, Ride, VirtualRide, Swim, WeightTraining"),
        workout_type: z.string().optional().describe("Legacy alias for type. Preserved for backwards compatibility."),
        category: z.string().optional().describe("Event category, e.g. WORKOUT, RACE_A, RACE_B, RACE_C, NOTE. Defaults to WORKOUT."),
        start_date: z.string().optional().describe("Date YYYY-MM-DD (default: today)"),
        event_id: z.string().optional().describe("Provide to update an existing event"),
        moving_time: z.number().int().optional().describe("Expected duration in seconds"),
        distance: z.number().optional().describe("Expected distance in metres"),
        distance_target: z.number().optional().describe("Target distance in metres"),
        time_target: z.number().int().optional().describe("Target time in seconds"),
        load_target: z.number().optional().describe("Planned training load"),
        description: z.string().optional().describe(
          "Workout steps in intervals.icu text syntax — the server parses it into structured steps and computes training load (TSS, duration, intensity). " +
          "Use '- ' prefix for steps, plain lines for section headers. " +
          "Examples: '- 10km 89% LTHR', '- 30m Z2 HR', '- 8x\\n- 400m 5:00/km Pace\\n- 200m easy'. " +
          "Always use this field for defining workout content — do not use workout_doc on writes."
        ),
        target: targetMetricSchema.optional().describe("Primary target metric"),
        targets: z.array(targetMetricSchema).optional().describe("Multiple target metrics when needed"),
        indoor: z.boolean().optional().describe("Whether the session is indoors"),
        tags: z.array(z.string()).optional().describe("Event tags"),
        sub_type: z.string().optional().describe("Event subtype"),
        color: z.string().optional().describe("Calendar color"),
        carbs_per_hour: z.number().optional().describe("Planned carbohydrate intake in grams per hour"),
        hide_from_athlete: z.boolean().optional().describe("Hide event from athlete"),
        athlete_cannot_edit: z.boolean().optional().describe("Prevent athlete edits"),
        structure_read_only: z.boolean().optional().describe("Lock workout structure"),
        not_on_fitness_chart: z.boolean().optional().describe("Exclude event from fitness chart"),
        show_as_note: z.boolean().optional().describe("Show event as a note"),
        show_on_ctl_line: z.boolean().optional().describe("Display event on the CTL line"),
        for_week: z.boolean().optional().describe("Apply event to the whole training week"),
        training_availability: z.string().optional().describe("Availability hint, e.g. NORMAL, LIMITED, UNAVAILABLE"),
        max_training_time: z.number().int().optional().describe("Maximum available training time in seconds"),
        can_train_sports: z.array(z.string()).optional().describe("Sports the athlete can train on this day"),
        external_id: z.string().optional().describe("External identifier"),
        calendar_id: z.number().int().optional().describe("Target calendar ID"),
        workout_doc: z.object({
          description: z.string().optional(),
          steps: z.array(z.record(z.string(), z.unknown())).optional(),
        }).optional().describe(
          "Server-generated workout structure returned on reads. Sending this on writes is not recommended — " +
          "the step format is undocumented and the server does not compute training load from raw steps. Use description instead."
        ),
      },
      outputSchema: {
        action: z.enum(["created", "updated"]),
        event: eventObjectSchema,
      },
    },
    async ({
      name,
      type,
      workout_type,
      category,
      start_date,
      event_id,
      moving_time,
      distance,
      distance_target,
      time_target,
      load_target,
      description,
      target,
      targets,
      indoor,
      tags,
      sub_type,
      color,
      carbs_per_hour,
      hide_from_athlete,
      athlete_cannot_edit,
      structure_read_only,
      not_on_fitness_chart,
      show_as_note,
      show_on_ctl_line,
      for_week,
      training_availability,
      max_training_time,
      can_train_sports,
      external_id,
      calendar_id,
      workout_doc,
    }) => {
      return withEventToolResult("saving event", async () => {
        const resolvedType = type ?? workout_type;
        if (!resolvedType) {
          throw new Error("Either 'type' or legacy 'workout_type' is required.");
        }

        const date = start_date ?? new Date().toISOString().slice(0, 10);
        const eventData = stripUndefinedFields({
          start_date_local: `${date}T00:00:00`,
          category: category ?? "WORKOUT",
          name,
          type: resolvedType,
          moving_time,
          distance,
          distance_target,
          time_target,
          load_target,
          description,
          target,
          targets,
          indoor,
          tags,
          sub_type,
          color,
          carbs_per_hour,
          hide_from_athlete,
          athlete_cannot_edit,
          structure_read_only,
          not_on_fitness_chart,
          show_as_note,
          show_on_ctl_line,
          for_week,
          training_availability,
          max_training_time,
          can_train_sports,
          external_id,
          calendar_id,
          workout_doc,
        });

        if (event_id) {
          const event = await client.put<EventRecord>(
            `/athlete/${client.athleteId}/events/${event_id}`, eventData
          );
          return textResult({
            action: "updated",
            event,
          });
        }

        const event = await client.post<EventRecord>(
          `/athlete/${client.athleteId}/events`, eventData
        );
        return textResult({
          action: "created",
          event,
        });
      });
    }
  );
}
