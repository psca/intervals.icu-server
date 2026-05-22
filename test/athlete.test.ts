import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAthleteTools } from "../src/tools/athlete";

function makeServerWithClient() {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const client = {
    athleteId: "i123",
    get: vi.fn(),
  };

  registerAthleteTools(server, client as never);

  // McpServer stores tool metadata and handlers internally.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (...args: unknown[]) => Promise<unknown> }>;

  return { client, tools };
}

function expectTextToMirrorStructuredContent(result: { content: { type: "text"; text: string }[]; structuredContent: unknown }) {
  expect(result.content[0]?.type).toBe("text");
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
}

describe("registerAthleteTools", () => {
  it("formats athlete sport settings from types arrays and unit-aware threshold pace", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce({
      firstname: "Alex",
      lastname: "Runner",
      city: "Singapore",
      country: "Singapore",
      icu_weight: 74.4,
      icu_resting_hr: 44,
      sportSettings: [
        {
          types: ["Ride", "VirtualRide"],
          ftp: 250,
          lthr: 170,
          max_hr: 189,
          power_zones: [55, 75, 90],
          hr_zones: [136, 151, 158],
        },
        {
          types: ["Swim", "OpenWaterSwim"],
          threshold_pace: 0.8695652,
          pace_units: "SECS_100M",
          lthr: 172,
        },
      ],
      bikes: [{ name: "Race Bike", distance: 123456 }],
      shoes: [{ name: "Tempo Shoes", distance: 54321 }],
    });

    const result = await tools.get_athlete_profile.handler();

    expect(client.get).toHaveBeenCalledWith("/athlete/i123");
    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        athlete_profile: {
          full_name: "Alex Runner",
          location: "Singapore, Singapore",
          weight_kg: 74.4,
          resting_hr_bpm: 44,
          sport_settings: [
            expect.objectContaining({
              label: "Ride, VirtualRide",
              ftp: 250,
              lthr: 170,
              max_hr: 189,
              power_zones: [55, 75, 90],
              hr_zones: [136, 151, 158],
            }),
            expect.objectContaining({
              label: "Swim, OpenWaterSwim",
              threshold_pace_mps: 0.8695652,
              threshold_pace_display: "1:55/100m",
              pace_units: "SECS_100M",
            }),
          ],
          bikes: [expect.objectContaining({ name: "Race Bike", distance_meters: 123456, distance_display: "123.5km" })],
          shoes: [expect.objectContaining({ name: "Tempo Shoes", distance_meters: 54321, distance_display: "54.3km" })],
        },
      },
    });
  });

  it("searches activities with the q parameter expected by intervals.icu", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce([
      {
        id: "i999",
        name: "Tempo Run",
        start_date_local: "2026-04-25T20:58:35",
        type: "Run",
        distance: 10034.08,
        moving_time: 3801,
        tags: null,
      },
    ]);

    const result = await tools.search_activities.handler({ query: "tempo", limit: 1 });

    expect(client.get).toHaveBeenCalledWith(
      "/athlete/i123/activities/search",
      { q: "tempo", limit: "1" },
    );
    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        query: "tempo",
        activities: [
          expect.objectContaining({
            id: "i999",
            name: "Tempo Run",
            type: "Run",
          }),
        ],
        count: 1,
      },
    });
  });

  it("requests power curves with a required activity type and default date range", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce({
      list: [
        {
          label: "1 year",
          start_date_local: "2025-03-26T00:00:00",
          end_date_local: "2026-03-26T23:59:59",
          secs: [1, 300],
          watts: [1030, 222],
          watts_per_kg: [13.82, 2.98],
          vo2max_5m: 43.18,
        },
      ],
    });

    const result = await tools.get_power_curves.handler({ activity_type: "Ride" });

    expect(client.get).toHaveBeenCalledWith(
      "/athlete/i123/power-curves",
      expect.objectContaining({ type: "Ride" }),
    );
    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_type: "Ride",
        curves: [
          expect.objectContaining({
            label: "1 year",
            bests: expect.arrayContaining([
              expect.objectContaining({ duration_seconds: 1, label: "1s", watts: 1030 }),
              expect.objectContaining({ duration_seconds: 300, label: "5min", watts: 222, watts_per_kg: 2.98 }),
            ]),
            vo2max_5m: 43.18,
          }),
        ],
        count: 1,
      },
    });
  });

  it("returns structured pace curve models", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce({
      list: [
        {
          label: "90 days",
          start_date_local: "2026-01-01T00:00:00",
          end_date_local: "2026-03-31T23:59:59",
          paceModels: [
            { type: "critical-speed", criticalSpeed: 4.2, dPrime: 180, r2: 0.98 },
          ],
        },
      ],
    });

    const result = await tools.get_pace_curves.handler({ activity_type: "Run" });

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_type: "Run",
        curves: [
          expect.objectContaining({
            label: "90 days",
            pace_models: [
              expect.objectContaining({
                type: "critical-speed",
                critical_speed_mps: 4.2,
                critical_speed_display: "3:58/km",
                d_prime_meters: 180,
                r2: 0.98,
              }),
            ],
          }),
        ],
        count: 1,
      },
    });
  });

  it("returns structured hr curve bests", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce({
      list: [
        {
          label: "42 days",
          start_date_local: "2026-02-01T00:00:00",
          end_date_local: "2026-03-14T23:59:59",
          secs: [30, 300],
          values: [182, 176],
        },
      ],
    });

    const result = await tools.get_hr_curves.handler({ activity_type: "Run" });

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        activity_type: "Run",
        curves: [
          expect.objectContaining({
            label: "42 days",
            bests: expect.arrayContaining([
              expect.objectContaining({ duration_seconds: 30, label: "30s", bpm: 182 }),
              expect.objectContaining({ duration_seconds: 300, label: "5min", bpm: 176 }),
            ]),
          }),
        ],
        count: 1,
      },
    });
  });

  it("returns structured gear grouped by type", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce([
      { name: "Race Bike", type: "Bike", distance: 123456, activities: 42, time: 54000, retired: false },
      { name: "Tempo Shoes", type: "Shoes", distance: 54321, activities: 30, time: 18000, retired: false },
      { name: "Old Bike", type: "Bike", distance: 10000, retired: true },
    ]);

    const result = await tools.get_gear.handler();

    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        gear: expect.arrayContaining([
          expect.objectContaining({ name: "Race Bike", type: "Bike", retired: false }),
          expect.objectContaining({ name: "Old Bike", type: "Bike", retired: true }),
        ]),
        active_gear_by_type: {
          Bike: expect.any(Array),
          Shoes: expect.any(Array),
        },
        retired_gear: [
          expect.objectContaining({ name: "Old Bike", retired: true }),
        ],
      },
    });
  });
});
