import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient } from "../src/client";
import { registerActivityTools } from "../src/tools/activities";
import type { ToolTextResult } from "../src/tools/result";

const existing = {
  id: "i123456", icu_athlete_id: "i123", name: "Session A", type: "WeightTraining",
  start_date_local: "2026-01-15T07:00:00", moving_time: 2760, elapsed_time: 3000,
  description: "Romanian Deadlift: 3 × 10 at 60 kg", paired_event_id: 123,
};

function setup(current: unknown = existing, response: unknown = existing) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(current)))
    .mockResolvedValueOnce(new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetchMock);
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerActivityTools(server, new IntervalsClient("test-key", "i123"));
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (args: Record<string, unknown>, extra: object) => Promise<ToolTextResult>;
  }> })._registeredTools;
  return {
    fetchMock,
    call: (args: Record<string, unknown>) => tools.update_completed_activity.handler(args, {}),
  };
}

describe("update_completed_activity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("updates feedback without resending existing notes, durations, or pairing", async () => {
    const updated = { ...existing, icu_rpe: 7, feel: 3, icu_training_load: 40 };
    const { call, fetchMock } = setup(existing, updated);
    const result = await call({ activity_id: "i123456", icu_rpe: 7, feel: 3, icu_training_load: 40 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://intervals.icu/api/v1/activity/i123456");
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://intervals.icu/api/v1/activity/i123456");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ id: "i123456", icu_rpe: 7, feel: 3, icu_training_load: 40 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ activity: updated });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });

  it("preserves explicit clearing, zero values, and unpairing", async () => {
    const fields = { description: "", distance: 0, icu_training_load: 0, paired_event_id: null };
    const { call, fetchMock } = setup(existing, { ...existing, ...fields });
    await call({ activity_id: "i123456", ...fields });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "i123456", ...fields });
  });

  it("supports title, sport, start time, duration, source ID, and pairing edits", async () => {
    const fields = {
      name: "Updated session", type: "Workout", start_date_local: "2026-01-15T21:35:00",
      moving_time: 2700, elapsed_time: 2900, external_id: "source-123", paired_event_id: 456,
    };
    const { call, fetchMock } = setup(existing, { ...existing, ...fields });
    await call({ activity_id: "i123456", ...fields, calories: 500, session_rpe: 999 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "i123456", ...fields });
  });

  it.each([{ moving_time: 2900 }, { elapsed_time: 2800 }])(
    "validates one-field duration edits without defaulting the omitted value: %j", async fields => {
      const { call, fetchMock } = setup();
      await call({ activity_id: "i123456", ...fields });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "i123456", ...fields });
    },
  );

  it.each([{ moving_time: 3100 }, { elapsed_time: 2700 }])(
    "rejects duration edits that conflict with existing values: %j", async fields => {
      const { call, fetchMock } = setup();
      const result = await call({ activity_id: "i123456", ...fields });
      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("requires both durations when the existing counterpart is unavailable", async () => {
    const { call, fetchMock } = setup({ ...existing, elapsed_time: null });
    const result = await call({ activity_id: "i123456", moving_time: 2800 });
    expect(result.isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { activity_id: "" }, { activity_id: "i123456" },
    { activity_id: "i123456", calories: 200 },
    { activity_id: "i123456", icu_rpe: 11 }, { activity_id: "i123456", feel: 0 },
    { activity_id: "i123456", moving_time: 0 }, { activity_id: "i123456", elapsed_time: 2.5 },
    { activity_id: "i123456", name: " " }, { activity_id: "i123456", paired_event_id: -1 },
    { activity_id: "i123456", icu_training_load: -1 },
    { activity_id: "i123456", start_date_local: "2026-01-15T07:00:00Z" },
  ])("rejects invalid or empty updates before any request: %j", async input => {
    const { call, fetchMock } = setup();
    const result = await call(input);
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { ...existing, id: "i999" }, { ...existing, icu_athlete_id: "i999" },
    { ...existing, icu_athlete_id: null }, { ...existing, icu_athlete_id: undefined },
  ].map(current => ({ current })))(
    "does not write to a missing, mismatched, or different-athlete target: $current", async ({ current }) => {
      const { call, fetchMock } = setup(current);
      const result = await call({ activity_id: "i123456", icu_rpe: 7 });
      expect(result.isError).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("does not write when the preflight lookup fails", async () => {
    const { call, fetchMock } = setup();
    fetchMock.mockReset().mockRejectedValueOnce(new Error("Lookup failed"));
    const result = await call({ activity_id: "i123456", icu_rpe: 7 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Lookup failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, { id: "" }, { ...existing, id: "i999" }].map(response => ({ response })))(
    "reports malformed update responses as an unknown outcome: $response", async ({ response }) => {
      const { call, fetchMock } = setup(existing, response);
      const result = await call({ activity_id: "i123456", icu_rpe: 7 });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content[0].text).toMatch(/outcome.*unknown/i);
      expect(result.content[0].text).toContain("i123456");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["http", "network"])("reports %s write failures without retrying", async failure => {
    const { call, fetchMock } = setup();
    fetchMock.mockReset().mockResolvedValueOnce(new Response(JSON.stringify(existing)));
    if (failure === "http") fetchMock.mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    else fetchMock.mockRejectedValueOnce(new Error("Connection lost"));
    const result = await call({ activity_id: "i123456", icu_rpe: 7 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome.*unknown/i);
    expect(result.content[0].text).toMatch(/inspect.*before retrying/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
