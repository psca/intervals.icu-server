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
    }));
    expect(result.structuredContent.workout).not.toHaveProperty("workout_doc");
    expect(result.structuredContent.workout).not.toHaveProperty("attachments");
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
