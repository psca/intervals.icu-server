import { afterEach, describe, expect, it, vi } from "vitest";
import { createStdioServer } from "../src/stdio";
import {
  allocatePlannedDuration,
  findCandidates,
  parseSequentialWorkout,
  splitSequentialWorkout,
} from "../src/tools/split-reconciliation";

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(server: any, toolName: string, args: Record<string, unknown>) {
  return server._registeredTools[toolName].handler(args, {});
}

const event = {
  id: 121750183,
  name: "Base Transition — Easy Outdoor Endurance 120 min",
  type: "Ride",
  category: "WORKOUT",
  start_date_local: "2026-07-12T00:00:00",
  moving_time: 7200,
  target: "POWER",
  tags: ["duathlon-base", "transition", "easy"],
  description: "Warmup\n- 10m ramp 45-55% 85rpm\n\nMain Set\n- 100m 55-65% 85-90rpm\n\nCooldown\n- 10m ramp 55-40% 85rpm",
  workout_doc: {
    duration: 7200,
    steps: [
      { duration: 600, power: { start: 45, end: 55, units: "%ftp" }, warmup: true },
      { duration: 6000, power: { start: 55, end: 65, units: "%ftp" } },
      { duration: 600, power: { start: 55, end: 40, units: "%ftp" }, cooldown: true },
    ],
  },
};

const activities = [
  {
    id: "i164875648", name: event.name, type: "Ride", source: "GARMIN_CONNECT",
    start_date_local: "2026-07-12T07:17:15", moving_time: 2851, elapsed_time: 2976,
    paired_event_id: 121750183, compliance: 60.869564, analyzed: "2026-07-12T00:19:29Z",
    icu_intensity: 72.77487,
  },
  {
    id: "i164885877", name: "Singapore Road Cycling", type: "Ride", source: "GARMIN_CONNECT",
    start_date_local: "2026-07-12T08:41:35", moving_time: 2576, elapsed_time: 2662,
    paired_event_id: null, compliance: 0, analyzed: "2026-07-12T01:30:00Z",
    icu_intensity: 72.77487,
  },
];

describe("split-workout reconciliation helpers", () => {
  afterEach(() => vi.unstubAllGlobals());
  const todayDescription = [
    "Warmup",
    "- 10m ramp 45-55% 85rpm",
    "",
    "Main Set",
    "- 100m 55-65% 85-90rpm",
    "",
    "Cooldown",
    "- 10m ramp 55-40% 85rpm",
  ].join("\n");

  it("allocates today's 120-minute plan as 65 and 55 minutes", () => {
    expect(allocatePlannedDuration(7200, [2851, 2576])).toEqual([3900, 3300]);
  });

  it("detects today's activities as one candidate cluster", () => {
    const candidate = findCandidates([event], activities, 90)[0];
    expect(candidate.classification).toBe("EASY_CONTINUOUS_RIDE");
    expect(candidate.eligibility_signals).toContain("Workout name/tags include the supporting cue “easy”.");
  });

  it("accepts a virtual plan completed as outdoor rides with high-intensity advisories", () => {
    const virtualEvent = { ...event, type: "VirtualRide", indoor: true };
    const outdoorActivities = activities.map((activity, index) => ({
      ...activity,
      type: "Ride",
      icu_intensity: index === 0 ? 80.1 : 80.6,
    }));

    const candidate = findCandidates([virtualEvent], outdoorActivities, 90)[0];

    expect(candidate.supported).toBe(true);
    expect(candidate.classification).toBe("EASY_CONTINUOUS_RIDE");
    expect(candidate.warnings).toEqual([]);
    expect(candidate.advisories).toEqual([
      "Activity i164875648 intensity is 80.1%, above the 80% easy-ride advisory threshold.",
      "Activity i164885877 intensity is 80.6%, above the 80% easy-ride advisory threshold.",
    ]);
  });

  it("keeps missing completed intensity advisory-only", () => {
    const withoutIntensity = activities.map(activity => ({ ...activity, icu_intensity: undefined }));
    const candidate = findCandidates([event], withoutIntensity, 90)[0];

    expect(candidate.supported).toBe(true);
    expect(candidate.warnings).toEqual([]);
    expect(candidate.advisories).toEqual([
      "Activity i164875648 has no intensity value.",
      "Activity i164885877 has no intensity value.",
    ]);
  });

  it("still refuses hard planned targets", () => {
    const hardEvent = {
      ...event,
      name: "Sprint workout",
      workout_doc: { duration: 7200, steps: [{ duration: 7200, power: { value: 120, units: "%ftp" } }] },
      description: "Main Set\n- 120m 120%",
    };
    const candidate = findCandidates([hardEvent], activities, 90)[0];
    expect(candidate.supported).toBe(false);
    expect(candidate.classification).toBeNull();
    expect(candidate.warnings.join(" ")).toMatch(/75% FTP/);
  });

  it("still refuses non-cycling activity clusters", () => {
    const runEvent = { ...event, type: "Run" };
    const runActivities = activities.map(activity => ({ ...activity, type: "Run" }));
    const candidate = findCandidates([runEvent], runActivities, 90)[0];

    expect(candidate.supported).toBe(false);
    expect(candidate.classification).toBeNull();
    expect(candidate.warnings.join(" ")).toMatch(/Ride or VirtualRide/);
  });

  it("preserves total duration when allocating three unequal activities", () => {
    const result = allocatePlannedDuration(9000, [3600, 2700, 1700]);
    expect(result.reduce((sum, value) => sum + value, 0)).toBe(9000);
    expect(result).toEqual([4200, 3000, 1800]);
  });

  it("keeps warmup first, cooldown last, and divides today's main set", () => {
    const parsed = parseSequentialWorkout(todayDescription);
    expect(parsed.warning).toBeNull();
    expect(splitSequentialWorkout(parsed.steps, [3900, 3300])).toEqual([
      "Warmup\n- 10m ramp 45-55% 85rpm\n\nMain Set\n- 55m 55-65% 85-90rpm",
      "Main Set\n- 45m 55-65% 85-90rpm\n\nCooldown\n- 10m ramp 55-40% 85rpm",
    ]);
  });

  it("rejects repeats, distance steps, and untimed steps", () => {
    expect(parseSequentialWorkout("Main 4x\n- 5m 90%\n- 2m easy").warning).toMatch(/Repeated/);
    expect(parseSequentialWorkout("Main\n- 2km Z2 Pace").warning).toMatch(/Distance-based/);
    expect(parseSequentialWorkout("Main\n- freeride").warning).toMatch(/time duration/);
  });

  it("rejects plans that cannot preserve five-minute allocation units", () => {
    expect(() => allocatePlannedDuration(3700, [1800, 1900])).toThrow(/multiple of five minutes/);
  });
});

describe("split-workout reconciliation tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("previews today's pair as a supported 65/55 split", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.includes("/activities?") ? activities : [event]),
      text: () => Promise.resolve(""),
    })));
    const server = await createStdioServer("test-key", "i388529");
    const result = await callTool(server, "preview_split_workout_reconciliation", {
      date: "2026-07-12",
      max_gap_minutes: 90,
    });

    expect(result.structuredContent.count).toBe(1);
    const candidate = result.structuredContent.candidates[0];
    expect(candidate.supported).toBe(true);
    expect(candidate.replacements.map((item: { moving_time: number }) => item.moving_time)).toEqual([3900, 3300]);
    expect(candidate.replacements[0].name).toMatch(/Outbound$/);
    expect(candidate.replacements[1].name).toMatch(/Inbound$/);
    expect(candidate.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("applies a current preview with explicit pairings and matching activity names", async () => {
    const activityState = new Map(activities.map(activity => [activity.id, { ...activity }]));
    let eventState = { ...event };
    const createdEvents: Record<string, unknown>[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((urlString: string, init?: RequestInit) => {
      const url = new URL(urlString);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      let response: unknown;
      if (method === "GET" && url.pathname.endsWith("/activities")) {
        response = [...activityState.values()].map(item => ({ ...item }));
      } else if (method === "GET" && url.pathname.endsWith("/events")) {
        response = [{ ...eventState }, ...createdEvents];
      } else if (method === "GET" && url.pathname.includes("/events/")) {
        const id = url.pathname.split("/").pop();
        response = id === String(event.id) ? eventState : createdEvents.find(item => String(item.id) === id);
      }
      else if (method === "GET" && url.pathname.startsWith("/api/v1/activity/")) {
        response = activityState.get(url.pathname.split("/").pop() ?? "");
      } else if (method === "PUT" && url.pathname.startsWith("/api/v1/activity/")) {
        const updated = { ...activityState.get(body.id), ...body };
        activityState.set(body.id, updated);
        response = updated;
      } else if (method === "PUT" && url.pathname.endsWith(`/events/${event.id}`)) {
        eventState = { ...eventState, ...body };
        response = eventState;
      } else if (method === "POST" && url.pathname.endsWith("/events")) {
        response = { id: 222, ...body };
        createdEvents.push(response as Record<string, unknown>);
      } else throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(response), text: () => Promise.resolve("") });
    }));

    const server = await createStdioServer("test-key", "i388529");
    const preview = await callTool(server, "preview_split_workout_reconciliation", { date: "2026-07-12" });
    expect(preview.structuredContent.count).toBe(1);
    const candidate = preview.structuredContent.candidates[0];
    const result = await callTool(server, "reconcile_split_workout", {
      date: "2026-07-12",
      event_id: String(event.id),
      activity_ids: activities.map(activity => activity.id),
      fingerprint: candidate.fingerprint,
      confirm: true,
    });

    expect(result.structuredContent.applied).toBe(true);
    expect(result.structuredContent.event_ids).toEqual([String(event.id), "222"]);
    expect(activityState.get("i164875648")?.paired_event_id).toBe(event.id);
    expect(activityState.get("i164885877")?.paired_event_id).toBe(222);
    expect(activityState.get("i164875648")?.name).toMatch(/Outbound$/);
    expect(activityState.get("i164885877")?.name).toMatch(/Inbound$/);
  });

  it("rejects a stale fingerprint before making any writes", async () => {
    let writeCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") writeCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(url.includes("/activities?") ? activities : [event]),
        text: () => Promise.resolve(""),
      });
    }));
    const server = await createStdioServer("test-key", "i388529");
    const result = await callTool(server, "reconcile_split_workout", {
      date: "2026-07-12",
      event_id: String(event.id),
      activity_ids: activities.map(activity => activity.id),
      fingerprint: "0".repeat(64),
      confirm: true,
    });
    expect(result.structuredContent.applied).toBe(false);
    expect(result.structuredContent.error).toMatch(/changed after preview/);
    expect(writeCount).toBe(0);
  });
});
