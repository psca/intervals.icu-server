import { describe, it, expect, vi, afterEach } from "vitest";
import { createStdioServer } from "../src/stdio";

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

// Uses internal _registeredTools — may break on SDK updates.
// Acceptable tradeoff vs. full transport setup for unit tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callTool(server: any, toolName: string, args: Record<string, unknown>) {
  const tool = server._registeredTools[toolName];
  if (!tool?.handler) throw new Error(`Tool ${toolName} not found`);
  return tool.handler(args, {});
}

describe("event tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates events with extended optional fields and returns structured output", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 123,
          name: "Threshold Ride",
          type: "VirtualRide",
          category: "WORKOUT",
          target: "POWER",
          tags: ["build"],
          load_target: 72,
        }),
        text: () => Promise.resolve(""),
      });
    }));

    const server = await createStdioServer("test-key", "i123");
    const result = await callTool(server, "add_or_update_event", {
      name: "Threshold Ride",
      type: "VirtualRide",
      start_date: "2026-06-01",
      moving_time: 3600,
      description: "Main\n- 3x\n- 10m 95% FTP\n- 5m easy",
      target: "POWER",
      tags: ["build"],
      load_target: 72,
      indoor: true,
      athlete_cannot_edit: true,
    });

    expect(requestBody).toContain("\"type\":\"VirtualRide\"");
    expect(requestBody).toContain("\"target\":\"POWER\"");
    expect(requestBody).toContain("\"tags\":[\"build\"]");
    expect(requestBody).toContain("\"load_target\":72");
    expect(requestBody).toContain("\"indoor\":true");
    expect(requestBody).toContain("\"athlete_cannot_edit\":true");
    expect(result.content[0].text).toBe("Event created.");
    expect(result.structuredContent.action).toBe("created");
    expect(result.structuredContent.event.type).toBe("VirtualRide");
  });

  it("supports legacy workout_type input for backwards compatibility", async () => {
    let requestBody = "";
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 124, name: "Easy Run", type: "Run", category: "WORKOUT" }),
        text: () => Promise.resolve(""),
      });
    }));

    const server = await createStdioServer("test-key", "i123");
    const result = await callTool(server, "add_or_update_event", {
      name: "Easy Run",
      workout_type: "Run",
      start_date: "2026-06-02",
    });

    expect(requestBody).toContain("\"type\":\"Run\"");
    expect(result.structuredContent.action).toBe("created");
    expect(result.structuredContent.event.type).toBe("Run");
  });

  it("returns structured output for get_events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { id: "e1", name: "Easy Run", start_date_local: "2026-06-01T00:00:00", category: "WORKOUT", type: "Run" },
      ]),
      text: () => Promise.resolve(""),
    }));

    const server = await createStdioServer("test-key", "i123");
    const result = await callTool(server, "get_events", { start_date: "2026-06-01", end_date: "2026-06-07" });

    expect(result.content[0].text).toBe("Returned 1 events.");
    expect(result.structuredContent.events).toHaveLength(1);
    expect(result.structuredContent.events[0].id).toBe("e1");
  });

  it("reports zero deleted when no events in range", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      callCount++;
      // First call: GET events list
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([]),
          text: () => Promise.resolve("[]"),
        });
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve("") });
    }));

    const server = await createStdioServer("test-key", "i123");
    const result = await callTool(server, "delete_events_by_date_range", { start_date: "2025-01-01", end_date: "2025-01-31" });

    expect(result.content[0].text).toBe("No events found in the specified date range.");
    expect(result.structuredContent.deleted_count).toBe(0);
    expect(result.structuredContent.failed_event_ids).toEqual([]);
  });

  it("reports partial failure correctly", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      // First call: GET events list — returns 3 events
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: "e1" }, { id: "e2" }, { id: "e3" },
          ]),
          text: () => Promise.resolve(""),
        });
      }
      // DELETE calls: e1 and e3 succeed, e2 fails
      if (callCount === 3) {
        // Second DELETE (e2) fails
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal error"),
        });
      }
      // Other DELETEs succeed
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(""),
      });
    }));

    const server = await createStdioServer("test-key", "i123");
    const result = await callTool(server, "delete_events_by_date_range", { start_date: "2025-01-01", end_date: "2025-01-31" });

    expect(result.content[0].text).toBe("Deleted 2 events; 1 failed.");
    expect(result.structuredContent.deleted_count).toBe(2);
    expect(result.structuredContent.failed_event_ids).toEqual(["e2"]);
  });

  it("reports all failures when every delete fails", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      // First call: GET events list
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ id: "e1" }, { id: "e2" }]),
          text: () => Promise.resolve(""),
        });
      }
      // All DELETEs fail
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Server error"),
      });
    }));

    const server = await createStdioServer("test-key", "i123");
    const result = await callTool(server, "delete_events_by_date_range", { start_date: "2025-01-01", end_date: "2025-01-31" });

    expect(result.content[0].text).toBe("Deleted 0 events; 2 failed.");
    expect(result.structuredContent.deleted_count).toBe(0);
    expect(result.structuredContent.failed_event_ids).toEqual(expect.arrayContaining(["e1", "e2"]));
  });
});
