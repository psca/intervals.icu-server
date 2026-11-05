import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient } from "../src/client";
import { computeSampleIndices, registerActivityTools } from "../src/tools/activities";
import type { ToolTextResult } from "../src/tools/result";

vi.mock("../src/weather", () => ({
  computeActivityWeather: vi.fn().mockResolvedValue({
    description: "Clear sky",
    average_temp: 29.1,
    average_feels_like: 33.2,
    average_wind_speed: 12.4,
    prevailing_wind_deg: 90,
    prevailing_wind_cardinal: "E",
    headwind_percent: 44.4,
    tailwind_percent: 55.6,
    avg_yaw: 71.2,
    max_rain: 0,
    max_snow: 0,
    average_clouds: 22,
    temp_bar: "temp-bar",
    source: "open-meteo",
  }),
}));

function makeServerWithClient() {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const client = {
    athleteId: "i123",
    get: vi.fn(),
  };

  registerActivityTools(server, client as never);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (...args: unknown[]) => Promise<unknown> }>;

  return { client, tools };
}

function expectTextToMirrorStructuredContent(result: { content: { type: "text"; text: string }[]; structuredContent: unknown }) {
  expect(result.content[0]?.type).toBe("text");
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
}

describe("create_completed_activity", () => {
  afterEach(() => vi.unstubAllGlobals());

  const minimal = {
    name: "Session A",
    type: "WeightTraining",
    start_date_local: "2026-01-15T07:00:00",
    moving_time: 2760,
  };

  function setup(response: unknown = { id: "i123456", name: "Session A" }) {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerActivityTools(server, new IntervalsClient("test-key", "i123"));
    // Match the existing tool tests while exercising the real HTTP client.
    const tools = (server as unknown as { _registeredTools: Record<string, {
      handler: (args: Record<string, unknown>, extra: object) => Promise<ToolTextResult>;
    }> })._registeredTools;
    const call = (args: Record<string, unknown>) => tools.create_completed_activity.handler(args, {});
    return { call, fetchMock };
  }

  it("creates the supplied strength session and preserves all sets in the description", async () => {
    const description = `Romanian Deadlift (Barbell)
Set 1: 60 kg × 10 reps
Set 2: 60 kg × 10 reps
Set 3: 60 kg × 10 reps
Leg Press (Machine)
Set 1: 90 kg × 12 reps
Set 2: 90 kg × 12 reps
Set 3: 90 kg × 15 reps
Leg Extension (Machine)
Set 1: 33 kg × 15 reps
Set 2: 40 kg × 15 reps
Seated Calf Raise
Set 1: 50 kg × 15 reps
Set 2: 50 kg × 15 reps
Set 3: 50 kg × 15 reps
Hip Adduction (Machine)
Set 1: 22.5 kg × 15 reps
Set 2: 22.5 kg × 15 reps
Dumbbell Step Up
Set 1: 25 kg × 4 reps
Set 2: 0 kg × 10 reps`;
    const activity = { id: "i123456", ...minimal, elapsed_time: 2760, description };
    const { call, fetchMock } = setup(activity);
    const result = await call({ ...minimal, description, external_id: "session-a-example" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://intervals.icu/api/v1/athlete/i123/activities/manual");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      ...minimal, elapsed_time: 2760, description, external_id: "session-a-example",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ activity });
    expectTextToMirrorStructuredContent(result as never);
  });

  it("defaults elapsed time to moving time and sends only supported fields", async () => {
    const { call, fetchMock } = setup();
    await call({ ...minimal, calories: 400, session_rpe: 322 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ...minimal, elapsed_time: 2760 });
  });

  it("preserves supplied feedback, manual load, and calendar-event pairing", async () => {
    const fields = { icu_rpe: 7, feel: 3, icu_training_load: 40, paired_event_id: 123456 };
    const activity = { id: "i123456", ...minimal, ...fields, session_rpe: 322 };
    const { call, fetchMock } = setup(activity);

    const result = await call({ ...minimal, ...fields });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ...minimal, elapsed_time: 2760, ...fields,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toEqual({ activity });
  });

  it.each([
    { icu_rpe: 1, feel: 1, icu_training_load: 0 },
    { icu_rpe: 10, feel: 5 },
  ])("accepts feedback boundaries without deriving training load: %j", async fields => {
    const { call, fetchMock } = setup();
    await call({ ...minimal, ...fields });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ...minimal, elapsed_time: 2760, ...fields,
    });
  });

  it("accepts another sport, explicit elapsed time, and distance in metres", async () => {
    const { call, fetchMock } = setup();
    await call({ ...minimal, name: "Run", type: "Run", elapsed_time: 3000, distance: 5000 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      ...minimal, name: "Run", type: "Run", elapsed_time: 3000, distance: 5000,
    });
  });

  it.each([
    { name: undefined }, { name: "   " }, { type: undefined }, { type: "" },
    { start_date_local: undefined }, { start_date_local: "2026-02-30T07:00:00" },
    { start_date_local: "2026-01-15" }, { start_date_local: "2026-01-15T07:00:00Z" },
    { start_date_local: "2026-01-15T07:00:00+01:00" },
    { moving_time: undefined }, { moving_time: 0 }, { moving_time: -1 },
    { moving_time: 2.5 }, { moving_time: Infinity }, { moving_time: NaN },
    { elapsed_time: 2700 }, { elapsed_time: 0 }, { elapsed_time: 3000.5 },
    { distance: -1 }, { distance: Infinity }, { external_id: "   " },
    { icu_rpe: 0 }, { icu_rpe: 11 }, { icu_rpe: 7.5 },
    { feel: 0 }, { feel: 6 }, { feel: 2.5 },
    { paired_event_id: 0 }, { paired_event_id: -1 }, { paired_event_id: 123.5 },
    { paired_event_id: "123" },
    { icu_training_load: -1 }, { icu_training_load: 30.5 }, { icu_training_load: Infinity },
  ])("rejects invalid inputs before writing: %j", async invalid => {
    const { call, fetchMock } = setup();
    const result = await call({ ...minimal, ...invalid });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["http", "network"])("reports %s failures as an unknown outcome without retrying", async failure => {
    const { call, fetchMock } = setup();
    if (failure === "http") fetchMock.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    else fetchMock.mockRejectedValueOnce(new Error("Connection lost"));

    const result = await call(minimal);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome.*unknown/i);
    expect(result.content[0].text).toMatch(/inspect.*before retrying/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { id: "" }, { id: "  " }, { id: 123 }, null, []].map(response => ({ response })))(
    "does not claim success without a usable activity ID: $response", async ({ response }) => {
      const { call, fetchMock } = setup(response);
      const result = await call(minimal);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0].text).toMatch(/outcome.*unknown/i);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("computeSampleIndices", () => {
  it("returns stride-based indices when timeData is empty", () => {
    const indices = computeSampleIndices([], 100, 10);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => i * 10));
  });

  it("returns empty array when totalPoints is 0 and timeData is empty", () => {
    const indices = computeSampleIndices([], 0, 10);
    expect(indices).toEqual([]);
  });

  it("samples at interval boundaries from time data", () => {
    // time data: 0, 1, 2, ... 59 seconds; interval = 30s
    const timeData = Array.from({ length: 60 }, (_, i) => i);
    const indices = computeSampleIndices(timeData, 60, 30);
    // Index 0 (t=0) and index 30 (t=30) are multiples of 30
    expect(indices).toEqual([0, 30]);
  });

  it("always includes index 0 even if time[0] is not a multiple of interval", () => {
    const timeData = [5, 35, 65]; // none are multiples of 30
    const indices = computeSampleIndices(timeData, 3, 30);
    expect(indices[0]).toBe(0);
  });

  it("handles single-point data", () => {
    const indices = computeSampleIndices([0], 1, 1800);
    expect(indices).toEqual([0]);
  });

  it("does not duplicate index 0 when time[0] is already a multiple", () => {
    const timeData = [0, 10, 20, 30];
    const indices = computeSampleIndices(timeData, 4, 10);
    // All are multiples of 10, so all are sampled. Index 0 should not appear twice.
    expect(indices).toEqual([0, 1, 2, 3]);
    expect(indices.filter(i => i === 0).length).toBe(1);
  });
});

describe("registerActivityTools", () => {
  it("returns structured activities with filtering applied", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce([
      { id: "a1", name: "Morning Ride", type: "Ride", start_date_local: "2026-05-01T06:00:00" },
      { id: "a2", name: "Unnamed", type: "Ride", start_date_local: "2026-05-01T07:00:00" },
      { id: "a3", name: "Easy Run", type: "Run", start_date_local: "2026-05-02T06:00:00" },
    ]);

    const result = await tools.get_activities.handler({ limit: 2, include_unnamed: false });

    expect(client.get).toHaveBeenCalledWith(
      "/athlete/i123/activities",
      expect.objectContaining({ limit: "6" }),
    );
    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activities: [
          expect.objectContaining({ id: "a1", name: "Morning Ride" }),
          expect.objectContaining({ id: "a3", name: "Easy Run" }),
        ],
        count: 2,
      },
    });
  });

  it("returns structured activity details", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce({
      id: "a1",
      name: "Morning Ride",
      type: "Ride",
      icu_training_load: 72,
    });

    const result = await tools.get_activity_details.handler({ activity_id: "a1" });

    expect(client.get).toHaveBeenCalledWith("/activity/a1");
    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity: expect.objectContaining({ id: "a1", name: "Morning Ride", type: "Ride" }),
      },
    });
  });

  it("returns structured interval data", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce({
      id: "a1",
      icu_intervals: [{ label: "Interval 1", elapsed_time: 300 }],
      icu_groups: [{ id: "g1", count: 1 }],
    });

    const result = await tools.get_activity_intervals.handler({ activity_id: "a1" });

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_id: "a1",
        interval_count: 1,
        group_count: 1,
        intervals_data: expect.objectContaining({
          id: "a1",
          icu_intervals: expect.any(Array),
          icu_groups: expect.any(Array),
        }),
      },
    });
  });

  it("returns structured streams with raw data", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce([
      { type: "time", name: "Time", valueType: "int", data: [0, 1, 2] },
      { type: "watts", name: "Power", valueType: "int", data: [150, 160, 170] },
    ]);

    const result = await tools.get_activity_streams.handler({ activity_id: "a1", stream_types: "time,watts" });

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_id: "a1",
        requested_stream_types: "time,watts",
        streams: [
          expect.objectContaining({ type: "time", data: [0, 1, 2] }),
          expect.objectContaining({ type: "watts", data: [150, 160, 170] }),
        ],
      },
    });
  });

  it("returns structured sampled route data", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce([
      { type: "time", data: [0, 1800, 3600] },
      { type: "latlng", data: [1.1, 1.2, 1.3], data2: [103.1, 103.2, 103.3] },
      { type: "bearing", data: [80, 90, 100] },
    ]);

    const result = await tools.get_activity_route.handler({
      activity_id: "a1",
      stream_types: "latlng,bearing",
      interval_seconds: 1800,
    });

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_id: "a1",
        requested_stream_types: "latlng,bearing",
        route_data: expect.objectContaining({
          latlng: { lats: [1.1, 1.2, 1.3], lngs: [103.1, 103.2, 103.3] },
          bearing: { data: [80, 90, 100] },
          interval_seconds: 1800,
          total_points: 3,
          sampled_points: 3,
        }),
      },
    });
  });

  it("returns structured weather data", async () => {
    const { client, tools } = makeServerWithClient();
    client.get
      .mockResolvedValueOnce({ start_date_local: "2026-05-01T06:30:00" })
      .mockResolvedValueOnce([
        { type: "time", data: [0, 1800] },
        { type: "latlng", data: [1.1, 1.2], data2: [103.1, 103.2] },
        { type: "bearing", data: [80, 90] },
      ]);

    const result = await tools.get_activity_weather.handler({ activity_id: "a1" });

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_id: "a1",
        weather: expect.objectContaining({
          description: "Clear sky",
          average_feels_like: 33.2,
          prevailing_wind_cardinal: "E",
          temp_bar: "temp-bar",
        }),
      },
    });
  });
});
