import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient } from "../src/client";
import { registerLibraryTools, addDays, resolveWorkoutTime, eventFromWorkout } from "../src/tools/library";

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

// ---------------------------------------------------------------------------
// Task 4: save_library_workout
// ---------------------------------------------------------------------------

describe("save_library_workout", () => {
  afterEach(() => vi.unstubAllGlobals());

  // ---- NEW ------------------------------------------------------------------

  describe("NEW", () => {
    it("creates a folder workout and posts only WORKOUT_WRITE_FIELDS", async () => {
      let postUrl = "";
      let postBody: Record<string, unknown> = {};
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          // findContainer → GET /folders
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderBikeSweet]), text: () => Promise.resolve("") });
        }
        postUrl = url;
        postBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 12, name: "SS-3x10", folder_id: 50, type: "Ride", icu_training_load: 68 }),
          text: () => Promise.resolve(""),
        });
      }));

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "NEW",
        container_id: 50,
        name: "SS-3x10",
        type: "Ride",
        description: "Warmup\n- 10m Z2",
        targets: ["POWER"],
      });

      expect(postUrl).toContain("/athlete/i123/workouts");
      expect(postBody).toEqual(expect.objectContaining({
        folder_id: 50,
        name: "SS-3x10",
        type: "Ride",
        description: "Warmup\n- 10m Z2",
        targets: ["POWER"],
      }));
      expect(postBody).not.toHaveProperty("workout_doc");
      expect(postBody).not.toHaveProperty("icu_training_load");
      expect(postBody).not.toHaveProperty("source");
      expect(postBody).not.toHaveProperty("container_id");
      expect(result.structuredContent.action).toBe("created");
    });

    it("creates a plan workout with a required day", async () => {
      let postBody: Record<string, unknown> = {};
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        }
        postBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 202, name: "Base Ride", folder_id: 90, type: "Ride", day: 7 }),
          text: () => Promise.resolve(""),
        });
      }));

      const { server } = makeServer();
      await callTool(server, "save_library_workout", {
        source: "NEW",
        container_id: 90,
        name: "Base Ride",
        type: "Ride",
        description: "Easy aerobic",
        day: 7,
      });

      expect(postBody).toHaveProperty("day", 7);
      expect(postBody).toHaveProperty("folder_id", 90);
    });

    it("rejects PLAN destination without day; only findContainer is called", async () => {
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "NEW",
        container_id: 90,
        name: "Base Ride",
        type: "Ride",
        description: "Easy aerobic",
        // day omitted
      });

      expect(result.isError).toBe(true);
      expect(callCount).toBe(1); // findContainer only; no POST
    });

    it("rejects FOLDER destination with supplied day; only findContainer is called", async () => {
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve([folderBikeSweet]), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "NEW",
        container_id: 50,
        name: "SS-3x10",
        type: "Ride",
        description: "Warmup\n- 10m Z2",
        day: 0, // invalid for FOLDER
      });

      expect(result.isError).toBe(true);
      expect(callCount).toBe(1); // findContainer only; no POST
    });

    it("requires name, type, and description; makes no fetch when missing", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "NEW",
        container_id: 50,
        // name, type, description all omitted
      });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ---- UPDATE ---------------------------------------------------------------

  describe("UPDATE", () => {
    /** Helper: 3-call mock for a FOLDER workout UPDATE.
     *  Call 1 → GET /workouts/{id}, Call 2 → GET /folders, Call 3 → PUT */
    function mockFolderUpdate(
      currentWorkout: Record<string, unknown>,
      captureBody: (url: string, body: Record<string, unknown>) => void,
      savedWorkout: Record<string, unknown>,
    ) {
      let callCount = 0;
      return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(currentWorkout), text: () => Promise.resolve("") });
        }
        if (callCount === 2) {
          // findContainer → GET /folders
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderBikeSweet]), text: () => Promise.resolve("") });
        }
        captureBody(url, JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(savedWorkout), text: () => Promise.resolve("") });
      });
    }

    it("merges current fields with supplied overrides and omits calculated fields", async () => {
      let putUrl = "";
      let putBody: Record<string, unknown> = {};
      vi.stubGlobal("fetch", mockFolderUpdate(
        { ...workoutRaw },
        (url, body) => { putUrl = url; putBody = body; },
        { ...workoutRaw, name: "SS-3x10 revised" },
      ));

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "UPDATE",
        workout_id: 11,
        name: "SS-3x10 revised",
      });

      expect(putUrl).toContain("/athlete/i123/workouts/11");
      expect(putBody).toEqual(expect.objectContaining({
        folder_id: 50,
        name: "SS-3x10 revised",
        description: "Main Set\n- 3x\n- 10m 90%",
        type: "Ride",
        targets: ["POWER"],
      }));
      expect(putBody).not.toHaveProperty("workout_doc");
      expect(putBody).not.toHaveProperty("icu_training_load");
      expect(putBody).not.toHaveProperty("source");
      expect(putBody).not.toHaveProperty("workout_id");
      expect(putBody).not.toHaveProperty("day"); // FOLDER: day stripped
      expect(result.structuredContent.action).toBe("updated");
    });

    it("requires workout_id and makes no fetch when missing", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "UPDATE",
        name: "No ID",
      });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects container_id and makes no fetch", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "UPDATE",
        workout_id: 11,
        container_id: 90, // not supported
        name: "Move attempt",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/container_id/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("UPDATE of a FOLDER workout with supplied day returns isError and makes no PUT", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutRaw }), text: () => Promise.resolve("") });
        // findContainer
        return Promise.resolve({ ok: true, json: () => Promise.resolve([folderBikeSweet]), text: () => Promise.resolve("") });
      });
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "UPDATE",
        workout_id: 11,
        day: 0, // invalid for FOLDER
      });

      expect(result.isError).toBe(true);
      expect(callCount).toBe(2); // GET workout + findContainer; no PUT
    });

    it("UPDATE of a PLAN workout without supplied day preserves the existing day", async () => {
      // workoutPlan has folder_id:90 (PLAN) and day:0
      let putBody: Record<string, unknown> = {};
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutPlan }), text: () => Promise.resolve("") });
        if (callCount === 2) return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        putBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutPlan, name: "Base Ride 1 edited" }), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "UPDATE",
        workout_id: 201,
        name: "Base Ride 1 edited",
        // day not supplied — must preserve current day (0)
      });

      expect(result.structuredContent.action).toBe("updated");
      expect(putBody).toHaveProperty("day", 0);
      expect(putBody).toHaveProperty("name", "Base Ride 1 edited");
    });

    it("UPDATE of a PLAN workout with supplied day changes the day", async () => {
      let putBody: Record<string, unknown> = {};
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutPlan }), text: () => Promise.resolve("") });
        if (callCount === 2) return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        putBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutPlan, day: 7 }), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer();
      await callTool(server, "save_library_workout", {
        source: "UPDATE",
        workout_id: 201,
        day: 7,
      });

      expect(putBody).toHaveProperty("day", 7);
    });
  });

  // ---- EVENT ----------------------------------------------------------------

  describe("EVENT", () => {
    it("copies WORKOUT event fields to a library folder", async () => {
      const calendarEvent = {
        id: 77,
        name: "Threshold Ride",
        category: "WORKOUT",
        type: "Ride",
        description: "3x20m at threshold",
        targets: ["POWER"],
        tags: ["build"],
        indoor: false,
        start_date_local: "2026-08-18T19:00:00",  // should NOT appear in POST
        icu_training_load: 95,                      // should NOT appear in POST
      };

      let postBody: Record<string, unknown> = {};
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve(calendarEvent), text: () => Promise.resolve("") });
        if (callCount === 2) return Promise.resolve({ ok: true, json: () => Promise.resolve([folderBikeSweet]), text: () => Promise.resolve("") });
        postBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 13, name: "Threshold Ride", folder_id: 50, type: "Ride" }),
          text: () => Promise.resolve(""),
        });
      }));

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "EVENT",
        event_id: 77,
        container_id: 50,
      });

      expect(postBody).toEqual(expect.objectContaining({
        folder_id: 50,
        name: "Threshold Ride",
        type: "Ride",
        description: "3x20m at threshold",
        targets: ["POWER"],
      }));
      expect(postBody).not.toHaveProperty("category");
      expect(postBody).not.toHaveProperty("start_date_local");
      expect(postBody).not.toHaveProperty("workout_doc");
      expect(result.structuredContent.action).toBe("created");
    });

    it("rejects non-WORKOUT calendar events and makes no POST", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 77, category: "NOTE", name: "Rest day note" }),
        text: () => Promise.resolve(""),
      });
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "EVENT",
        event_id: 77,
        container_id: 50,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/category|WORKOUT|NOTE/i);
      expect(mockFetch).toHaveBeenCalledTimes(1); // only GET event; no findContainer, no POST
    });

    it("honors optional name and day overrides when copying to a PLAN", async () => {
      const calendarEvent = {
        id: 78,
        name: "Long Run",
        category: "WORKOUT",
        type: "Run",
        description: "2h easy",
        targets: ["HR"],
      };

      let postBody: Record<string, unknown> = {};
      let callCount = 0;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ ok: true, json: () => Promise.resolve(calendarEvent), text: () => Promise.resolve("") });
        if (callCount === 2) return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        postBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 203, folder_id: 90, name: "Week 2 Long Run", type: "Run", day: 14 }),
          text: () => Promise.resolve(""),
        });
      }));

      const { server } = makeServer();
      await callTool(server, "save_library_workout", {
        source: "EVENT",
        event_id: 78,
        container_id: 90,
        name: "Week 2 Long Run",  // override
        day: 14,
      });

      expect(postBody).toEqual(expect.objectContaining({
        folder_id: 90,
        name: "Week 2 Long Run",
        type: "Run",
        day: 14,
      }));
    });

    it("requires event_id and container_id; makes no fetch when missing", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer();
      const result = await callTool(server, "save_library_workout", {
        source: "EVENT",
        // event_id and container_id both omitted
      });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Task 5: delete_library_item
// ---------------------------------------------------------------------------

describe("delete_library_item", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has destructiveHint: true annotation and mentions cascading deletion in description", () => {
    const { server } = makeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools["delete_library_item"];
    expect(tool).toBeDefined();
    expect(tool.annotations?.destructiveHint).toBe(true);
    expect(tool.description).toMatch(/delet.*(folder|plan).*delet.*contained.*workout/i);
  });

  it("confirm: false returns isError: true and makes zero fetch calls", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { server } = makeServer();
    const result = await callTool(server, "delete_library_item", {
      item_type: "WORKOUT",
      item_id: 11,
      confirm: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("deletes a WORKOUT by first resolving the workout, then calling DELETE with others=false", async () => {
    let callCount = 0;
    const calls: { url: string; method?: string }[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++;
      calls.push({ url, method: init?.method ?? "GET" });
      if (callCount === 1) {
        // Step 1: GET /athlete/i123/workouts/11 to resolve workout
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 11, name: "SS-3x10", folder_id: 50 }),
          text: () => Promise.resolve(""),
        });
      }
      // Step 2: DELETE /athlete/i123/workouts/11?others=false
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([11]),
        text: () => Promise.resolve(JSON.stringify([11])),
      });
    }));

    const { server } = makeServer("i123");
    const result = await callTool(server, "delete_library_item", {
      item_type: "WORKOUT",
      item_id: 11,
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/athlete/i123/workouts/11");
    expect(calls[0].method).toBe("GET");
    expect(calls[1].url).toContain("/athlete/i123/workouts/11?others=false");
    expect(calls[1].method).toBe("DELETE");
    expect(result.structuredContent).toEqual({
      item_id: 11,
      item_type: "WORKOUT",
      deleted: true,
      deleted_ids: [11],
    });
  });

  it("deletes a FOLDER by resolving container and calling DELETE on /folders/{id}", async () => {
    let callCount = 0;
    const calls: { url: string; method?: string }[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++;
      calls.push({ url, method: init?.method ?? "GET" });
      if (callCount === 1) {
        // findContainer → GET /athlete/i123/folders
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([folderBikeSweet]),
          text: () => Promise.resolve(""),
        });
      }
      // DELETE /athlete/i123/folders/50
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 50, deleted: true }),
        text: () => Promise.resolve(JSON.stringify({ id: 50, deleted: true })),
      });
    }));

    const { server } = makeServer("i123");
    const result = await callTool(server, "delete_library_item", {
      item_type: "FOLDER",
      item_id: 50,
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/athlete/i123/folders");
    expect(calls[0].method).toBe("GET");
    expect(calls[1].url).toContain("/athlete/i123/folders/50");
    expect(calls[1].method).toBe("DELETE");
    expect(result.structuredContent).toEqual(expect.objectContaining({
      item_id: 50,
      item_type: "FOLDER",
      deleted: true,
      upstream: { id: 50, deleted: true },
    }));
  });

  it("deletes a PLAN by resolving container and calling DELETE on /folders/{id}", async () => {
    let callCount = 0;
    const calls: { url: string; method?: string }[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++;
      calls.push({ url, method: init?.method ?? "GET" });
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([folderPlan]),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 90, deleted: true }),
        text: () => Promise.resolve(JSON.stringify({ id: 90, deleted: true })),
      });
    }));

    const { server } = makeServer("i123");
    const result = await callTool(server, "delete_library_item", {
      item_type: "PLAN",
      item_id: 90,
      confirm: true,
    });

    expect(result.isError).toBeFalsy();
    expect(calls[1].url).toContain("/athlete/i123/folders/90");
    expect(calls[1].method).toBe("DELETE");
    expect(result.structuredContent.item_type).toBe("PLAN");
    expect(result.structuredContent.deleted).toBe(true);
  });

  it("returns an error and makes no DELETE if item_type mismatches the container type", async () => {
    let callCount = 0;
    const calls: { url: string; method?: string }[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      callCount++;
      calls.push({ url, method: init?.method ?? "GET" });
      // Returns folderBikeSweet (type is FOLDER)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([folderBikeSweet]),
        text: () => Promise.resolve(""),
      });
    }));

    const { server } = makeServer("i123");
    const result = await callTool(server, "delete_library_item", {
      item_type: "PLAN", // Mismatches stored FOLDER (id 50)
      item_id: 50,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/FOLDER.*PLAN|type/i);
    expect(calls).toHaveLength(1); // findContainer only; no DELETE call
  });

  it("returns an error if the container is not found and makes no DELETE call", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { server } = makeServer("i123");
    const result = await callTool(server, "delete_library_item", {
      item_type: "FOLDER",
      item_id: 999,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns an error if the workout is not found during initial lookup and makes no DELETE call", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve("Workout not found"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { server } = makeServer("i123");
    const result = await callTool(server, "delete_library_item", {
      item_type: "WORKOUT",
      item_id: 999,
      confirm: true,
    });

    expect(result.isError).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Task 6: schedule_library (Helpers and Tool)
// ---------------------------------------------------------------------------

describe("schedule_library helpers", () => {
  describe("addDays", () => {
    it("handles standard additions within month", () => {
      expect(addDays("2026-08-10", 5)).toBe("2026-08-15");
      expect(addDays("2026-08-10", 0)).toBe("2026-08-10");
    });

    it("handles month rollover", () => {
      expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
      expect(addDays("2026-08-31", 9)).toBe("2026-09-09");
      expect(addDays("2026-08-31", 14)).toBe("2026-09-14");
    });

    it("handles year rollover", () => {
      expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    });

    it("handles leap years correctly", () => {
      expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
      expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
      expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    });

    it("throws on invalid date string", () => {
      expect(() => addDays("not-a-date", 1)).toThrow();
    });
  });

  describe("resolveWorkoutTime", () => {
    it("prefers saved workout time over default time", () => {
      expect(resolveWorkoutTime("07:30", "18:00:00")).toBe("07:30:00");
      expect(resolveWorkoutTime("07:30:15", "18:00:00")).toBe("07:30:15");
    });

    it("falls back to default time when saved time is undefined or null", () => {
      expect(resolveWorkoutTime(undefined, "18:00:00")).toBe("18:00:00");
      expect(resolveWorkoutTime(null, "18:30")).toBe("18:30:00");
    });

    it("falls back to midnight when both are undefined", () => {
      expect(resolveWorkoutTime(undefined, undefined)).toBe("00:00:00");
      expect(resolveWorkoutTime(null, null)).toBe("00:00:00");
    });

    it("throws on invalid saved or default time format", () => {
      expect(() => resolveWorkoutTime("25:00", undefined)).toThrow();
      expect(() => resolveWorkoutTime("invalid", undefined)).toThrow();
      expect(() => resolveWorkoutTime(undefined, "99:00:00")).toThrow();
      expect(() => resolveWorkoutTime(undefined, "12:65:00")).toThrow();
    });
  });

  describe("eventFromWorkout", () => {
    it("copies allowlisted event fields and ignores raw workout_doc or server fields", () => {
      const event = eventFromWorkout(
        {
          ...workoutRaw,
          workout_doc: { step: 1 },
          folder_id: 50,
          id: 11,
        },
        "2026-08-18T19:00:00",
        { name: "Overridden Name" },
      );

      expect(event).toEqual({
        category: "WORKOUT",
        start_date_local: "2026-08-18T19:00:00",
        name: "Overridden Name",
        description: "Main Set\n- 3x\n- 10m 90%",
        type: "Ride",
        indoor: false,
        moving_time: 4200,
        icu_training_load: 68,
        icu_intensity: 0.87,
        targets: ["POWER"],
        tags: ["build"],
      });
      expect(event).not.toHaveProperty("workout_doc");
      expect(event).not.toHaveProperty("folder_id");
      expect(event).not.toHaveProperty("id");
    });

    it("includes plan linkage fields when plan context is provided", () => {
      const event = eventFromWorkout(
        { ...workoutPlan, id: 201 },
        "2026-09-01T00:00:00",
        {},
        { athlete_id: "i123", folder_id: 90 },
      );

      expect(event).toHaveProperty("plan_athlete_id", "i123");
      expect(event).toHaveProperty("plan_folder_id", 90);
      expect(event).toHaveProperty("plan_workout_id", 201);
    });
  });
});

describe("schedule_library", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("WORKOUTS mode", () => {
    it("fetches full workouts and posts bulk events with upsertOnUid=false and updatePlanApplied=false", async () => {
      let postUrl = "";
      let postBody: unknown[] = [];
      let postQuery: Record<string, string> = {};

      const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          postUrl = url;
          const parsed = new URL(url);
          postQuery = Object.fromEntries(parsed.searchParams.entries());
          postBody = JSON.parse(String(init.body ?? "[]")) as unknown[];
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 1001, name: "SS-3x10", start_date_local: "2026-08-18T19:00:00" },
              { id: 1002, name: "Custom Name", start_date_local: "2026-08-20T08:00:00" },
            ]),
            text: () => Promise.resolve(""),
          });
        }
        // GET /workouts/{id}
        if (url.includes("/workouts/11")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutRaw }), text: () => Promise.resolve("") });
        }
        if (url.includes("/workouts/201")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutPlan }), text: () => Promise.resolve("") });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      });
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: [
          { workout_id: 11, start_date_local: "2026-08-18T19:00:00" },
          { workout_id: 201, start_date_local: "2026-08-20T08:00:00", name: "Custom Name", calendar_id: 5 },
        ],
      });

      expect(postUrl).toContain("/athlete/i123/events/bulk");
      expect(postQuery).toEqual({
        upsertOnUid: "false",
        updatePlanApplied: "false",
      });
      expect(postBody).toEqual([
        expect.objectContaining({
          category: "WORKOUT",
          start_date_local: "2026-08-18T19:00:00",
          name: "SS-3x10",
          description: "Main Set\n- 3x\n- 10m 90%",
          type: "Ride",
        }),
        expect.objectContaining({
          category: "WORKOUT",
          start_date_local: "2026-08-20T08:00:00",
          name: "Custom Name",
          calendar_id: 5,
          type: "Ride",
        }),
      ]);
      expect(result.structuredContent).toEqual({
        mode: "WORKOUTS",
        scheduled_count: 2,
        scheduled: [
          { workout_id: 11, event_id: 1001, name: "SS-3x10", start_date_local: "2026-08-18T19:00:00" },
          { workout_id: 201, event_id: 1002, name: "Custom Name", start_date_local: "2026-08-20T08:00:00" },
        ],
      });
    });

    it("allows the same workout ID on different timestamps", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 1001, name: "SS-3x10", start_date_local: "2026-08-18T19:00:00" },
              { id: 1002, name: "SS-3x10", start_date_local: "2026-08-25T19:00:00" },
            ]),
            text: () => Promise.resolve(""),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutRaw }), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: [
          { workout_id: 11, start_date_local: "2026-08-18T19:00:00" },
          { workout_id: 11, start_date_local: "2026-08-25T19:00:00" },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.scheduled_count).toBe(2);
    });

    it("rejects exact duplicate workout_id and timestamp before POST", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: [
          { workout_id: 11, start_date_local: "2026-08-18T19:00:00" },
          { workout_id: 11, start_date_local: "2026-08-18T19:00:00" },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/duplicate/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects invalid timestamps before POST", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: [
          { workout_id: 11, start_date_local: "2026-08-18T25:00:00" },
        ],
      });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects empty workouts array before POST", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: [],
      });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects more than 100 workouts before POST", async () => {
      const mockFetch = vi.fn();
      vi.stubGlobal("fetch", mockFetch);

      const { server } = makeServer("i123");
      const many = Array.from({ length: 101 }, (_, i) => ({
        workout_id: 11,
        start_date_local: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T10:00:00`,
      }));

      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: many,
      });

      expect(result.isError).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("reports unknown bulk failure message when POST throws", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Internal Server Error"),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...workoutRaw }), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "WORKOUTS",
        workouts: [
          { workout_id: 11, start_date_local: "2026-08-18T19:00:00" },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Bulk scheduling outcome is unknown; verify the calendar before retrying.");
      expect(JSON.stringify(result)).not.toContain('"created_count":0');
    });
  });

  describe("PLAN mode", () => {
    it("schedules a complete plan across month boundary with linkage fields and updatePlanApplied=true", async () => {
      let postUrl = "";
      let postBody: unknown[] = [];
      let postQuery: Record<string, string> = {};

      const planWorkoutsList = [
        { id: 201, folder_id: 90, day: 0, time: "06:00:00", athlete_id: "i123" },
        { id: 202, folder_id: 90, day: 9, time: "07:30", athlete_id: "i123" },
        { id: 203, folder_id: 90, day: 14, time: null, athlete_id: "i123" },
      ];

      const fullWorkouts: Record<number, unknown> = {
        201: { id: 201, name: "Day 0 Ride", type: "Ride", description: "Spin", targets: ["POWER"] },
        202: { id: 202, name: "Day 9 Intervals", type: "Ride", description: "3x10", targets: ["POWER"] },
        203: { id: 203, name: "Day 14 Long", type: "Ride", description: "Long ride", targets: ["HR"] },
      };

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          postUrl = url;
          const parsed = new URL(url);
          postQuery = Object.fromEntries(parsed.searchParams.entries());
          postBody = JSON.parse(String(init.body ?? "[]")) as unknown[];
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 301, name: "Day 0 Ride", start_date_local: "2026-08-31T06:00:00" },
              { id: 302, name: "Day 9 Intervals", start_date_local: "2026-09-09T07:30:00" },
              { id: 303, name: "Day 14 Long", start_date_local: "2026-09-14T08:00:00" },
            ]),
            text: () => Promise.resolve(""),
          });
        }
        if (url.includes("/folders")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        }
        if (url.endsWith("/workouts")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(planWorkoutsList), text: () => Promise.resolve("") });
        }
        for (const [id, data] of Object.entries(fullWorkouts)) {
          if (url.endsWith(`/workouts/${id}`)) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve(data), text: () => Promise.resolve("") });
          }
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "PLAN",
        plan_id: 90,
        start_date: "2026-08-31",
        default_start_time: "08:00:00",
      });

      expect(postUrl).toContain("/athlete/i123/events/bulk");
      expect(postQuery.updatePlanApplied).toBe("true");
      expect(postQuery.upsertOnUid).toBe("false");
      expect(postBody).toHaveLength(3);

      // Event 0: day 0 -> 2026-08-31T06:00:00 (saved time 06:00:00 takes precedence over default 08:00:00)
      expect(postBody[0]).toEqual(expect.objectContaining({
        start_date_local: "2026-08-31T06:00:00",
        plan_athlete_id: "i123",
        plan_folder_id: 90,
        plan_workout_id: 201,
      }));

      // Event 1: day 9 across month boundary -> 2026-09-09T07:30:00
      expect(postBody[1]).toEqual(expect.objectContaining({
        start_date_local: "2026-09-09T07:30:00",
        plan_athlete_id: "i123",
        plan_folder_id: 90,
        plan_workout_id: 202,
      }));

      // Event 2: day 14 -> 2026-09-14T08:00:00 (no saved time; uses default 08:00:00)
      expect(postBody[2]).toEqual(expect.objectContaining({
        start_date_local: "2026-09-14T08:00:00",
        plan_athlete_id: "i123",
        plan_folder_id: 90,
        plan_workout_id: 203,
      }));

      expect(result.structuredContent.scheduled_count).toBe(3);
    });

    it("rejects a FOLDER passed as a plan before POST", async () => {
      let postCalled = false;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") postCalled = true;
        if (url.includes("/folders")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderBikeSweet]), text: () => Promise.resolve("") });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "PLAN",
        plan_id: 50, // FOLDER, not PLAN
        start_date: "2026-08-31",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/FOLDER.*PLAN/i);
      expect(postCalled).toBe(false);
    });

    it("rejects a plan workout with missing/negative day before POST", async () => {
      let postCalled = false;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") postCalled = true;
        if (url.includes("/folders")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        }
        if (url.endsWith("/workouts")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 201, folder_id: 90, day: -1, athlete_id: "i123" },
            ]),
            text: () => Promise.resolve(""),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "PLAN",
        plan_id: 90,
        start_date: "2026-08-31",
      });

      expect(result.isError).toBe(true);
      expect(postCalled).toBe(false);
    });

    it("rejects an empty plan before POST", async () => {
      let postCalled = false;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") postCalled = true;
        if (url.includes("/folders")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        }
        if (url.endsWith("/workouts")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]), text: () => Promise.resolve("") });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "PLAN",
        plan_id: 90,
        start_date: "2026-08-31",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/no workouts/i);
      expect(postCalled).toBe(false);
    });

    it("rejects a plan with > 100 workouts before POST", async () => {
      let postCalled = false;
      const manyPlanWorkouts = Array.from({ length: 101 }, (_, i) => ({
        id: 200 + i,
        folder_id: 90,
        day: i,
        athlete_id: "i123",
      }));

      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") postCalled = true;
        if (url.includes("/folders")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        }
        if (url.endsWith("/workouts")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(manyPlanWorkouts), text: () => Promise.resolve("") });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "PLAN",
        plan_id: 90,
        start_date: "2026-08-31",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/100/i);
      expect(postCalled).toBe(false);
    });

    it("rejects invalid saved time in plan workout before POST", async () => {
      let postCalled = false;
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (init?.method === "POST") postCalled = true;
        if (url.includes("/folders")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([folderPlan]), text: () => Promise.resolve("") });
        }
        if (url.endsWith("/workouts")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
              { id: 201, folder_id: 90, day: 0, time: "invalid-time", athlete_id: "i123" },
            ]),
            text: () => Promise.resolve(""),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("") });
      }));

      const { server } = makeServer("i123");
      const result = await callTool(server, "schedule_library", {
        mode: "PLAN",
        plan_id: 90,
        start_date: "2026-08-31",
      });

      expect(result.isError).toBe(true);
      expect(postCalled).toBe(false);
    });
  });
});
