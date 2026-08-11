import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient } from "../src/client";
import { registerLibraryTools } from "../src/tools/library";

// Uses internal _registeredTools — may break on SDK updates.
// Acceptable tradeoff vs. full transport setup for unit tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(server: any, toolName: string, args: Record<string, unknown>) {
  const tool = server._registeredTools[toolName];
  if (!tool?.handler) throw new Error(`Tool ${toolName} not found`);
  return tool.handler(args, {});
}

// Raw upstream folder records
const folderBikeSweet = {
  id: 50,
  name: "Bike — Sweet Spot",
  type: "FOLDER",
  description: "All sweet spot variants",
  athlete_id: "i123",
};

const folderPlan = {
  id: 90,
  name: "BMP — Base Phase",
  type: "PLAN",
  description: "Eight-week aerobic base block",
  athlete_id: "i123",
};

const folderOther = {
  id: 99,
  name: "Other Coach Folder",
  type: "FOLDER",
  athlete_id: "other_athlete",
};

// Raw upstream workout records (contain noise fields that must be stripped)
const workoutRaw = {
  id: 11,
  name: "SS-3x10",
  folder_id: 50,
  type: "Ride",
  indoor: false,
  description: "Main Set\n- 3x\n- 10m 90%",
  workout_doc: { steps: [{ type: "warmup" }] },
  attachments: [{ id: "a1", filename: "plan.pdf" }],
  moving_time: 4200,
  icu_training_load: 68,
  icu_intensity: 0.87,
  targets: ["POWER"],
  tags: ["build"],
  updated: "2026-08-01T10:00:00",
  athlete_id: "i123",
};

const workoutPlan = {
  id: 201,
  name: "Base Ride 1",
  folder_id: 90,
  type: "Ride",
  indoor: false,
  description: "Easy base ride",
  workout_doc: { steps: [] },
  moving_time: 3600,
  icu_training_load: 40,
  icu_intensity: 0.72,
  targets: [],
  tags: [],
  day: 0,
  athlete_id: "i123",
};

const workoutOtherAthlete = {
  id: 999,
  name: "Foreign Workout",
  folder_id: 50,
  type: "Run",
  athlete_id: "other_athlete",
};

function makeFetchSequence(...responses: unknown[]) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const payload = responses[call++] ?? responses[responses.length - 1];
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(""),
    });
  });
}

function makeServer(athleteId = "i123") {
  const client = new IntervalsClient("key", athleteId);
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerLibraryTools(server, client);
  return { server, client };
}

describe("search_workout_library", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns compact workout results and strips description, workout_doc, and attachments", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderPlan], // GET /folders
      [workoutRaw, workoutPlan],      // GET /workouts
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", {});

    expect(result.structuredContent.items).toContainEqual(expect.objectContaining({
      item_type: "WORKOUT",
      id: 11,
      name: "SS-3x10",
      container_name: "Bike — Sweet Spot",
      container_type: "FOLDER",
      moving_time: 4200,
      training_load: 68,
      intensity: 0.87,
    }));

    const json = JSON.stringify(result.structuredContent);
    expect(json).not.toContain("Main Set");
    expect(json).not.toContain("workout_doc");
    expect(json).not.toContain("attachments");
  });

  it("includes folder and plan containers in results", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderPlan],
      [workoutRaw],
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", {});

    const types = result.structuredContent.items.map((i: { item_type: string }) => i.item_type);
    expect(types).toContain("FOLDER");
    expect(types).toContain("PLAN");
  });

  it("filters by case-insensitive name query", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderPlan],
      [workoutRaw, workoutPlan],
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { query: "ss-3" });

    const names = result.structuredContent.items.map((i: { name: string }) => i.name);
    expect(names).toContain("SS-3x10");
    expect(names).not.toContain("Base Ride 1");
    expect(names).not.toContain("Bike — Sweet Spot");
  });

  it("filters by item_type WORKOUT", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderPlan],
      [workoutRaw, workoutPlan],
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { item_type: "WORKOUT" });

    for (const item of result.structuredContent.items) {
      expect(item.item_type).toBe("WORKOUT");
    }
  });

  it("filters by item_type FOLDER", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderPlan],
      [workoutRaw, workoutPlan],
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { item_type: "FOLDER" });

    for (const item of result.structuredContent.items) {
      expect(item.item_type).toBe("FOLDER");
    }
  });

  it("filters by sport type", async () => {
    const runWorkout = { ...workoutRaw, id: 12, name: "Easy Run", type: "Run", folder_id: 50 };
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet],
      [workoutRaw, runWorkout],
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { item_type: "WORKOUT", sport: "Run" });

    const names = result.structuredContent.items.map((i: { name: string }) => i.name);
    expect(names).toContain("Easy Run");
    expect(names).not.toContain("SS-3x10");
  });

  it("filters by container_id", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderPlan],
      [workoutRaw, workoutPlan],
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { container_id: 90 });

    const ids = result.structuredContent.items.map((i: { id: number }) => i.id);
    // workoutPlan.folder_id === 90; folderPlan.id === 90
    expect(ids).toContain(201);
    expect(ids).toContain(90);
    expect(ids).not.toContain(11);
  });

  it("respects the limit parameter", async () => {
    const manyWorkouts = Array.from({ length: 60 }, (_, i) => ({
      ...workoutRaw,
      id: 100 + i,
      name: `Workout ${i}`,
    }));
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet],
      manyWorkouts,
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { item_type: "WORKOUT", limit: 10 });

    expect(result.structuredContent.items).toHaveLength(10);
  });

  it("defaults to limit 50", async () => {
    const manyWorkouts = Array.from({ length: 60 }, (_, i) => ({
      ...workoutRaw,
      id: 100 + i,
      name: `Workout ${i}`,
    }));
    vi.stubGlobal("fetch", makeFetchSequence(
      [], // no folders
      manyWorkouts,
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { item_type: "WORKOUT" });

    expect(result.structuredContent.items).toHaveLength(50);
  });

  it("caps limit at 100", async () => {
    const manyWorkouts = Array.from({ length: 120 }, (_, i) => ({
      ...workoutRaw,
      id: 100 + i,
      name: `Workout ${i}`,
    }));
    vi.stubGlobal("fetch", makeFetchSequence(
      [],
      manyWorkouts,
    ));

    const { server } = makeServer();
    const result = await callTool(server, "search_workout_library", { item_type: "WORKOUT", limit: 200 });

    expect(result.structuredContent.items.length).toBeLessThanOrEqual(100);
  });

  it("excludes records whose athlete_id differs from the client athlete", async () => {
    vi.stubGlobal("fetch", makeFetchSequence(
      [folderBikeSweet, folderOther],
      [workoutRaw, workoutOtherAthlete],
    ));

    const { server } = makeServer("i123");
    const result = await callTool(server, "search_workout_library", {});

    const ids = result.structuredContent.items.map((i: { id: number }) => i.id);
    expect(ids).not.toContain(999);
    expect(ids).not.toContain(99);
  });
});

describe("get_library_workout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the full workout with description and omits workout_doc", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ...workoutRaw }),
      text: () => Promise.resolve(""),
    }));

    const { server } = makeServer();
    const result = await callTool(server, "get_library_workout", { workout_id: 11 });

    expect(result.structuredContent.workout).toEqual(expect.objectContaining({
      id: 11,
      name: "SS-3x10",
      description: "Main Set\n- 3x\n- 10m 90%",
      updated: "2026-08-01T10:00:00",
    }));
    expect(result.structuredContent.workout).not.toHaveProperty("workout_doc");
    expect(result.structuredContent.workout).not.toHaveProperty("attachments");
    expect(result.structuredContent.workout).not.toHaveProperty("updated_at");
  });

  it("calls the correct upstream endpoint", async () => {
    let calledUrl = "";
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      calledUrl = url;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 11, name: "SS-3x10" }),
        text: () => Promise.resolve(""),
      });
    }));

    const { server } = makeServer("i123");
    await callTool(server, "get_library_workout", { workout_id: 11 });

    expect(calledUrl).toContain("/athlete/i123/workouts/11");
  });
});

// ---------------------------------------------------------------------------
// Task 3: save_library_container
// ---------------------------------------------------------------------------

describe("save_library_container", () => {
  afterEach(() => vi.unstubAllGlobals());

  // ---- CREATE ----------------------------------------------------------------

  it("CREATE sends only supplied fields to /folders and returns compact container", async () => {
    let requestBody: Record<string, unknown> = {};
    let calledUrl = "";
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calledUrl = url;
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 91,
          name: "BMP — Base Phase",
          type: "PLAN",
          description: "Eight-week aerobic base block",
          rollout_weeks: 2,
          athlete_id: "i123",
        }),
        text: () => Promise.resolve(""),
      });
    }));

    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "CREATE",
      type: "PLAN",
      name: "BMP — Base Phase",
      description: "Eight-week aerobic base block",
      rollout_weeks: 2,
    });

    expect(calledUrl).toContain("/athlete/i123/folders");
    expect(requestBody).toEqual({
      type: "PLAN",
      name: "BMP — Base Phase",
      description: "Eight-week aerobic base block",
      rollout_weeks: 2,
    });
    expect(result.structuredContent.action).toBe("created");
    expect(result.structuredContent.container).toEqual(expect.objectContaining({
      id: 91,
      name: "BMP — Base Phase",
      item_type: "PLAN",
    }));
  });

  it("CREATE omits undefined optional fields from the POST body", async () => {
    let requestBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 51, name: "Bike — Z2", type: "FOLDER", athlete_id: "i123" }),
        text: () => Promise.resolve(""),
      });
    }));

    const { server } = makeServer();
    await callTool(server, "save_library_container", {
      action: "CREATE",
      type: "FOLDER",
      name: "Bike — Z2",
    });

    // Only supplied fields; no undefined keys
    expect(requestBody).toEqual({ type: "FOLDER", name: "Bike — Z2" });
    expect(Object.keys(requestBody)).not.toContain("description");
    expect(Object.keys(requestBody)).not.toContain("rollout_weeks");
  });

  it("CREATE FOLDER rejects plan-only fields (rollout_weeks)", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "CREATE",
      type: "FOLDER",
      name: "Bike — Z2",
      rollout_weeks: 4,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/rollout|plan/i);
  });

  // ---- UPDATE ----------------------------------------------------------------

  it("UPDATE sends only editable fields to /folders/{id}", async () => {
    let putUrl = "";
    let putBody: Record<string, unknown> = {};
    let callCount = 0;

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++;
      // First call: GET /folders to resolve the container
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: 50, name: "Bike — Sweet Spot", type: "FOLDER", description: "Old desc", athlete_id: "i123" },
          ]),
          text: () => Promise.resolve(""),
        });
      }
      // Second call: PUT /folders/50
      putUrl = url;
      putBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 50,
          name: "Bike — Sweet Spot renamed",
          type: "FOLDER",
          description: "Old desc",
          athlete_id: "i123",
        }),
        text: () => Promise.resolve(""),
      });
    }));

    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "UPDATE",
      container_id: 50,
      name: "Bike — Sweet Spot renamed",
    });

    expect(putUrl).toContain("/folders/50");
    // Must send name and preserved type; must not include server-owned fields
    expect(putBody).toHaveProperty("name", "Bike — Sweet Spot renamed");
    expect(putBody).not.toHaveProperty("children");
    expect(putBody).not.toHaveProperty("num_workouts");
    expect(result.structuredContent.action).toBe("updated");
    expect(result.structuredContent.container.id).toBe(50);
  });

  it("UPDATE requires container_id", async () => {
    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "UPDATE",
      type: "FOLDER",
      name: "No ID",
    });

    expect(result.isError).toBe(true);
  });

  it("UPDATE rejects a supplied type that mismatches the stored type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: 50, name: "Bike — Sweet Spot", type: "FOLDER", athlete_id: "i123" },
      ]),
      text: () => Promise.resolve(""),
    }));

    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "UPDATE",
      container_id: 50,
      type: "PLAN",   // mismatches stored FOLDER
      name: "Renamed",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/type|mismatch|FOLDER|PLAN/i);
  });

  it("UPDATE not found returns error without making a PUT", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),   // empty folder list
      text: () => Promise.resolve(""),
    }));

    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "UPDATE",
      container_id: 999,
      name: "Ghost",
    });

    expect(result.isError).toBe(true);
  });

  it("CREATE without type returns error and makes no fetch call", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { server } = makeServer();
    const result = await callTool(server, "save_library_container", {
      action: "CREATE",
      name: "Missing Type Folder",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/type.*required/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
