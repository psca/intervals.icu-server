import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWeekRange, registerWeeklySnapshotTool } from "../src/tools/weekly-snapshot";

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
});

describe("get_weekly_snapshot", () => {
  afterEach(() => vi.restoreAllMocks());

  it("groups all activities and calendar events into seven local days", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockImplementation((path: string) => {
      if (path === "/athlete/i123") return Promise.resolve({ timezone: "Asia/Singapore" });
      if (path.endsWith("/activities")) return Promise.resolve([
        { id: "a1", name: "Unnamed", start_date_local: "2026-07-06T06:00:00" },
        { id: "a2", name: "Ride", start_date_local: "2026-07-08T06:00:00" },
      ]);
      return Promise.resolve([
        { id: "e1", category: "WORKOUT", start_date_local: "2026-07-06T00:00:00" },
        { id: "e2", category: "NOTE", start_date_local: "2026-07-10T00:00:00" },
      ]);
    });

    const result = await tools.get_weekly_snapshot.handler({ week_start: "2026-07-06" });

    expect(client.get).toHaveBeenCalledWith("/athlete/i123");
    expect(client.get).toHaveBeenCalledWith("/athlete/i123/activities", { oldest: "2026-07-06", newest: "2026-07-12" });
    expect(client.get).toHaveBeenCalledWith("/athlete/i123/events", { oldest: "2026-07-06", newest: "2026-07-12" });
    expect(result.structuredContent.days).toHaveLength(7);
    expect(result.structuredContent.days[0]).toMatchObject({ date: "2026-07-06", activity_count: 1, planned_event_count: 1 });
    expect(result.structuredContent.days[2].activities[0].id).toBe("a2");
    expect(result.structuredContent.days[4].planned_events[0].id).toBe("e2");
    expect(result.structuredContent.totals).toEqual({ activity_count: 2, planned_event_count: 2 });
    expect(result.content[0].text).toContain("2 activities, 2 planned events");
    expect(result.structuredContent.days[0].activities[0]).not.toHaveProperty("workout_doc");
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
