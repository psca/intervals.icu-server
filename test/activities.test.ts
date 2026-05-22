import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { computeSampleIndices, registerActivityTools } from "../src/tools/activities";

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
