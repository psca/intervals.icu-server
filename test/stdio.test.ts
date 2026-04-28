import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStdioServer } from "../src/stdio";

// Stub StdioServerTransport — we don't want it reading from process.stdin in tests
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  })),
}));

describe("createStdioServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an McpServer with all 18 tools registered", async () => {
    const server = await createStdioServer("test-api-key", "i123");

    // McpServer exposes registered tools via _registeredTools (plain object)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    expect(Object.keys(tools).length).toBe(18);
  });

  it("registers all expected tool names", async () => {
    const server = await createStdioServer("test-api-key", "i123");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (server as any)._registeredTools as Record<string, unknown>;
    const names = Object.keys(tools).sort();

    expect(names).toEqual([
      "add_or_update_event",
      "delete_event",
      "delete_events_by_date_range",
      "get_activities",
      "get_activity_details",
      "get_activity_intervals",
      "get_activity_route",
      "get_activity_streams",
      "get_activity_weather",
      "get_athlete_profile",
      "get_event_by_id",
      "get_events",
      "get_gear",
      "get_hr_curves",
      "get_pace_curves",
      "get_power_curves",
      "get_wellness_data",
      "search_activities",
    ]);
  });

  it("throws when API_KEY is missing", async () => {
    await expect(createStdioServer("", "i123")).rejects.toThrow("API_KEY");
  });

  it("throws when ATHLETE_ID is missing", async () => {
    await expect(createStdioServer("test-api-key", "")).rejects.toThrow("ATHLETE_ID");
  });
});
