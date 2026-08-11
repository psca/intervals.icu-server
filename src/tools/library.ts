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
}
