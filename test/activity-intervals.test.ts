import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IntervalsClient } from "../src/client";
import { mapIntervalsToIndices, registerActivityIntervalTools } from "../src/tools/activity-intervals";
import type { ToolTextResult } from "../src/tools/result";

const ACTIVITY_ID = "i100001";

// Recording pauses from a sample ride: [last second before the pause, first second after it].
const REAL_GAPS: [number, number][] = [
  [283, 295], [309, 366], [480, 487], [585, 604], [626, 630], [655, 678],
  [876, 898], [1639, 1662], [1712, 1752], [2118, 2174], [2270, 2275], [2961, 2977],
];

function timeStream(gaps: [number, number][], last: number): number[] {
  const time: number[] = [];
  let second = 0;
  for (const [before, after] of [...gaps, [last, last + 1] as [number, number]]) {
    while (second <= before) time.push(second++);
    second = after;
  }
  return time;
}

const REAL_TIME = timeStream(REAL_GAPS, 3771);

// Boundaries the server itself reported for that ride, as [start_index, end_index, start_time, end_time].
const SERVER_INTERVALS = [
  [0, 307, 0, 374], [307, 364, 374, 431], [364, 681, 431, 797], [681, 748, 797, 864],
  [748, 765, 864, 902], [765, 825, 902, 962], [825, 1317, 962, 1454], [1317, 1394, 1454, 1531],
  [1394, 1757, 1531, 1955], [1757, 1910, 1955, 2108], [1910, 1955, 2108, 2208], [1955, 1999, 2208, 2252],
  [1999, 2345, 2252, 2602], [2345, 2466, 2602, 2723], [2466, 2476, 2723, 2733], [2476, 2515, 2733, 2772],
  [2515, 2584, 2772, 2841], [2584, 3001, 2841, 3273], [3001, 3075, 3273, 3347], [3075, 3500, 3347, 3772],
];

const TIME = [0, 1, 2, 3, 4, 10, 11, 12, 13, 14];
const existingIntervals = {
  id: ACTIVITY_ID,
  analyzed: "2026-11-05T10:40:08.392+00:00",
  icu_intervals: [{ id: 7, start_index: 0, end_index: 10, type: "RECOVERY", label: null, elapsed_time: 15 }],
  icu_groups: [],
};

interface Routes {
  activity?: unknown;
  intervals?: unknown;
  time?: unknown;
  putIntervals?: unknown;
  putActivity?: unknown;
}

function setup(routes: Routes = {}) {
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    const respond = (value: unknown) => {
      if (value instanceof Error) throw value;
      return new Response(JSON.stringify(value));
    };
    if (method === "PUT" && path === `/activity/${ACTIVITY_ID}/intervals`) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      return respond(routes.putIntervals ?? { id: ACTIVITY_ID, icu_intervals: body, icu_groups: [] });
    }
    if (method === "PUT" && path === `/activity/${ACTIVITY_ID}`) {
      return respond(routes.putActivity ?? { id: ACTIVITY_ID, lock_intervals: true });
    }
    if (method !== "GET") throw new Error(`Unexpected ${method} ${path}`);
    if (path === `/activity/${ACTIVITY_ID}`) {
      return respond(routes.activity ?? { id: ACTIVITY_ID, icu_athlete_id: "i123", lock_intervals: false });
    }
    if (path === `/activity/${ACTIVITY_ID}/intervals`) return respond(routes.intervals ?? existingIntervals);
    if (path === `/activity/${ACTIVITY_ID}/streams`) {
      return respond(routes.time ?? [{ type: "time", data: TIME }]);
    }
    if (path === `/activity/${ACTIVITY_ID}/interval-stats`) {
      const start = Number(url.searchParams.get("start_index"));
      const end = Number(url.searchParams.get("end_index"));
      const endTime = end < TIME.length ? TIME[end] : TIME[TIME.length - 1] + 1;
      return respond({
        start_index: start, end_index: end, elapsed_time: endTime - TIME[start], moving_time: end - start,
        average_watts: 240, weighted_average_watts: 245, intensity: 96, average_heartrate: 160,
        max_heartrate: 172, average_cadence: 94, training_load: 12, joules: 99999,
      });
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerActivityIntervalTools(server, new IntervalsClient("test-key", "i123"));
  const tools = (server as unknown as { _registeredTools: Record<string, {
    handler: (args: Record<string, unknown>, extra: object) => Promise<ToolTextResult>;
  }> })._registeredTools;
  const writes = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT");
  return {
    fetchMock,
    writes,
    preview: (args: Record<string, unknown>) => tools.preview_activity_intervals.handler(args, {}),
    update: (args: Record<string, unknown>) => tools.update_activity_intervals.handler(args, {}),
  };
}

const REPS = [{ start_seconds: 1, end_seconds: 12, label: "Rep 1" }];

async function previewFingerprint(ctx: ReturnType<typeof setup>, args: Record<string, unknown>): Promise<string> {
  const result = await ctx.preview(args);
  expect(result.isError).not.toBe(true);
  return (result.structuredContent as { fingerprint: string }).fingerprint;
}

describe("mapIntervalsToIndices", () => {
  it("reproduces every boundary the server reported for a ride with recording pauses", () => {
    const mapped = mapIntervalsToIndices(REAL_TIME, SERVER_INTERVALS.map(([, , start_seconds, end_seconds]) => ({
      start_seconds, end_seconds, type: "WORK" as const,
    })));
    expect(mapped.map(item => [item.start_index, item.end_index, item.start_seconds, item.end_seconds]))
      .toEqual(SERVER_INTERVALS);
  });

  it("treats the second after the last sample as the end of the stream", () => {
    const [mapped] = mapIntervalsToIndices(TIME, [{ start_seconds: 10, end_seconds: 15, type: "WORK" }]);
    expect([mapped.start_index, mapped.end_index, mapped.end_seconds]).toEqual([5, 10, 15]);
  });

  it("runs an interval ending at the last sample to the end of the stream", () => {
    const [mapped] = mapIntervalsToIndices(REAL_TIME, [{ start_seconds: 3469, end_seconds: 3771, type: "WORK" }]);
    expect([mapped.start_index, mapped.end_index, mapped.end_seconds]).toEqual([3197, 3500, 3772]);
    expect(mapped.warnings).toEqual([]);
  });

  it("snaps a boundary inside a recording pause forward and reports it", () => {
    const [mapped] = mapIntervalsToIndices(TIME, [{ start_seconds: 6, end_seconds: 12, type: "WORK" }]);
    expect([mapped.start_index, mapped.start_seconds]).toEqual([5, 10]);
    expect(mapped.warnings).toEqual(["Start moved from 6s to 10s because recording was paused."]);
  });

  it("reports recording pauses inside an interval", () => {
    const [mapped] = mapIntervalsToIndices(TIME, [{ start_seconds: 1, end_seconds: 12, type: "WORK" }]);
    expect(mapped.recording_gaps).toEqual([{ start_seconds: 5, end_seconds: 10, duration_seconds: 5 }]);
  });

  it("ignores a recording pause that ends exactly at the interval start or end", () => {
    const [before] = mapIntervalsToIndices(TIME, [{ start_seconds: 1, end_seconds: 5, type: "WORK" }]);
    const [after] = mapIntervalsToIndices(TIME, [{ start_seconds: 10, end_seconds: 12, type: "WORK" }]);
    expect(before.recording_gaps).toEqual([]);
    expect(after.recording_gaps).toEqual([]);
  });

  it.each([
    ["an end before its start", [{ start_seconds: 5, end_seconds: 5, type: "WORK" }], /after its start/],
    ["a start past the recording", [{ start_seconds: 20, end_seconds: 21, type: "WORK" }], /past the end/],
    ["an end past the recording", [{ start_seconds: 1, end_seconds: 16, type: "WORK" }], /past the end/],
    ["an interval entirely inside a pause", [{ start_seconds: 6, end_seconds: 8, type: "WORK" }], /no recorded samples/],
    ["overlapping intervals", [
      { start_seconds: 0, end_seconds: 3, type: "WORK" },
      { start_seconds: 2, end_seconds: 4, type: "WORK" },
    ], /overlap|order/],
    ["out-of-order intervals", [
      { start_seconds: 11, end_seconds: 12, type: "WORK" },
      { start_seconds: 0, end_seconds: 3, type: "WORK" },
    ], /overlap|order/],
  ] as const)("rejects %s", (_name, intervals, message) => {
    expect(() => mapIntervalsToIndices(TIME, intervals.map(item => ({ ...item })))).toThrow(message);
  });
});

describe("preview_activity_intervals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns mapped indices, stats, and the intervals being replaced without writing", async () => {
    const ctx = setup();
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    expect(result.isError).not.toBe(true);
    expect(ctx.writes()).toEqual([]);
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.lock).toBe(true);
    expect(output.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(output.replaces).toEqual([{ id: 7, start_index: 0, end_index: 10, type: "RECOVERY", label: null }]);
    const [rep] = output.intervals as Record<string, unknown>[];
    expect(rep).toMatchObject({
      type: "WORK", label: "Rep 1", start_index: 1, end_index: 7, start_seconds: 1, end_seconds: 12,
      recording_gaps: [{ start_seconds: 5, end_seconds: 10, duration_seconds: 5 }],
    });
    expect(rep.stats).toEqual({
      elapsed_time: 11, moving_time: 6, average_watts: 240, weighted_average_watts: 245, intensity: 96,
      average_heartrate: 160, max_heartrate: 172, average_cadence: 94, training_load: 12,
    });
  });

  it("shows the time the server will fill as unlabelled recovery", async () => {
    const ctx = setup();
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    expect((result.structuredContent as Record<string, unknown>).server_recovery).toEqual([
      { start_seconds: 0, end_seconds: 1 },
      { start_seconds: 12, end_seconds: 15 },
    ]);
  });

  it("omits server recovery when the intervals cover the whole recording", async () => {
    const ctx = setup();
    const result = await ctx.preview({
      activity_id: ACTIVITY_ID, intervals: [{ start_seconds: 0, end_seconds: 14 }],
    });
    expect((result.structuredContent as Record<string, unknown>).server_recovery).toEqual([]);
  });

  it("rejects RECOVERY intervals, which the server would store as WORK", async () => {
    const ctx = setup();
    const result = await ctx.preview({
      activity_id: ACTIVITY_ID, intervals: [{ start_seconds: 1, end_seconds: 12, type: "RECOVERY" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Leave recovery out/);
    expect(ctx.fetchMock).not.toHaveBeenCalled();
  });

  it("asks the server for stats using the mapped sample indices", async () => {
    const ctx = setup();
    await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    const stats = ctx.fetchMock.mock.calls.map(([input]) => new URL(input))
      .find(url => url.pathname.endsWith("/interval-stats"));
    expect(stats?.searchParams.get("start_index")).toBe("1");
    expect(stats?.searchParams.get("end_index")).toBe("7");
  });

  it("warns when server stats disagree with the mapped duration", async () => {
    const ctx = setup({ time: [{ type: "time", data: TIME }] });
    const original = ctx.fetchMock.getMockImplementation()!;
    ctx.fetchMock.mockImplementation(async (input, init) => {
      if (new URL(input).pathname.endsWith("/interval-stats")) {
        return new Response(JSON.stringify({ elapsed_time: 99 }));
      }
      return original(input, init);
    });
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    const [rep] = (result.structuredContent as { intervals: { warnings: string[] }[] }).intervals;
    expect(rep.warnings).toEqual(["Server reports 99s elapsed but the requested range spans 11s."]);
  });

  it("rejects an activity belonging to another athlete", async () => {
    const ctx = setup({ activity: { id: ACTIVITY_ID, icu_athlete_id: "i999" } });
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/different athlete/);
  });

  it("rejects an activity whose owner cannot be verified", async () => {
    const ctx = setup({ activity: { id: ACTIVITY_ID } });
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not be verified/);
  });

  it("rejects an activity without a usable time stream", async () => {
    const ctx = setup({ time: [] });
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: REPS });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/time stream/);
  });

  it("rejects a time stream that does not strictly increase", async () => {
    const ctx = setup({ time: [{ type: "time", data: [0, 1, 1, 2] }] });
    const result = await ctx.preview({ activity_id: ACTIVITY_ID, intervals: [{ start_seconds: 0, end_seconds: 2 }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/time stream/);
  });

  it("changes the fingerprint when the requested boundaries, lock choice, current lock, or current intervals change", async () => {
    const base = await previewFingerprint(setup(), { activity_id: ACTIVITY_ID, intervals: REPS });
    expect(await previewFingerprint(setup(), {
      activity_id: ACTIVITY_ID, intervals: [{ ...REPS[0], end_seconds: 13 }],
    })).not.toBe(base);
    expect(await previewFingerprint(setup(), { activity_id: ACTIVITY_ID, intervals: REPS, lock: false })).not.toBe(base);
    expect(await previewFingerprint(setup({
      activity: { id: ACTIVITY_ID, icu_athlete_id: "i123", lock_intervals: true },
    }), { activity_id: ACTIVITY_ID, intervals: REPS })).not.toBe(base);
    expect(await previewFingerprint(setup({
      intervals: { ...existingIntervals, analyzed: "2026-11-06T00:00:00.000+00:00" },
    }), { activity_id: ACTIVITY_ID, intervals: REPS })).not.toBe(base);
  });
});

describe("update_activity_intervals", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function apply(routes: Routes = {}, extra: Record<string, unknown> = {}) {
    const ctx = setup(routes);
    const args = { activity_id: ACTIVITY_ID, intervals: REPS, ...extra };
    const fingerprint = await previewFingerprint(ctx, args);
    const result = await ctx.update({ ...args, fingerprint, confirm: true });
    return { ...ctx, result, output: result.structuredContent as Record<string, unknown> };
  }

  it("explicitly replaces all intervals with only the mapped boundaries, type, and label", async () => {
    const { writes, result } = await apply();
    expect(result.isError).not.toBe(true);
    const [url, init] = writes()[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/api/v1/activity/${ACTIVITY_ID}/intervals`);
    expect(parsed.searchParams.get("all")).toBe("true");
    expect(JSON.parse(String(init.body))).toEqual([{ start_index: 1, end_index: 7, type: "WORK", label: "Rep 1" }]);
  });

  it("locks after writing and reports the verified result with previous boundaries", async () => {
    const { writes, output } = await apply();
    expect(writes()).toHaveLength(2);
    const [url, init] = writes()[1] as [string, RequestInit];
    expect(new URL(url).pathname).toBe(`/api/v1/activity/${ACTIVITY_ID}`);
    expect(JSON.parse(String(init.body))).toEqual({ id: ACTIVITY_ID, lock_intervals: true });
    expect(output).toMatchObject({
      applied: true, verified: true, locked: true, lock_error: null,
      previous_intervals: [{ id: 7, start_index: 0, end_index: 10, type: "RECOVERY", label: null }],
    });
  });

  it("does not touch the lock when lock is false", async () => {
    const { writes, output } = await apply({}, { lock: false });
    expect(writes()).toHaveLength(1);
    expect(output.locked).toBe(false);
  });

  it("refuses a stale fingerprint without writing", async () => {
    const ctx = setup();
    const result = await ctx.update({
      activity_id: ACTIVITY_ID, intervals: REPS, fingerprint: "0".repeat(64), confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Run the preview again/);
    expect(ctx.writes()).toEqual([]);
  });

  it("refuses a write without confirmation", async () => {
    const ctx = setup();
    const fingerprint = await previewFingerprint(ctx, { activity_id: ACTIVITY_ID, intervals: REPS });
    const result = await ctx.update({ activity_id: ACTIVITY_ID, intervals: REPS, fingerprint, confirm: false });
    expect(result.isError).toBe(true);
    expect(ctx.writes()).toEqual([]);
  });

  it("refuses to apply a different lock choice than was previewed", async () => {
    const ctx = setup();
    const fingerprint = await previewFingerprint(ctx, { activity_id: ACTIVITY_ID, intervals: REPS });
    const result = await ctx.update({ activity_id: ACTIVITY_ID, intervals: REPS, lock: false, fingerprint, confirm: true });
    expect(result.isError).toBe(true);
    expect(ctx.writes()).toEqual([]);
  });

  it("reports an unknown outcome when the interval write fails, and does not lock", async () => {
    const { result, writes } = await apply({ putIntervals: new Error("500: boom") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outcome is unknown/);
    expect(writes()).toHaveLength(1);
  });

  it("flags a response that does not contain the requested boundaries", async () => {
    const { output } = await apply({
      putIntervals: { id: ACTIVITY_ID, icu_intervals: [{ start_index: 2, end_index: 7, type: "WORK" }] },
    });
    expect(output).toMatchObject({ applied: true, verified: false });
    expect(output.warnings).toEqual(["Interval 1 was not returned as WORK at samples 1-7. Inspect the activity."]);
  });

  it("flags an interval the server returned with a different type", async () => {
    const { output } = await apply({
      putIntervals: { id: ACTIVITY_ID, icu_intervals: [{ start_index: 1, end_index: 7, type: "RECOVERY" }] },
    });
    expect(output).toMatchObject({ applied: true, verified: false });
  });

  it("stays verified when the server adds its own recovery intervals", async () => {
    const { output } = await apply({
      putIntervals: { id: ACTIVITY_ID, icu_intervals: [
        { start_index: 0, end_index: 1, type: "RECOVERY", label: null },
        { start_index: 1, end_index: 7, type: "WORK", label: "Rep 1" },
        { start_index: 7, end_index: 10, type: "RECOVERY", label: null },
      ] },
    });
    expect(output).toMatchObject({ applied: true, verified: true, warnings: [] });
  });

  it("reports a partial result when locking fails after the intervals were written", async () => {
    const { result, output } = await apply({ putActivity: new Error("403: nope") });
    expect(result.isError).not.toBe(true);
    expect(output).toMatchObject({ applied: true, verified: true, locked: false });
    expect(String(output.lock_error)).toMatch(/403/);
  });

  it("reports not locked when the server ignores the lock field", async () => {
    const { output } = await apply({ putActivity: { id: ACTIVITY_ID, lock_intervals: false } });
    expect(output).toMatchObject({ applied: true, locked: false });
    expect(String(output.lock_error)).toMatch(/did not confirm/);
  });
});
