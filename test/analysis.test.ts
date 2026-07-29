import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { compareActivityContexts, loadSpike, loadTrend, zoneDistributionSimilarity, zoneIntentSimilarity } from "../src/analysis";
import { registerAnalysisTools } from "../src/tools/analysis";

function setup() {
  const server = new McpServer({ name: "test", version: "1" });
  const client = { athleteId: "i123", get: vi.fn() };
  registerAnalysisTools(server, client as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client, tools: (server as any)._registeredTools as Record<string, { handler: (input: any) => Promise<any> }> };
}

const comparisonInput = {
  activity_id: "target", lookback_days: 90, comparison_count: 3,
  comparison_mode: "AUTO", duration_tolerance_percent: 25, include_weather_context: false,
};

function bike(id: string, date: string, extra: Record<string, unknown> = {}) {
  return {
    id, type: "VirtualRide", trainer: true, name: "Z2", start_date_local: `${date}T08:00:00`,
    moving_time: 3600, icu_intensity: 70, icu_efficiency_factor: 1, decoupling: 3,
    icu_variability_index: 1.05, icu_weighted_avg_watts: 150, pace: 9,
    icu_zone_times: [0, 2700, 900, 0, 0], ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("shared semantic safeguards", () => {
  it("normalizes zone seconds and ranks exact Z2 intent above Z2-Z3", () => {
    expect(zoneDistributionSimilarity({ icu_zone_times: [{ id: "Z1", secs: 0 }, { id: "Z2", secs: 50 }, { id: "Z3", secs: 50 }] }, { icu_zone_times: [{ id: "Z1", secs: 0 }, { id: "Z2", secs: 100 }, { id: "Z3", secs: 100 }] }, "BIKE")?.score).toBe(100);
    expect(zoneIntentSimilarity({ name: "Aerobic Z2" }, { tags: ["Z2"] })).toEqual({ score: 100, match: "EXACT" });
    expect(zoneIntentSimilarity({ name: "Aerobic Z2" }, { tags: ["Z2-Z3"] })?.score).toBe(50);
  });

  it("uses load-direction labels and exact load-spike thresholds", () => {
    expect(loadTrend(110, 100).status).toBe("INCREASED");
    expect(loadTrend(90, 100).status).toBe("DECREASED");
    expect(loadTrend(105, 100).status).toBe("STABLE");
    expect(loadSpike([...Array(28).fill(10), ...Array(7).fill(15)]).status).toBe("CAUTION");
    expect(loadSpike([...Array(28).fill(10), ...Array(7).fill(20)]).status).toBe("SEVERE");
    expect(loadSpike(Array(34).fill(10)).status).toBe("INSUFFICIENT_DATA");
  });

  it("requires compatible curve contexts and never infers cycling position", () => {
    expect(compareActivityContexts({ trainer: true, tags: [] }, { trainer: false, tags: [] }, "BIKE").comparable).toBe(false);
    expect(compareActivityContexts({ trainer: false, tags: [] }, { trainer: false, tags: [] }, "BIKE").comparable).toBe(true);
    expect(compareActivityContexts({ trainer: false, tags: ["AERO"] }, { trainer: false, tags: [] }, "BIKE").comparable).toBe(false);
    expect(compareActivityContexts({ type: "Swim", pool_length: 25 }, { type: "Swim", pool_length: 50 }, "SWIM").comparable).toBe(false);
  });
});

describe("compare_similar_activities", () => {
  it("keeps bike speed informational outside SAME_ROUTE", async () => {
    const { client, tools } = setup();
    client.get.mockResolvedValueOnce([
      bike("target", "2026-07-10", { pace: 10 }), bike("one", "2026-07-08", { pace: 8 }), bike("two", "2026-07-06", { pace: 7 }),
    ]);
    const result = await tools.compare_similar_activities.handler(comparisonInput);
    expect(result.structuredContent.target.pace_mps).toBe(10);
    expect(result.structuredContent.metric_verdicts).not.toHaveProperty("speed");
    expect(result.structuredContent.comparison_basis.excluded_metrics).toContainEqual(expect.objectContaining({ metric: "speed" }));
  });

  it("permits bike speed only for a shared non-null route in SAME_ROUTE mode", async () => {
    const { client, tools } = setup();
    client.get.mockResolvedValueOnce([
      bike("target", "2026-07-10", { route_id: 7 }), bike("one", "2026-07-08", { route_id: 7 }), bike("two", "2026-07-06", { route_id: 7 }),
    ]);
    const result = await tools.compare_similar_activities.handler({ ...comparisonInput, comparison_mode: "SAME_ROUTE" });
    expect(result.structuredContent.metric_verdicts).toHaveProperty("speed");
    expect(result.structuredContent.comparison_basis.included_metrics).toContain("speed");
  });

  it("ranks exact zone intent first and lowers confidence when distributions are absent", async () => {
    const { client, tools } = setup();
    client.get.mockResolvedValueOnce([
      bike("target", "2026-07-10", { icu_zone_times: undefined, name: "Z2" }),
      bike("partial", "2026-07-09", { icu_zone_times: undefined, name: "Z2-Z3" }),
      bike("exact", "2026-07-08", { icu_zone_times: undefined, name: "Z2" }),
    ]);
    const result = await tools.compare_similar_activities.handler({ ...comparisonInput, comparison_mode: "SAME_SESSION_TYPE" });
    expect(result.structuredContent.comparisons.map((item: Record<string, unknown>) => item.id)).toEqual(["exact", "partial"]);
    expect(result.structuredContent.comparisons[0].score_components.zone_intent_match).toBe("EXACT");
  });

  it("returns NOT_COMPARABLE for a one-candidate cohort and exposes compatibility evidence", async () => {
    const { client, tools } = setup();
    client.get.mockResolvedValueOnce([bike("target", "2026-07-10"), bike("one", "2026-07-08")]);
    const result = await tools.compare_similar_activities.handler(comparisonInput);
    expect(result.structuredContent.overall_verdict).toBe("NOT_COMPARABLE");
    expect(result.structuredContent.comparison_basis).toMatchObject({ selected_count: 1, compatibility_threshold: 70 });
  });

  it("returns recent, selected-median, and per-metric best evidence independently", async () => {
    const { client, tools } = setup();
    client.get.mockResolvedValueOnce([
      bike("target", "2026-07-10", { icu_efficiency_factor: 1.2 }),
      bike("recent", "2026-07-09", { icu_efficiency_factor: 1.0, icu_weighted_avg_watts: 140 }),
      bike("best-ef", "2026-07-05", { icu_efficiency_factor: 1.1, icu_weighted_avg_watts: 145 }),
      bike("best-power", "2026-07-01", { icu_efficiency_factor: .9, icu_weighted_avg_watts: 170 }),
    ]);
    const result = await tools.compare_similar_activities.handler(comparisonInput);
    expect(result.structuredContent.references.most_recent.activity_id).toBe("recent");
    expect(result.structuredContent.references.selected_median.efficiency_factor).toBe(1);
    expect(result.structuredContent.references.best_by_metric.efficiency_factor.activity_id).toBe("best-ef");
    expect(result.structuredContent.references.best_by_metric.power.activity_id).toBe("best-power");
    expect(result.structuredContent.metric_verdicts.efficiency_factor).toHaveProperty("most_recent");
    expect(result.structuredContent.metric_verdicts.efficiency_factor).toHaveProperty("selected_median");
  });
});

describe("get_training_readiness", () => {
  it("reports HRV slope/streak, mildly elevated RHR, training states, demand, signals, and compatibility", async () => {
    const { client, tools } = setup();
    const wellness = Array.from({ length: 28 }, (_, index) => ({
      id: new Date(Date.UTC(2026, 5, 13 + index)).toISOString().slice(0, 10), hrv: index < 21 ? 50 : 44 + index - 21, restingHR: 50,
      sleepSecs: 25_200,
    }));
    wellness[27] = { ...wellness[27], id: "2026-07-10", hrv: 50, restingHR: 52 };
    const activities = [
      bike("bike-old-1", "2026-06-08", { icu_training_load: 30 }), bike("bike-old-2", "2026-06-09", { icu_training_load: 30 }), bike("bike-old-3", "2026-06-10", { icu_training_load: 30 }),
      { ...bike("run-old", "2026-06-10", { icu_training_load: 80 }), type: "Run", trainer: false },
      { ...bike("run-1", "2026-06-27", { icu_training_load: 7 }), type: "Run", trainer: false },
      { ...bike("run-2", "2026-06-27", { icu_training_load: 7 }), type: "Run", trainer: false },
      { ...bike("run-3", "2026-06-27", { icu_training_load: 7 }), type: "Run", trainer: false },
    ];
    client.get.mockImplementation((path: string) => {
      if (path.endsWith("/wellness")) return Promise.resolve(wellness);
      if (path.endsWith("/activities")) return Promise.resolve(activities);
      return Promise.resolve([
        { id: "easy", type: "Run", start_date_local: "2026-07-10", icu_training_load: 30, icu_intensity: 70 },
        { id: "missing", type: "Ride", start_date_local: "2026-07-11" },
        { id: "hard", type: "Ride", start_date_local: "2026-07-13", icu_training_load: 80, icu_intensity: 95 },
      ]);
    });
    const result = await tools.get_training_readiness.handler({ date: "2026-07-10", wellness_lookback_days: 28, activity_lookback_days: 42, planned_lookahead_days: 7, sport: "ALL", include_upcoming_load: true });
    expect(result.structuredContent.systemic_recovery.hrv).toMatchObject({ trend: "RECOVERING" });
    expect(result.structuredContent.systemic_recovery.hrv).toHaveProperty("consecutive_below_baseline_days");
    expect(result.structuredContent.systemic_recovery.resting_hr).toMatchObject({ deviation_bpm: 2, range: "MILDLY_ELEVATED" });
    expect(result.structuredContent.discipline_load.find((item: Record<string, unknown>) => item.discipline === "BIKE").training_state).toBe("LOW_RECENT_TRAINING");
    expect(result.structuredContent.discipline_load.find((item: Record<string, unknown>) => item.discipline === "RUN").training_state).toBe("TRAINED_AND_FRESH");
    expect(result.structuredContent.discipline_load.find((item: Record<string, unknown>) => item.discipline === "SWIM").training_state).toBe("INSUFFICIENT_DATA");
    expect(result.structuredContent.positive_signals.join(" ")).not.toContain("BIKE");
    expect(result.structuredContent.future_demand).toMatchObject({ planned_load_next_48_hours: 30, planned_load_lookahead: 110, planned_sessions_missing_load: 1 });
    expect(result.structuredContent.future_demand.hardest_upcoming_session.id).toBe("hard");
    expect(result.structuredContent.future_demand.compatibility).toBe("COMPATIBLE");
    expect(result.structuredContent).toHaveProperty("status_reasons");
  });

  it("applies limiter precedence to severe subjective data before HRV", async () => {
    const { client, tools } = setup();
    const wellness = Array.from({ length: 10 }, (_, index) => ({ id: `2026-07-${String(index + 1).padStart(2, "0")}`, hrv: index === 9 ? 30 : 50, restingHR: 45, sleepSecs: 25_200, injury: index === 9 ? 8 : 0 }));
    client.get.mockImplementation((path: string) => path.endsWith("/wellness") ? Promise.resolve(wellness) : Promise.resolve([]));
    const result = await tools.get_training_readiness.handler({ date: "2026-07-10", wellness_lookback_days: 14, activity_lookback_days: 42, planned_lookahead_days: 7, sport: "ALL", include_upcoming_load: true });
    expect(result.structuredContent.status).toBe("REST_RECOMMENDED");
    expect(result.structuredContent.primary_limiter).toBe("INJURY_OR_SEVERE_SUBJECTIVE_DATA");
  });
});

describe("get_discipline_trends", () => {
  it("separates volume, cohorts, durability, contexts, evidence, and final summary", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const activities = [
      { ...bike("c1", "2026-07-09", { trainer: true, icu_training_load: 60, icu_efficiency_factor: 1.1, moving_time: 3600 }), race: false },
      { ...bike("c2", "2026-07-08", { trainer: true, icu_training_load: 60, icu_efficiency_factor: 1.1, moving_time: 3600 }), race: false },
      { ...bike("c-race", "2026-07-07", { trainer: true, icu_training_load: 80, moving_time: 10_800 }), race: true },
      { ...bike("p1", "2026-06-10", { trainer: false, icu_training_load: 40, icu_efficiency_factor: 1, moving_time: 3600 }), race: false },
      { ...bike("p2", "2026-06-09", { trainer: false, icu_training_load: 40, icu_efficiency_factor: 1, moving_time: 3600 }), race: false },
      { ...bike("p3", "2026-06-08", { trainer: false, icu_training_load: 40, icu_efficiency_factor: 1, moving_time: 3600 }), race: false },
    ];
    const { client, tools } = setup();
    client.get.mockImplementation((path: string, params: Record<string, string>) => {
      if (path.endsWith("/activities")) return Promise.resolve(activities);
      if (params.newest === "2026-07-10") return Promise.resolve({ secs: [300], curves: [{ id: "c1", start_date_local: "2026-07-09", watts: [220] }] });
      return Promise.resolve({ secs: [300], curves: [{ id: "p1", start_date_local: "2026-06-10", watts: [200] }] });
    });
    const result = await tools.get_discipline_trends.handler({ lookback_days: 28, disciplines: ["BIKE"], windows_weeks: [4], include_efficiency_trends: true, include_durability_trends: true, minimum_sessions_per_period: 2 });
    const discipline = result.structuredContent.disciplines[0]; const window = discipline.windows[0];
    expect(window).toMatchObject({ current_start: "2026-06-13", current_end: "2026-07-10", previous_start: "2026-05-16", previous_end: "2026-06-12" });
    expect(window.volume_trend.status).toBe("INCREASED");
    expect(window.volume_trend.status).not.toMatch(/IMPROVED|DECLINED/);
    expect(window.fitness_trend).toMatchObject({ metric: "WEIGHTED_POWER", unit: "WATTS", current_value: 150, previous_value: 150 });
    expect(window.fitness_trend).not.toHaveProperty("target");
    expect(window.efficiency_trend).toMatchObject({ metric: "EFFICIENCY_FACTOR", unit: "RATIO" });
    expect(window.durability_trend).toMatchObject({ metric: "DECOUPLING", unit: "PERCENT" });
    expect(window.evidence.efficiency_cohort.current_excluded[0]).toMatchObject({ activity_id: "c-race" });
    expect(window.durability_trend).toMatchObject({ status: "INSUFFICIENT_DATA", current_qualifying_count: 1, previous_qualifying_count: 0 });
    expect(window.threshold_evidence.points[0].status).toBe("NOT_COMPARABLE");
    expect(window.evidence.curve_points[0]).toEqual({ axis: 300, current_activity_id: "c1", previous_activity_id: "p1" });
    expect(discipline.summary).toBe("STABLE");
  });

  it("marks sparse current training as LOW_RECENT_TRAINING without using volume as fitness", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const { client, tools } = setup();
    client.get.mockImplementation((path: string) => path.endsWith("/activities") ? Promise.resolve([
      bike("c1", "2026-07-09", { icu_training_load: 20 }),
      bike("p1", "2026-06-10", { icu_training_load: 50 }), bike("p2", "2026-06-09", { icu_training_load: 50 }), bike("p3", "2026-06-08", { icu_training_load: 50 }),
    ]) : Promise.resolve({ secs: [300], curves: [] }));
    const result = await tools.get_discipline_trends.handler({ lookback_days: 28, disciplines: ["BIKE"], windows_weeks: [4], include_efficiency_trends: true, include_durability_trends: true, minimum_sessions_per_period: 3 });
    expect(result.structuredContent.disciplines[0].summary).toBe("LOW_RECENT_TRAINING");
  });

  it("bases the top-level summary on the shortest requested window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const { client, tools } = setup();
    const run = (id: string, date: string, pace: number, efficiency: number) => ({
      id, type: "Run", trainer: false, start_date_local: `${date}T07:00:00`, moving_time: 1800,
      icu_training_load: 30, pace, icu_efficiency_factor: efficiency,
    });
    client.get.mockImplementation((path: string) => path.endsWith("/activities") ? Promise.resolve([
      run("current-1", "2026-07-09", 2, 1), run("current-2", "2026-07-01", 2, 1), run("current-3", "2026-06-20", 2, 1),
      run("prior-1", "2026-06-10", 3, 2), run("prior-2", "2026-06-01", 3, 2), run("prior-3", "2026-05-20", 3, 2),
      run("old-1", "2026-04-10", 1, .5), run("old-2", "2026-03-10", 1, .5), run("old-3", "2026-02-10", 1, .5),
    ]) : Promise.resolve({ distances: [1000], curves: [] }));

    const result = await tools.get_discipline_trends.handler({ lookback_days: 84, disciplines: ["RUN"], windows_weeks: [12, 4], include_efficiency_trends: true, include_durability_trends: true, minimum_sessions_per_period: 3 });
    const discipline = result.structuredContent.disciplines[0];
    const recent = discipline.windows.find((window: Record<string, unknown>) => window.weeks === 4);
    const long = discipline.windows.find((window: Record<string, unknown>) => window.weeks === 12);
    expect(recent.fitness_trend.status).toBe("DECLINED");
    expect(recent.efficiency_trend.status).toBe("DECLINED");
    expect(long.fitness_trend.status).toBe("IMPROVED");
    expect(long.efficiency_trend.status).toBe("IMPROVED");
    expect(discipline).toMatchObject({ summary: "DECLINING", summary_window_weeks: 4 });
  });

  it("keeps sparse swim summaries and threshold aggregates insufficient", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const { client, tools } = setup();
    const swims = [
      { id: "s1", type: "Swim", pool_length: 25, start_date_local: "2026-06-01T07:00:00", moving_time: 1800, icu_training_load: 30, pace: .7 },
      { id: "s2", type: "Swim", pool_length: 25, start_date_local: "2026-05-10T07:00:00", moving_time: 1800, icu_training_load: 30, pace: .7 },
      { id: "s3", type: "Swim", pool_length: 25, start_date_local: "2026-05-01T07:00:00", moving_time: 1800, icu_training_load: 30, pace: .7 },
      { id: "p1", type: "Swim", pool_length: 25, start_date_local: "2026-03-01T07:00:00", moving_time: 1800, icu_training_load: 30, pace: .6 },
    ];
    client.get.mockImplementation((path: string, params: Record<string, string>) => {
      if (path.endsWith("/activities")) return Promise.resolve(swims);
      if (params.newest === "2026-07-10") return Promise.resolve({ distances: [200, 400], curves: [
        { id: "s1", start_date_local: "2026-06-01", secs: [180, 380] },
        { id: "s2", start_date_local: "2026-05-10", secs: [175, 370] },
        { id: "s3", start_date_local: "2026-05-01", secs: [170, 360] },
      ] });
      return Promise.resolve({ distances: [200, 400], curves: [{ id: "p1", start_date_local: "2026-03-01", secs: [190, 390] }] });
    });

    const result = await tools.get_discipline_trends.handler({ lookback_days: 84, disciplines: ["SWIM"], windows_weeks: [4, 12], include_efficiency_trends: true, include_durability_trends: true, minimum_sessions_per_period: 3 });
    const discipline = result.structuredContent.disciplines[0];
    const long = discipline.windows.find((window: Record<string, unknown>) => window.weeks === 12);
    expect(discipline).toMatchObject({ summary: "INSUFFICIENT_DATA", summary_window_weeks: 4 });
    expect(long.threshold_evidence).toMatchObject({
      metric: "PACE_CURVE_ELAPSED_TIME", unit: "SECONDS", status: "INSUFFICIENT_DATA",
      current_activity_count: 3, previous_activity_count: 1, minimum_required: 3, evidence_sufficient: false,
    });
    expect(long.threshold_evidence.points.some((point: Record<string, unknown>) => point.status === "IMPROVED")).toBe(true);
  });
});
