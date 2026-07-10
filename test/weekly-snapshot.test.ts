import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWeekRange, registerWeeklySnapshotTool, weekProgress } from "../src/tools/weekly-snapshot";

function makeServerWithClient() {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const client = { athleteId: "i123", get: vi.fn() };
  registerWeeklySnapshotTool(server, client as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (...args: unknown[]) => Promise<any> }>;
  return { client, tools };
}

describe("getWeekRange", () => {
  it("uses the athlete timezone to find the Monday-Sunday week", () => {
    expect(getWeekRange("Asia/Singapore", undefined, new Date("2026-07-12T17:00:00Z")))
      .toEqual({ weekStart: "2026-07-13", weekEnd: "2026-07-19" });
  });

  it("accepts a Monday and rejects invalid custom week starts", () => {
    expect(getWeekRange("UTC", "2026-07-06")).toEqual({ weekStart: "2026-07-06", weekEnd: "2026-07-12" });
    expect(() => getWeekRange("UTC", "2026-07-07")).toThrow("Monday");
    expect(() => getWeekRange("UTC", "2026-02-30")).toThrow("valid YYYY-MM-DD");
  });

  it("reports athlete-local upcoming, in-progress, and complete progress", () => {
    const range = { weekStart: "2026-07-06", weekEnd: "2026-07-12" };
    expect(weekProgress(range, "2026-07-05")).toEqual({ today: "2026-07-05", elapsed_days: 0, remaining_days: 7, week_status: "UPCOMING" });
    expect(weekProgress(range, "2026-07-10")).toEqual({ today: "2026-07-10", elapsed_days: 5, remaining_days: 2, week_status: "IN_PROGRESS" });
    expect(weekProgress(range, "2026-07-13")).toEqual({ today: "2026-07-13", elapsed_days: 7, remaining_days: 0, week_status: "COMPLETE" });
  });
});

describe("get_weekly_snapshot", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("derives safe pairing statuses, comparisons, local progress, and aggregate totals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T04:00:00Z"));
    const { client, tools } = makeServerWithClient();
    client.get.mockImplementation((path: string) => {
      if (path === "/athlete/i123") return Promise.resolve({ timezone: "Asia/Singapore" });
      if (path.endsWith("/activities")) return Promise.resolve([
        { id: "a1", name: "Ride", type: "Ride", start_date_local: "2026-07-06T06:00:00", moving_time: 3600, distance: 30_000, icu_training_load: 60, icu_intensity: 80, paired_event_id: "e1", compliance: 95 },
        { id: "a2", name: "Run", type: "Run", start_date_local: "2026-07-08T06:00:00", moving_time: 1800, distance: 5_000, icu_training_load: 30, compliance: 88 },
      ]);
      return Promise.resolve([
        { id: "e1", type: "Ride", category: "WORKOUT", start_date_local: "2026-07-06T00:00:00", moving_time: 3000, distance: 25_000, icu_training_load: 50, icu_intensity: 75, description: "x".repeat(2100) },
        { id: "e2", type: "Swim", category: "WORKOUT", start_date_local: "2026-07-07T00:00:00", moving_time: 1800, distance: 1500, load_target: 25 },
        { id: "e3", type: "Run", category: "WORKOUT", start_date_local: "2026-07-11T00:00:00", moving_time: 2400, distance: 8_000, load_target: 40 },
      ]);
    });

    const result = await tools.get_weekly_snapshot.handler({ week_start: "2026-07-06" });

    expect(client.get).toHaveBeenCalledWith("/athlete/i123");
    expect(client.get).toHaveBeenCalledWith("/athlete/i123/activities", { oldest: "2026-07-06", newest: "2026-07-12" });
    expect(client.get).toHaveBeenCalledWith("/athlete/i123/events", { oldest: "2026-07-06", newest: "2026-07-12" });
    expect(result.structuredContent.days).toHaveLength(7);
    expect(result.structuredContent).toMatchObject({ today: "2026-07-10", elapsed_days: 5, remaining_days: 2, week_status: "IN_PROGRESS" });
    expect(result.structuredContent.days[0].activities[0]).toMatchObject({ id: "a1", status: "COMPLETED", compliance: 95 });
    expect(result.structuredContent.days[0].activities[0].paired_comparison).toMatchObject({ duration_absolute_delta_seconds: 600, duration_ratio: 1.2, load_absolute_delta: 10, load_ratio: 1.2 });
    expect(result.structuredContent.days[2].activities[0]).toMatchObject({ id: "a2", status: "UNPAIRED_COMPLETION", compliance: null, paired_comparison: null });
    expect(result.structuredContent.days[0].planned_events[0].status).toBe("COMPLETED");
    expect(result.structuredContent.days[1].planned_events[0].status).toBe("MISSED");
    expect(result.structuredContent.days[5].planned_events[0].status).toBe("PLANNED");
    expect(result.structuredContent.days[0].planned_events[0].description).toHaveLength(2000);
    expect(result.structuredContent.days[0].planned_events[0].description_truncated).toBe(true);
    expect(result.structuredContent.totals).toMatchObject({
      activity_count: 2, planned_event_count: 3,
      overall: { completed: { duration_seconds: 5400, load: 90, distance_meters: 35_000 }, planned: { duration_seconds: 7200, load: 115, distance_meters: 34_500 } },
      by_discipline: { BIKE: { completed: { load: 60 }, planned: { load: 50 } }, RUN: { completed: { load: 30 }, planned: { load: 40 } }, SWIM: { planned: { load: 25 } } },
    });
    expect(result.content[0].text).toContain("2 activities, 3 planned events");
    expect(result.structuredContent.days[0].activities[0]).not.toHaveProperty("workout_doc");
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(15_000);
  });

  it("returns an error when the athlete timezone is absent or invalid", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValue({ timezone: "Not/A_Zone" });

    const result = await tools.get_weekly_snapshot.handler({ week_start: "2026-07-06" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no valid timezone");
    expect(client.get).toHaveBeenCalledTimes(1);
  });
});
