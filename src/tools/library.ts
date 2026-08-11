import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { errorResult, textResult } from "./result.js";

// ---------------------------------------------------------------------------
// Internal types — only fields the MCP cares about; no full upstream schema
// ---------------------------------------------------------------------------

type RecordValue = Record<string, unknown>;
type ContainerType = "FOLDER" | "PLAN";
type ItemType = "ALL" | "WORKOUT" | ContainerType;

type CompactWorkout = {
  item_type: "WORKOUT";
  id: number;
  name: string;
  type: string | null;
  container_id: number | null;
  container_name: string | null;
  container_type: ContainerType | null;
  moving_time: number | null;
  training_load: number | null;
  intensity: number | null;
  indoor: boolean | null;
  targets: string[];
  tags: string[];
};

type CompactContainer = {
  item_type: ContainerType;
  id: number;
  name: string;
  description: string | null;
  workout_count: number | null;
};

// ---------------------------------------------------------------------------
// Projection helpers — no upstream fields are spread; each field is explicit
// ---------------------------------------------------------------------------

function ownContainers(folders: RecordValue[], athleteId: string): CompactContainer[] {
  return folders
    .filter((f) => !f.athlete_id || f.athlete_id === athleteId)
    .map((f) => ({
      item_type: (f.type as ContainerType) ?? "FOLDER",
      id: f.id as number,
      name: (f.name as string) ?? "",
      description: (f.description as string | null | undefined) ?? null,
      workout_count: (f.num_workouts as number | null | undefined) ?? null,
    }));
}

function compactWorkout(workout: RecordValue, containers: CompactContainer[]): CompactWorkout {
  const folderId = (workout.folder_id as number | null | undefined) ?? null;
  const container = folderId != null ? containers.find((c) => c.id === folderId) : undefined;
  const rawTargets = workout.targets as string[] | null | undefined;
  const rawTags = workout.tags as string[] | null | undefined;

  return {
    item_type: "WORKOUT",
    id: workout.id as number,
    name: (workout.name as string) ?? "",
    type: (workout.type as string | null | undefined) ?? null,
    container_id: folderId,
    container_name: container?.name ?? null,
    container_type: container?.item_type ?? null,
    moving_time: (workout.moving_time as number | null | undefined) ?? null,
    training_load: (workout.icu_training_load as number | null | undefined) ?? null,
    intensity: (workout.icu_intensity as number | null | undefined) ?? null,
    indoor: (workout.indoor as boolean | null | undefined) ?? null,
    targets: Array.isArray(rawTargets) ? rawTargets : [],
    tags: Array.isArray(rawTags) ? rawTags : [],
  };
}

/** Projection for a fully-retrieved workout — lists every supported field by name. */
function fullWorkout(raw: RecordValue): RecordValue {
  return {
    id: raw.id,
    folder_id: raw.folder_id,
    name: raw.name,
    description: raw.description,
    type: raw.type,
    indoor: raw.indoor,
    color: raw.color,
    moving_time: raw.moving_time,
    icu_training_load: raw.icu_training_load,
    icu_intensity: raw.icu_intensity,
    day: raw.day,
    time: raw.time,
    targets: raw.targets,
    tags: raw.tags,
    carbs_per_hour: raw.carbs_per_hour,
    sub_type: raw.sub_type,
    for_week: raw.for_week,
    distance: raw.distance,
    updated: raw.updated,
    // workout_doc and attachments intentionally omitted
  };
}

// ---------------------------------------------------------------------------
// Shared write helpers
// ---------------------------------------------------------------------------

/** Remove keys whose value is undefined so payload stays minimal. */
function stripUndefined(obj: RecordValue): RecordValue {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** Build the editable container payload from tool inputs. */
function containerPayload(input: RecordValue): RecordValue {
  return stripUndefined({
    type: input.type,
    name: input.name,
    description: input.description,
    visibility: input.visibility,
    start_date_local: input.start_date_local,
    rollout_weeks: input.rollout_weeks,
    auto_rollout_day: input.auto_rollout_day,
    read_only_workouts: input.read_only_workouts,
    starting_ctl: input.starting_ctl,
    starting_atl: input.starting_atl,
  });
}

/** Compact projection for a saved container — no server-owned or sharing metadata. */
function compactContainer(raw: RecordValue): RecordValue {
  return stripUndefined({
    item_type: raw.type,
    id: raw.id,
    name: raw.name,
    description: (raw.description as string | undefined) ?? null,
    workout_count: (raw.num_workouts as number | undefined) ?? null,
  });
}

/** Fields that are only valid on a PLAN container. */
const PLAN_ONLY_FIELDS: (keyof RecordValue)[] = [
  "rollout_weeks",
  "auto_rollout_day",
  "read_only_workouts",
  "starting_ctl",
  "starting_atl",
];

/**
 * Fetch the athlete's folder list and resolve a single container by ID.
 * Throws if not found.
 */
async function findContainer(client: IntervalsClient, containerId: number): Promise<RecordValue> {
  const folders = await client.get<RecordValue[]>(`/athlete/${client.athleteId}/folders`);
  const found = (folders ?? []).find((f) => f.id === containerId);
  if (!found) throw new Error(`Container ${containerId} not found.`);
  return found;
}

/** Allowlisted fields accepted on any workout write. */
const WORKOUT_WRITE_FIELDS = [
  "folder_id", "name", "description", "type", "indoor", "color", "day",
  "hide_from_athlete", "target", "targets", "carbs_per_hour", "tags", "time",
  "sub_type", "for_week", "distance",
] as const;

/**
 * Build a workout write payload from a source record plus optional caller overrides.
 * Only fields in WORKOUT_WRITE_FIELDS are included — workout_doc and calculated
 * fields (icu_training_load, icu_intensity, etc.) are structurally excluded.
 */
function workoutWritePayload(source: RecordValue, overrides: RecordValue = {}): RecordValue {
  const result: RecordValue = {};
  for (const field of WORKOUT_WRITE_FIELDS) {
    const value = overrides[field] !== undefined ? overrides[field] : source[field];
    if (value !== undefined) result[field] = value;
  }
  return result;
}

/**
 * Apply destination-type rules to the payload:
 * - PLAN requires a non-negative integer day.
 * - FOLDER rejects a supplied day and strips any day that crept in from source.
 */
function applyDestination(
  payload: RecordValue,
  containerType: ContainerType,
  suppliedDay: number | undefined,
): RecordValue {
  if (containerType === "PLAN") {
    if (suppliedDay === undefined || !Number.isInteger(suppliedDay) || suppliedDay < 0) {
      throw new Error("day (non-negative integer) is required for a PLAN destination.");
    }
    return { ...payload, day: suppliedDay };
  }
  // FOLDER: reject supplied day, strip from payload
  if (suppliedDay !== undefined) {
    throw new Error("day is not valid for a FOLDER destination.");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { day: _day, ...rest } = payload;
  return rest;
}

/** Compact saved-workout response — omits calculated and server-owned fields. */
function compactSavedWorkout(raw: RecordValue): RecordValue {
  return stripUndefined({
    id: raw.id,
    folder_id: raw.folder_id,
    name: raw.name,
    type: raw.type,
    day: raw.day,
    moving_time: raw.moving_time,
    icu_training_load: raw.icu_training_load,
    icu_intensity: raw.icu_intensity,
    targets: raw.targets,
    tags: raw.tags,
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerLibraryTools(server: McpServer, client: IntervalsClient): void {
  // ---- search_workout_library ------------------------------------------------
  server.registerTool(
    "search_workout_library",
    {
      description:
        "Search and list the athlete's private workout library. Returns compact results " +
        "without full descriptions, workout_doc, or attachments. " +
        "Supports filtering by name query, item type (ALL, WORKOUT, FOLDER, PLAN), " +
        "sport, container ID, and result limit (default 50, max 100).",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring match against item names"),
        item_type: z
          .enum(["ALL", "WORKOUT", "FOLDER", "PLAN"])
          .optional()
          .describe("Filter by item type (default: ALL)"),
        sport: z.string().optional().describe("Filter workouts by sport type, e.g. Ride, Run, Swim"),
        container_id: z
          .number()
          .int()
          .optional()
          .describe("Return only items belonging to this folder or plan ID"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum results to return (default 50, max 100)"),
      },
      outputSchema: {
        items: z.array(z.record(z.string(), z.unknown())),
        total: z.number().int(),
      },
    },
    async ({ query, item_type = "ALL", sport, container_id, limit = 50 }) => {
      try {
        const effectiveLimit = Math.min(limit, 100);
        const lowQuery = query?.toLowerCase();

        // Fetch folders and workouts concurrently
        const [foldersRaw, workoutsRaw] = await Promise.all([
          client.get<RecordValue[]>(`/athlete/${client.athleteId}/folders`),
          client.get<RecordValue[]>(`/athlete/${client.athleteId}/workouts`),
        ]);

        // Build owned container list
        const containers = ownContainers(foldersRaw ?? [], client.athleteId);

        const items: (CompactContainer | CompactWorkout)[] = [];

        // Include containers when type is ALL, FOLDER, or PLAN
        if (item_type === "ALL" || item_type === "FOLDER" || item_type === "PLAN") {
          for (const c of containers) {
            if (item_type !== "ALL" && c.item_type !== item_type) continue;
            if (lowQuery && !c.name.toLowerCase().includes(lowQuery)) continue;
            if (container_id != null && c.id !== container_id) continue;
            items.push(c);
          }
        }

        // Include workouts when type is ALL or WORKOUT
        if (item_type === "ALL" || item_type === "WORKOUT") {
          for (const w of workoutsRaw ?? []) {
            // Ownership check
            if (w.athlete_id && w.athlete_id !== client.athleteId) continue;
            if (sport && w.type !== sport) continue;
            if (lowQuery && !(w.name as string)?.toLowerCase().includes(lowQuery)) continue;
            if (container_id != null && w.folder_id !== container_id) continue;
            items.push(compactWorkout(w, containers));
          }
        }

        const sliced = items.slice(0, effectiveLimit);
        return textResult({ items: sliced, total: sliced.length });
      } catch (error) {
        return errorResult("searching workout library", error);
      }
    }
  );

  // ---- get_library_workout ---------------------------------------------------
  server.registerTool(
    "get_library_workout",
    {
      description:
        "Retrieve one complete saved library workout including description. " +
        "Raw workout_doc and attachments are omitted; use description for workout content.",
      inputSchema: {
        workout_id: z.number().int().describe("Library workout ID to retrieve"),
      },
      outputSchema: {
        workout: z.record(z.string(), z.unknown()),
      },
    },
    async ({ workout_id }) => {
      try {
        const raw = await client.get<RecordValue>(
          `/athlete/${client.athleteId}/workouts/${workout_id}`
        );
        return textResult({ workout: fullWorkout(raw) });
      } catch (error) {
        return errorResult("retrieving library workout", error);
      }
    }
  );

  // ---- save_library_container ------------------------------------------------
  server.registerTool(
    "save_library_container",
    {
      description:
        "Create or update a library folder or plan. " +
        "Use action=CREATE to create a new container or action=UPDATE to modify an existing one. " +
        "Folders hold stable reusable workouts; plans hold workouts with zero-based day offsets for progressive blocks. " +
        "Plan-only fields (rollout_weeks, auto_rollout_day, read_only_workouts, starting_ctl, starting_atl) " +
        "are rejected for FOLDER containers.",
      inputSchema: {
        action: z.enum(["CREATE", "UPDATE"]).describe("CREATE to create a new container, UPDATE to modify an existing one"),
        container_id: z.number().int().optional().describe("Required for UPDATE: the container ID to modify"),
        type: z.enum(["FOLDER", "PLAN"]).optional().describe("Container type — required for CREATE; must match stored type for UPDATE"),
        name: z.string().optional().describe("Container name"),
        description: z.string().optional().describe("Container description"),
        visibility: z.string().optional().describe("Visibility setting"),
        start_date_local: z.string().optional().describe("Plan start date YYYY-MM-DD"),
        rollout_weeks: z.number().int().optional().describe("PLAN only: number of weeks to roll out"),
        auto_rollout_day: z.number().int().optional().describe("PLAN only: day of week for automatic rollout"),
        read_only_workouts: z.boolean().optional().describe("PLAN only: prevent athlete edits on plan workouts"),
        starting_ctl: z.number().optional().describe("PLAN only: athlete starting CTL for plan fitness estimates"),
        starting_atl: z.number().optional().describe("PLAN only: athlete starting ATL for plan fitness estimates"),
      },
      outputSchema: {
        action: z.enum(["created", "updated"]),
        container: z.record(z.string(), z.unknown()),
      },
    },
    async (input) => {
      try {
        const { action, container_id, type } = input as RecordValue & { action: "CREATE" | "UPDATE"; container_id?: number; type?: ContainerType };

        // Validate plan-only fields are not supplied for FOLDER
        if (type === "FOLDER") {
          const planOnlySupplied = PLAN_ONLY_FIELDS.filter((f) => (input as RecordValue)[f] !== undefined);
          if (planOnlySupplied.length > 0) {
            throw new Error(
              `Fields ${planOnlySupplied.join(", ")} are only valid for PLAN containers, not FOLDER.`
            );
          }
        }

        if (action === "CREATE" && !type) {
          throw new Error("type is required for CREATE.");
        }

        if (action === "CREATE") {
          const payload = containerPayload(input as RecordValue);
          const saved = await client.post<RecordValue>(
            `/athlete/${client.athleteId}/folders`,
            payload
          );
          return textResult({ action: "created", container: compactContainer(saved) });
        }

        // UPDATE
        if (container_id == null) {
          throw new Error("container_id is required for UPDATE.");
        }

        // Resolve the current container
        const current = await findContainer(client, container_id);
        const storedType = current.type as ContainerType;

        // Validate type match if the caller supplied one
        if (type && type !== storedType) {
          throw new Error(
            `Type mismatch: container ${container_id} is a ${storedType}, not ${type}.`
          );
        }

        // Validate plan-only fields against the *stored* type when type was omitted
        if (storedType === "FOLDER") {
          const planOnlySupplied = PLAN_ONLY_FIELDS.filter((f) => (input as RecordValue)[f] !== undefined);
          if (planOnlySupplied.length > 0) {
            throw new Error(
              `Fields ${planOnlySupplied.join(", ")} are only valid for PLAN containers, not FOLDER.`
            );
          }
        }

        // Build payload from supplied inputs; always include stored type
        const payload = stripUndefined({
          ...containerPayload(input as RecordValue),
          type: storedType,  // preserve stored type upstream always expects it on PUT
        });

        const saved = await client.put<RecordValue>(
          `/athlete/${client.athleteId}/folders/${container_id}`,
          payload
        );
        return textResult({ action: "updated", container: compactContainer(saved) });
      } catch (error) {
        return errorResult("saving library container", error);
      }
    }
  );

  // ---- save_library_workout --------------------------------------------------
  server.registerTool(
    "save_library_workout",
    {
      description:
        "Create or update a library workout using one of three sources:\n" +
        "- NEW: create from supplied fields (requires container_id, name, type, description).\n" +
        "- UPDATE: modify an existing library workout (requires workout_id); omitted fields " +
        "are preserved from the current workout.\n" +
        "- EVENT: copy a calendar event into the library (requires event_id and container_id; " +
        "event category must be WORKOUT).\n" +
        "PLAN destinations require a non-negative integer day. " +
        "FOLDER destinations reject a supplied day. " +
        "workout_doc is never accepted; use description for workout steps.",
      inputSchema: {
        source: z.enum(["NEW", "UPDATE", "EVENT"]).describe(
          "NEW to create from scratch, UPDATE to modify an existing workout, EVENT to copy from a calendar event"
        ),
        container_id: z.number().int().optional().describe(
          "Destination folder or plan ID — required for NEW and EVENT"
        ),
        workout_id: z.number().int().optional().describe("Required for UPDATE: the library workout ID to modify"),
        event_id: z.number().int().optional().describe("Required for EVENT: the calendar event ID to copy"),
        name: z.string().optional().describe("Workout name"),
        description: z.string().optional().describe(
          "Workout steps in intervals.icu text syntax — required for NEW; optional override for UPDATE and EVENT"
        ),
        type: z.string().optional().describe("Sport type, e.g. Ride, Run, Swim — required for NEW"),
        indoor: z.boolean().optional().describe("Whether the session is indoors"),
        color: z.string().optional().describe("Calendar colour"),
        day: z.number().int().min(0).optional().describe(
          "Zero-based day offset within the plan — required when destination is a PLAN, rejected for FOLDER"
        ),
        hide_from_athlete: z.boolean().optional().describe("Hide workout from athlete"),
        target: z.string().optional().describe("Primary target metric"),
        targets: z.array(z.string()).optional().describe("Target metrics"),
        carbs_per_hour: z.number().optional().describe("Planned carbohydrate intake in g/h"),
        tags: z.array(z.string()).optional().describe("Tags"),
        time: z.string().optional().describe("Saved start time HH:mm or HH:mm:ss"),
        sub_type: z.string().optional().describe("Workout subtype"),
        for_week: z.boolean().optional().describe("Apply to whole training week"),
        distance: z.number().optional().describe("Expected distance in metres"),
      },
      outputSchema: {
        action: z.enum(["created", "updated"]),
        workout: z.record(z.string(), z.unknown()),
      },
    },
    async (input) => {
      try {
        const rv = input as RecordValue;
        const source = rv.source as "NEW" | "UPDATE" | "EVENT";
        const container_id = rv.container_id as number | undefined;
        const workout_id = rv.workout_id as number | undefined;
        const event_id = rv.event_id as number | undefined;
        const day = rv.day as number | undefined;
        const name = rv.name as string | undefined;
        const type = rv.type as string | undefined;
        const description = rv.description as string | undefined;

        // ---- NEW -------------------------------------------------------------
        if (source === "NEW") {
          if (container_id == null) throw new Error("container_id is required for NEW.");
          if (!name) throw new Error("name is required for NEW.");
          if (!type) throw new Error("type is required for NEW.");
          if (!description) throw new Error("description is required for NEW.");

          const container = await findContainer(client, container_id);
          const containerType = container.type as ContainerType;

          const base = workoutWritePayload({ ...rv, folder_id: container_id });
          const payload = applyDestination(base, containerType, day);

          const saved = await client.post<RecordValue>(
            `/athlete/${client.athleteId}/workouts`, payload
          );
          return textResult({ action: "created", workout: compactSavedWorkout(saved) });
        }

        // ---- UPDATE ----------------------------------------------------------
        if (source === "UPDATE") {
          if (workout_id == null) throw new Error("workout_id is required for UPDATE.");
          if (container_id != null) throw new Error(
            "container_id is not supported for UPDATE; moving a workout between containers is not supported by this operation."
          );

          const current = await client.get<RecordValue>(
            `/athlete/${client.athleteId}/workouts/${workout_id}`
          );

          const currentFolderId = current.folder_id as number | undefined;
          if (currentFolderId == null) throw new Error(`Workout ${workout_id} has no folder_id.`);

          const container = await findContainer(client, currentFolderId);
          const containerType = container.type as ContainerType;

          // Merge: current fields as base, caller overrides on top
          const merged = workoutWritePayload(current, rv);

          // Resolve effective day:
          // - PLAN: prefer supplied day, fall back to stored day
          // - FOLDER: pass supplied day (applyDestination rejects it if non-nil)
          const effectiveDay =
            containerType === "PLAN"
              ? (day !== undefined ? day : (current.day as number | undefined))
              : day;

          const payload = applyDestination(merged, containerType, effectiveDay);

          const saved = await client.put<RecordValue>(
            `/athlete/${client.athleteId}/workouts/${workout_id}`, payload
          );
          return textResult({ action: "updated", workout: compactSavedWorkout(saved) });
        }

        // ---- EVENT -----------------------------------------------------------
        if (source === "EVENT") {
          if (event_id == null) throw new Error("event_id is required for EVENT.");
          if (container_id == null) throw new Error("container_id is required for EVENT.");

          const event = await client.get<RecordValue>(
            `/athlete/${client.athleteId}/events/${event_id}`
          );
          if (event.category !== "WORKOUT") {
            throw new Error(
              `Event ${event_id} has category "${String(event.category)}", not "WORKOUT". Only WORKOUT events can be copied to the library.`
            );
          }

          const container = await findContainer(client, container_id);
          const containerType = container.type as ContainerType;

          // Event fields are the source; caller overrides (name, day, etc.) take precedence
          const base = workoutWritePayload({ ...event, folder_id: container_id }, rv);
          const payload = applyDestination(base, containerType, day);

          const saved = await client.post<RecordValue>(
            `/athlete/${client.athleteId}/workouts`, payload
          );
          return textResult({ action: "created", workout: compactSavedWorkout(saved) });
        }

        throw new Error(`Unknown source: ${String(source)}`);
      } catch (error) {
        return errorResult("saving library workout", error);
      }
    }
  );

  // ---- delete_library_item --------------------------------------------------
  server.registerTool(
    "delete_library_item",
    {
      description:
        "Delete a workout, folder, or plan from the athlete's private library. " +
        "Permanent — deleting a folder or plan also deletes all contained workouts. " +
        "Requires confirm=true to execute.",
      annotations: {
        destructiveHint: true,
      },
      inputSchema: {
        item_type: z.enum(["WORKOUT", "FOLDER", "PLAN"]).describe("Type of item to delete"),
        item_id: z.number().int().describe("ID of the item to delete"),
        confirm: z.boolean().describe("Must be explicitly true to confirm deletion"),
      },
      outputSchema: {
        item_id: z.number().int(),
        item_type: z.enum(["WORKOUT", "FOLDER", "PLAN"]),
        deleted: z.boolean(),
        deleted_ids: z.array(z.number().int()).optional(),
        upstream: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ item_type, item_id, confirm }) => {
      try {
        if (!confirm) {
          throw new Error("confirm must be true to delete a library item.");
        }

        if (item_type === "WORKOUT") {
          await client.get(`/athlete/${client.athleteId}/workouts/${item_id}`);
          const deletedIds = await client.delete<number[]>(
            `/athlete/${client.athleteId}/workouts/${item_id}`,
            { others: "false" }
          );
          return textResult({
            item_id,
            item_type,
            deleted: true,
            deleted_ids: deletedIds,
          });
        }

        const container = await findContainer(client, item_id);
        if (container.type !== item_type) {
          throw new Error(`Item ${item_id} is a ${container.type}, not ${item_type}.`);
        }
        const upstream = await client.delete<RecordValue>(
          `/athlete/${client.athleteId}/folders/${item_id}`
        );
        return textResult({
          item_id,
          item_type,
          deleted: true,
          upstream,
        });
      } catch (error) {
        return errorResult("deleting library item", error);
      }
    }
  );
}
