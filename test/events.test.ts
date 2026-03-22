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

describe("delete_events_by_date_range", () => {
  afterEach(() => vi.unstubAllGlobals());

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

    expect(result.content[0].text).toContain("Deleted 0");
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

    expect(result.content[0].text).toContain("Deleted 2");
    expect(result.content[0].text).toContain("Failed: 1");
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

    expect(result.content[0].text).toContain("Deleted 0");
    expect(result.content[0].text).toContain("Failed: 2");
  });
});
