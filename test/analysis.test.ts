import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalysisTools } from "../src/tools/analysis";

function setup() {
  const server = new McpServer({ name: "test", version: "1" });
  const client = { athleteId: "i123", get: vi.fn() };
  registerAnalysisTools(server, client as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client, tools: (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }> };
}

describe("analysis tools", () => {
  it("registers all three structured analysis tools", () => {
    const { tools } = setup();
    expect(tools).toHaveProperty("compare_similar_activities");
    expect(tools).toHaveProperty("get_training_readiness");
    expect(tools).toHaveProperty("get_discipline_trends");
  });

  it("compares only compatible indoor bike sessions and returns a compact status", async () => {
    const { client, tools } = setup();
    client.get.mockResolvedValueOnce([
      { id: "new", type: "VirtualRide", trainer: true, name: "Z2", start_date_local: "2026-07-10T08:00:00", moving_time: 3600, icu_intensity: 70, icu_efficiency_factor: 1, decoupling: 2, icu_weighted_avg_watts: 150 },
      { id: "match", type: "VirtualRide", trainer: true, name: "Z2", start_date_local: "2026-07-05T08:00:00", moving_time: 3500, icu_intensity: 71, icu_efficiency_factor: 0.96, decoupling: 3, icu_weighted_avg_watts: 145 },
      { id: "excluded", type: "Ride", trainer: false, name: "Outdoor", start_date_local: "2026-07-04T08:00:00", moving_time: 3600, icu_intensity: 70 },
    ]);

    const result = await tools.compare_similar_activities.handler({ activity_id: "new", lookback_days: 90, comparison_count: 3, comparison_mode: "AUTO", duration_tolerance_percent: 25, include_weather_context: false });
    expect(result.content[0].text).toContain("Compared Z2");
    expect(result.structuredContent.comparisons).toHaveLength(1);
    expect(result.structuredContent.comparisons[0].id).toBe("match");
  });

  it("keeps readiness compact while separating aggregate and discipline load", async () => {
    const { client, tools } = setup();
    client.get.mockImplementation((path: string) => {
      if (path.endsWith("/wellness")) return Promise.resolve([{ id: "2026-07-10", hrv: 60, restingHR: 45, sleepSecs: 25200, ctl: 40, atl: 42 }]);
      if (path.endsWith("/activities")) return Promise.resolve([{ id: "r1", type: "Ride", start_date_local: "2026-07-09T08:00:00", icu_training_load: 50 }]);
      return Promise.resolve([]);
    });
    const result = await tools.get_training_readiness.handler({ date: "2026-07-10", wellness_lookback_days: 14, activity_lookback_days: 42, planned_lookahead_days: 7, sport: "ALL", include_upcoming_load: true });
    expect(result.content[0].text).toContain("Readiness for 2026-07-10");
    expect(result.structuredContent).toHaveProperty("intervals_aggregate");
    expect(result.structuredContent.discipline_load).toHaveLength(3);
  });

  it("reduces curve evidence to per-duration bests rather than raw activities", async () => {
    const { client, tools } = setup();
    client.get.mockImplementation((path: string) => {
      if (path.endsWith("/activities")) return Promise.resolve([{ id: "r1", type: "Ride", start_date_local: "2026-07-09T08:00:00", moving_time: 3600, icu_training_load: 50 }]);
      return Promise.resolve({ secs: [300], curves: [{ id: "r1", start_date_local: "2026-07-09T08:00:00", watts: [200] }] });
    });
    const result = await tools.get_discipline_trends.handler({ lookback_days: 28, disciplines: ["BIKE"], windows_weeks: [4], include_efficiency_trends: false, include_durability_trends: false, minimum_sessions_per_period: 3 });
    const evidence = result.structuredContent.disciplines[0].curve_evidence.current;
    expect(evidence).toEqual({ axis_type: "duration_seconds", bests: [{ axis: 300, value: 200, activity_id: "r1", start_date_local: "2026-07-09T08:00:00" }], activity_count: 1 });
  });
});
