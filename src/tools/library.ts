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
    updated_at: raw.updated_at,
    // workout_doc and attachments intentionally omitted
  };
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
}
