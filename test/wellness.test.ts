import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWellnessTools } from "../src/tools/wellness";

function makeServerWithClient() {
  const server = new McpServer({ name: "test-server", version: "1.0.0" });
  const client = {
    athleteId: "i123",
    get: vi.fn(),
  };

  registerWellnessTools(server, client as never);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, { handler: (...args: unknown[]) => Promise<unknown> }>;

  return { client, tools };
}

function expectTextToMirrorStructuredContent(result: { content: { type: "text"; text: string }[]; structuredContent: unknown }) {
  expect(result.content[0]?.type).toBe("text");
  expect(JSON.parse(result.content[0]?.text ?? "")).toEqual(result.structuredContent);
}

describe("registerWellnessTools", () => {
  it("returns structured wellness entries with coach-relevant metrics", async () => {
    const { client, tools } = makeServerWithClient();
    client.get.mockResolvedValueOnce([
      {
        id: "2026-05-21",
        ctl: 48.2,
        atl: 61.1,
        rampRate: 4.8,
        weight: 74.2,
        restingHR: 47,
        hrv: 54,
        hrvSDNN: 62,
        avgSleepingHR: 44,
        sleepSecs: 27000,
        sleepScore: 83,
        readiness: 7,
        soreness: 3,
        fatigue: 4,
        mood: 8,
        hydration: 7,
        sportInfo: [{ type: "Run", eftp: 4.2 }],
      },
    ]);

    const result = await tools.get_wellness_data.handler({
      start_date: "2026-05-01",
      end_date: "2026-05-21",
    });

    expect(client.get).toHaveBeenCalledWith(
      "/athlete/i123/wellness",
      { oldest: "2026-05-01", newest: "2026-05-21" },
    );
    expectTextToMirrorStructuredContent(result as never);
    expect(result).toMatchObject({
      structuredContent: {
        entries: [
          expect.objectContaining({
            date: "2026-05-21",
            ctl: 48.2,
            atl: 61.1,
            ramp_rate: 4.8,
            weight_kg: 74.2,
            resting_hr_bpm: 47,
            hrv: 54,
            hrv_sdnn: 62,
            avg_sleeping_hr_bpm: 44,
            sleep_hours: 7.5,
            sleep_score: 83,
            readiness: 7,
            soreness: 3,
            fatigue: 4,
            mood: 8,
            hydration: 7,
            sport_info: [{ type: "Run", eftp: 4.2 }],
          }),
        ],
        count: 1,
      },
    });
  });
});
