import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { errorResult, textResult } from "./result.js";

type RecordValue = Record<string, unknown>;

const recordSchema = z.record(z.string(), z.unknown());

// Each previewed interval costs one upstream stats request.
const MAX_INTERVALS = 40;

const STAT_FIELDS = [
  "elapsed_time", "moving_time", "average_watts", "weighted_average_watts", "intensity",
  "average_heartrate", "max_heartrate", "average_cadence", "training_load",
] as const;

const intervalInputSchema = z.object({
  start_seconds: z.number().int().nonnegative().describe("Start in elapsed seconds from activity start, as read off the chart"),
  end_seconds: z.number().int().positive().describe("End in elapsed seconds from activity start; the sample at this second is not included"),
  type: z.literal("WORK", {
    error: "Only WORK is accepted: the server stores every submitted interval as WORK. Leave recovery out and it becomes unlabelled RECOVERY automatically",
  }).default("WORK").describe("Always WORK. Leave recovery out of the list; the server fills uncovered time as unlabelled RECOVERY"),
  label: z.string().trim().min(1).optional().describe("Optional interval label, e.g. Rep 1"),
});

const previewInputSchema = z.object({
  activity_id: z.string().trim().min(1).describe("The Intervals.icu activity ID"),
  intervals: z.array(intervalInputSchema).min(1).max(MAX_INTERVALS).describe(
    "The complete list of efforts, in order and not overlapping. Every existing interval is replaced, so include any effort you want to keep. Do not list recovery, warm-up, or cool-down unless they should count as WORK"
  ),
  lock: z.boolean().default(true).describe("Lock intervals after writing so reanalysis does not overwrite them; defaults to true"),
});

const updateInputSchema = previewInputSchema.extend({
  fingerprint: z.string().length(64).describe("Fingerprint returned by preview_activity_intervals"),
  confirm: z.literal(true).describe("Must be true after the athlete explicitly approves the preview"),
});

export interface IntervalRequest {
  start_seconds: number;
  end_seconds: number;
  type: "WORK";
  label?: string;
}

interface SecondsRange {
  start_seconds: number;
  end_seconds: number;
}

interface RecordingGap {
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
}

export interface MappedInterval {
  type: "WORK";
  label?: string;
  start_index: number;
  end_index: number;
  start_seconds: number;
  end_seconds: number;
  recording_gaps: RecordingGap[];
  warnings: string[];
}

interface LoadedState {
  current: RecordValue;
  existing: RecordValue;
  previous: RecordValue[];
  mapped: MappedInterval[];
  serverRecovery: SecondsRange[];
  fingerprint: string;
}

/**
 * Converts elapsed seconds to stream sample indices. The two differ once recording pauses,
 * because paused seconds have no samples. Upstream intervals treat end_index as exclusive:
 * time[start_index] is the start, time[end_index] is the end, and the end of the stream is
 * end_index = time.length with an end time one second past the last sample. An end at the
 * last sample also runs to the end of the stream, because activity elapsed_time reports that
 * second and stopping there would leave a one-sample interval behind.
 */
export function mapIntervalsToIndices(time: number[], intervals: IntervalRequest[]): MappedInterval[] {
  const last = time[time.length - 1];
  const endOfStream = last + 1;
  const firstIndexAtOrAfter = (second: number) => {
    const index = time.findIndex(value => value >= second);
    return index === -1 ? time.length : index;
  };

  const mapped = intervals.map((interval, position) => {
    const name = `Interval ${position + 1}`;
    const { start_seconds: start, end_seconds: end } = interval;
    if (end <= start) throw new Error(`${name}: end must be after its start`);
    if (start > last || end > endOfStream) {
      throw new Error(`${name}: ${start}-${end}s runs past the end of the recording (${endOfStream}s)`);
    }

    const startIndex = firstIndexAtOrAfter(start);
    const reachesEnd = end >= last;
    const endIndex = reachesEnd ? time.length : firstIndexAtOrAfter(end);
    if (endIndex <= startIndex) throw new Error(`${name}: ${start}-${end}s has no recorded samples`);

    const actualStart = time[startIndex];
    const actualEnd = reachesEnd ? endOfStream : time[endIndex];
    const warnings: string[] = [];
    if (actualStart !== start) warnings.push(`Start moved from ${start}s to ${actualStart}s because recording was paused.`);
    if (!reachesEnd && actualEnd !== end) warnings.push(`End moved from ${end}s to ${actualEnd}s because recording was paused.`);

    const recordingGaps: RecordingGap[] = [];
    for (let index = startIndex + 1; index < endIndex; index++) {
      const gapStart = time[index - 1] + 1;
      if (time[index] > gapStart) {
        recordingGaps.push({
          start_seconds: gapStart,
          end_seconds: time[index],
          duration_seconds: time[index] - gapStart,
        });
      }
    }

    return {
      type: interval.type,
      ...(interval.label === undefined ? {} : { label: interval.label }),
      start_index: startIndex,
      end_index: endIndex,
      start_seconds: actualStart,
      end_seconds: actualEnd,
      recording_gaps: recordingGaps,
      warnings,
    };
  });

  mapped.forEach((interval, position) => {
    if (position > 0 && interval.start_index < mapped[position - 1].end_index) {
      throw new Error(`Interval ${position + 1} overlaps the previous interval or is out of order`);
    }
  });
  return mapped;
}

/** Time not covered by a submitted interval, which the server stores as unlabelled RECOVERY. */
function uncoveredRanges(time: number[], mapped: MappedInterval[]): SecondsRange[] {
  const ranges: SecondsRange[] = [];
  let nextIndex = 0;
  for (const interval of mapped) {
    if (interval.start_index > nextIndex) {
      ranges.push({ start_seconds: time[nextIndex], end_seconds: interval.start_seconds });
    }
    nextIndex = interval.end_index;
  }
  if (nextIndex < time.length) {
    ranges.push({ start_seconds: time[nextIndex], end_seconds: time[time.length - 1] + 1 });
  }
  return ranges;
}

function usableTimeStream(streams: RecordValue[] | null): number[] {
  const data = streams?.find(stream => stream.type === "time")?.data;
  const valid = Array.isArray(data) && data.length > 0 && data.every((value, index) =>
    typeof value === "number" && Number.isFinite(value) && (index === 0 || value > (data[index - 1] as number))
  );
  if (!valid) throw new Error("This activity has no usable time stream, so intervals cannot be placed");
  return data as number[];
}

function compactInterval(interval: RecordValue): RecordValue {
  return {
    id: interval.id ?? null,
    start_index: interval.start_index ?? null,
    end_index: interval.end_index ?? null,
    type: interval.type ?? null,
    label: interval.label ?? null,
  };
}

function writePayload(interval: MappedInterval): RecordValue {
  return {
    start_index: interval.start_index,
    end_index: interval.end_index,
    type: interval.type,
    ...(interval.label === undefined ? {} : { label: interval.label }),
  };
}

function intervalList(record: RecordValue | null): RecordValue[] {
  return Array.isArray(record?.icu_intervals) ? record.icu_intervals as RecordValue[] : [];
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function loadState(
  client: IntervalsClient,
  activityId: string,
  intervals: IntervalRequest[],
  lock: boolean,
): Promise<LoadedState> {
  const path = `/activity/${encodeURIComponent(activityId)}`;
  const [current, existing, streams] = await Promise.all([
    client.get<RecordValue | null>(path),
    client.get<RecordValue | null>(`${path}/intervals`),
    client.get<RecordValue[] | null>(`${path}/streams`, { types: "time" }),
  ]);
  if (!current || current.id !== activityId) throw new Error("Target activity was not found or its ID did not match");
  if (current.icu_athlete_id !== client.athleteId) throw new Error("Target activity belongs to a different athlete or its owner could not be verified");
  if (!existing) throw new Error("Could not read the activity's current intervals");

  const time = usableTimeStream(streams);
  const mapped = mapIntervalsToIndices(time, intervals);
  const previous = intervalList(existing).map(compactInterval);
  const fingerprint = await sha256({
    activity_id: activityId,
    analyzed: existing.analyzed ?? null,
    lock_intervals: current.lock_intervals ?? null,
    sample_count: time.length,
    previous,
    intervals: mapped.map(writePayload),
    lock,
  });
  return { current, existing, previous, mapped, serverRecovery: uncoveredRanges(time, mapped), fingerprint };
}

async function withStats(client: IntervalsClient, activityId: string, interval: MappedInterval) {
  const stats = await client.get<RecordValue | null>(
    `/activity/${encodeURIComponent(activityId)}/interval-stats`,
    { start_index: String(interval.start_index), end_index: String(interval.end_index) },
  );
  const span = interval.end_seconds - interval.start_seconds;
  const warnings = [...interval.warnings];
  if (typeof stats?.elapsed_time === "number" && stats.elapsed_time !== span) {
    warnings.push(`Server reports ${stats.elapsed_time}s elapsed but the requested range spans ${span}s.`);
  }
  return {
    ...interval,
    warnings,
    stats: Object.fromEntries(STAT_FIELDS.map(field => [field, stats?.[field] ?? null])),
  };
}

export function registerActivityIntervalTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "preview_activity_intervals",
    {
      description: "Preview replacing an activity's intervals. Takes times in elapsed seconds, converts them to stream sample indices around recording pauses, and returns stats per interval, pauses inside each, the time the server will fill as unlabelled recovery, and the intervals being replaced. List efforts only. Read-only. Show the result to the athlete before calling update_activity_intervals.",
      inputSchema: previewInputSchema.shape,
      outputSchema: {
        activity_id: z.string(),
        lock: z.boolean(),
        intervals: z.array(recordSchema),
        server_recovery: z.array(recordSchema),
        replaces: z.array(recordSchema),
        fingerprint: z.string(),
      },
    },
    async args => {
      try {
        const { activity_id, intervals, lock } = previewInputSchema.parse(args);
        const state = await loadState(client, activity_id, intervals, lock);
        return textResult({
          activity_id,
          lock,
          intervals: await Promise.all(state.mapped.map(interval => withStats(client, activity_id, interval))),
          server_recovery: state.serverRecovery,
          replaces: state.previous,
          fingerprint: state.fingerprint,
        });
      } catch (error) {
        return errorResult("previewing activity intervals", error);
      }
    },
  );

  server.registerTool(
    "update_activity_intervals",
    {
      description: "Replace all of an activity's intervals with a previously previewed list, then lock them unless lock is false. Requires explicit athlete approval and the current preview fingerprint with the same intervals and lock. Returns the previous boundaries. A failed write may have succeeded; inspect the activity before retrying.",
      inputSchema: updateInputSchema.shape,
      outputSchema: {
        applied: z.boolean(),
        activity_id: z.string(),
        verified: z.boolean(),
        locked: z.boolean(),
        lock_error: z.string().nullable(),
        intervals: z.array(recordSchema),
        previous_intervals: z.array(recordSchema),
        warnings: z.array(z.string()),
      },
    },
    async args => {
      try {
        const { activity_id, intervals, lock, fingerprint } = updateInputSchema.parse(args);
        const state = await loadState(client, activity_id, intervals, lock);
        if (state.fingerprint !== fingerprint) {
          throw new Error("The activity or the requested change differs from the preview. Run the preview again.");
        }

        const path = `/activity/${encodeURIComponent(activity_id)}`;
        const payload = state.mapped.map(writePayload);
        let response: RecordValue | null;
        try {
          response = await client.put<RecordValue | null>(`${path}/intervals`, payload, { all: "true" });
        } catch (error) {
          throw new Error(`Interval update outcome is unknown. Inspect activity ${activity_id} before retrying. ${error}`);
        }

        const written = intervalList(response);
        const warnings = state.mapped.flatMap((wanted, position) => written.some(interval =>
          interval.start_index === wanted.start_index
          && interval.end_index === wanted.end_index
          && interval.type === wanted.type
        ) ? [] : [
          `Interval ${position + 1} was not returned as ${wanted.type} at samples ${wanted.start_index}-${wanted.end_index}. Inspect the activity.`,
        ]);

        let locked = state.current.lock_intervals === true;
        let lockError: string | null = null;
        if (lock) {
          try {
            const updated = await client.put<RecordValue | null>(path, { id: activity_id, lock_intervals: true });
            locked = updated?.lock_intervals === true;
            if (!locked) lockError = "The server did not confirm the lock.";
          } catch (error) {
            locked = false;
            lockError = String(error);
          }
        }

        return textResult({
          applied: true,
          activity_id,
          verified: warnings.length === 0,
          locked,
          lock_error: lockError,
          intervals: written.map(compactInterval),
          previous_intervals: state.previous,
          warnings,
        });
      } catch (error) {
        return errorResult("updating activity intervals", error);
      }
    },
  );
}
