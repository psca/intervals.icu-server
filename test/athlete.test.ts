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
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Ride, VirtualRide"),
        },
      ],
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Threshold Pace: 1:55/100m"),
        },
      ],
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
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining('Search results for "tempo"'),
        },
      ],
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
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: expect.stringContaining("5min  : 222w (2.98 w/kg)"),
        },
      ],
    });
  });
});
