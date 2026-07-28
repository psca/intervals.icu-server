import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { errorResult, textResult } from "./result.js";

type RecordValue = Record<string, unknown>;
export type CyclingType = "Ride" | "VirtualRide";

const recordSchema = z.record(z.string(), z.unknown());
const FIVE_MINUTES = 300;

interface ParsedStep {
  header: string;
  line: string;
  duration: number;
  kind: "warmup" | "main" | "cooldown";
}

interface Replacement {
  activity_id: string;
  name: string;
  moving_time: number;
  description: string;
  type: CyclingType;
  indoor: boolean;
}

interface Candidate {
  event: RecordValue;
  activities: RecordValue[];
  replacements: Replacement[];
  classification: "EASY_CONTINUOUS_RIDE" | null;
  eligibility_signals: string[];
  supported: boolean;
  warnings: string[];
  advisories: string[];
}

function numberField(record: RecordValue, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(record: RecordValue, key: string): string {
  return typeof record[key] === "string" ? record[key] : "";
}

export function cyclingType(record: RecordValue): CyclingType | null {
  const type = stringField(record, "type");
  return type === "Ride" || type === "VirtualRide" ? type : null;
}

function localDate(record: RecordValue): string {
  return stringField(record, "start_date_local").slice(0, 10);
}

function activityEndMs(activity: RecordValue): number {
  const start = Date.parse(stringField(activity, "start_date_local"));
  return start + numberField(activity, "elapsed_time") * 1000;
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function durationMatch(line: string): RegExpMatchArray | null {
  return line.match(/\b(?:(\d+)h(?:(\d+)m)?|(\d+)m|(\d+)s)\b/i);
}

function durationSeconds(match: RegExpMatchArray): number {
  if (match[1]) return Number(match[1]) * 3600 + Number(match[2] ?? 0) * 60;
  if (match[3]) return Number(match[3]) * 60;
  return Number(match[4]);
}

/** Parse only deterministic sequential time-based workout descriptions. */
export function parseSequentialWorkout(description: string): { steps: ParsedStep[]; warning: string | null } {
  const lines = description.split(/\r?\n/);
  const steps: ParsedStep[] = [];
  let header = "Main Set";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.startsWith("- ")) {
      if (/\b\d+\s*x\b/i.test(line)) {
        return { steps: [], warning: "Repeated workout blocks are not supported for automatic splitting." };
      }
      header = line;
      continue;
    }
    if (/\b\d+(?:\.\d+)?\s*(?:km|mi|mtr|yd?|yards?)\b/i.test(line)) {
      return { steps: [], warning: "Distance-based workout steps are not supported for automatic splitting." };
    }
    const match = durationMatch(line);
    if (!match || match.index == null) {
      return { steps: [], warning: "Every workout step must have a time duration for automatic splitting." };
    }
    const context = `${header} ${line}`.toLowerCase();
    const kind = context.includes("warmup") || context.includes("warm-up")
      ? "warmup"
      : context.includes("cooldown") || context.includes("cool-down")
        ? "cooldown"
        : "main";
    steps.push({ header, line, duration: durationSeconds(match), kind });
  }

  return steps.length
    ? { steps, warning: null }
    : { steps: [], warning: "The workout has no timed steps to split." };
}

/** Allocate a planned duration by actual moving-time share in five-minute units. */
export function allocatePlannedDuration(total: number, actualDurations: number[]): number[] {
  if (total <= 0 || total % FIVE_MINUTES !== 0) {
    throw new Error("The original planned duration must be a positive multiple of five minutes.");
  }
  if (actualDurations.length < 2 || actualDurations.some(value => value <= 0)) {
    throw new Error("At least two activities with positive moving time are required.");
  }
  const units = total / FIVE_MINUTES;
  if (units < actualDurations.length) throw new Error("The planned duration is too short to allocate five minutes per activity.");
  const actualTotal = actualDurations.reduce((sum, value) => sum + value, 0);
  const quotas = actualDurations.map(value => value / actualTotal * units);
  const allocations = quotas.map(quota => Math.max(1, Math.floor(quota)));
  let assigned = allocations.reduce((sum, value) => sum + value, 0);

  while (assigned > units) {
    const index = allocations
      .map((value, i) => ({ value, i, excess: value - quotas[i] }))
      .filter(item => item.value > 1)
      .sort((a, b) => b.excess - a.excess || b.i - a.i)[0]?.i;
    if (index == null) throw new Error("Unable to preserve the planned duration while allocating activities.");
    allocations[index]--;
    assigned--;
  }
  while (assigned < units) {
    const index = quotas
      .map((quota, i) => ({ i, remainder: quota - Math.floor(quota) }))
      .sort((a, b) => b.remainder - a.remainder || a.i - b.i)[0].i;
    allocations[index]++;
    assigned++;
    quotas[index] = Math.floor(quotas[index]);
  }
  return allocations.map(value => value * FIVE_MINUTES);
}

function replaceStepDuration(step: ParsedStep, duration: number): string {
  const match = durationMatch(step.line);
  if (!match || match.index == null) throw new Error("Timed step changed during reconciliation.");
  return step.line.slice(0, match.index) + formatDuration(duration) + step.line.slice(match.index + match[0].length);
}

/** Split a sequential workout across journey parts without duplicating warmup/cooldown. */
export function splitSequentialWorkout(steps: ParsedStep[], allocations: number[]): string[] {
  const warmup = steps.filter(step => step.kind === "warmup").reduce((sum, step) => sum + step.duration, 0);
  const cooldown = steps.filter(step => step.kind === "cooldown").reduce((sum, step) => sum + step.duration, 0);
  if (warmup > allocations[0]) throw new Error("Warmup is longer than the first replacement workout.");
  if (cooldown > allocations[allocations.length - 1]) throw new Error("Cooldown is longer than the final replacement workout.");

  const queues = allocations.map(value => value);
  const output: ParsedStep[][] = allocations.map(() => []);
  let part = 0;

  for (const original of steps) {
    if (original.kind === "cooldown") part = allocations.length - 1;
    let remaining = original.duration;
    while (remaining > 0) {
      while (part < queues.length && queues[part] === 0) part++;
      if (part >= queues.length) throw new Error("Workout steps exceed the allocated planned duration.");
      const used = Math.min(remaining, queues[part]);
      output[part].push({ ...original, duration: used });
      queues[part] -= used;
      remaining -= used;
    }
  }
  if (queues.some(value => value !== 0)) throw new Error("Workout steps do not fill the allocated planned duration.");

  return output.map(partSteps => {
    const lines: string[] = [];
    let previousHeader = "";
    for (const step of partSteps) {
      if (step.header !== previousHeader) {
        if (lines.length) lines.push("");
        lines.push(step.header);
        previousHeader = step.header;
      }
      lines.push(replaceStepDuration(step, step.duration));
    }
    return lines.join("\n");
  });
}

function partSuffix(index: number, count: number): string {
  if (count === 2) return index === 0 ? "Outbound" : "Inbound";
  return `Part ${index + 1}`;
}

function plannedDuration(event: RecordValue): number {
  const doc = event.workout_doc as RecordValue | undefined;
  return numberField(doc ?? {}, "duration") || numberField(event, "moving_time") || numberField(event, "time_target");
}

function normalizedIntensity(record: RecordValue): number | null {
  const value = record.icu_intensity;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value <= 1.5 ? value * 100 : value;
}

function easyRideEligibility(event: RecordValue, activities: RecordValue[], total: number): {
  eligible: boolean;
  signals: string[];
  warnings: string[];
  advisories: string[];
} {
  const warnings: string[] = [];
  const advisories: string[] = [];
  const signals: string[] = [];
  if (!cyclingType(event)) warnings.push("Only Ride or VirtualRide workouts are eligible for split reconciliation.");
  if (total < 3600) warnings.push("The original planned ride must be at least 60 minutes.");

  const workoutDoc = event.workout_doc as RecordValue | undefined;
  const docSteps = Array.isArray(workoutDoc?.steps) ? workoutDoc.steps as RecordValue[] : [];
  if (!docSteps.length) {
    warnings.push("Structured power steps are required to confirm an easy continuous ride.");
  } else {
    for (const step of docSteps) {
      const power = step.power as RecordValue | undefined;
      if (!power || power.units !== "%ftp") {
        warnings.push("Every planned step must use an FTP-relative power target.");
        break;
      }
      const targets = [power.value, power.start, power.end]
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      if (!targets.length || Math.max(...targets) > 75) {
        warnings.push("Every planned power target must stay at or below 75% FTP.");
        break;
      }
    }
    if (!warnings.some(warning => warning.includes("power target") || warning.includes("FTP-relative"))) {
      signals.push("All planned power targets are at or below 75% FTP.");
    }
  }

  for (const activity of activities) {
    if (!cyclingType(activity)) {
      warnings.push(`Activity ${activity.id} is not a Ride or VirtualRide.`);
      continue;
    }
    const intensity = normalizedIntensity(activity);
    if (intensity == null) {
      advisories.push(`Activity ${activity.id} has no intensity value.`);
    } else if (intensity > 80) {
      advisories.push(`Activity ${activity.id} intensity is ${intensity.toFixed(1)}%, above the 80% easy-ride advisory threshold.`);
    }
  }
  if (!advisories.length) {
    signals.push("Every completed activity part is at or below 80% intensity.");
  }

  const text = [event.name, ...(Array.isArray(event.tags) ? event.tags : [])].join(" ").toLowerCase();
  const cue = ["easy", "cafe", "endurance", "recovery", "social", "long", "base"].find(word => text.includes(word));
  if (cue) signals.push(`Workout name/tags include the supporting cue “${cue}”.`);
  return { eligible: warnings.length === 0, signals, warnings, advisories };
}

function buildCandidate(event: RecordValue, activities: RecordValue[]): Candidate {
  const warnings: string[] = [];
  const description = stringField(event, "description");
  const parsed = parseSequentialWorkout(description);
  if (parsed.warning) warnings.push(parsed.warning);
  const total = plannedDuration(event);
  const eligibility = easyRideEligibility(event, activities, total);
  if (!parsed.warning) eligibility.signals.push("Workout is sequential, time-based, and contains no repeat blocks.");
  warnings.push(...eligibility.warnings);
  let allocations: number[] = [];
  let descriptions: string[] = [];
  try {
    allocations = allocatePlannedDuration(total, activities.map(activity => numberField(activity, "moving_time")));
    if (!parsed.warning) descriptions = splitSequentialWorkout(parsed.steps, allocations);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  const supported = eligibility.eligible && warnings.length === 0 && descriptions.length === activities.length;
  const baseName = stringField(event, "name");
  return {
    event,
    activities,
    classification: supported ? "EASY_CONTINUOUS_RIDE" : null,
    eligibility_signals: eligibility.signals,
    supported,
    warnings,
    advisories: eligibility.advisories,
    replacements: activities.map((activity, index) => ({
      activity_id: stringField(activity, "id"),
      name: `${baseName} — ${partSuffix(index, activities.length)}`,
      moving_time: allocations[index] ?? 0,
      description: descriptions[index] ?? "",
      type: cyclingType(activity) ?? "Ride",
      indoor: typeof activity.indoor === "boolean" ? activity.indoor : cyclingType(activity) === "VirtualRide",
    })),
  };
}

export function findCandidates(events: RecordValue[], activities: RecordValue[], maxGapMinutes: number): Candidate[] {
  const eventsById = new Map(events.map(event => [String(event.id), event]));
  const bySport = new Map<string, RecordValue[]>();
  for (const activity of activities) {
    const type = stringField(activity, "type");
    if (!type) continue;
    const sport = cyclingType(activity) ? "Cycling" : type;
    bySport.set(sport, [...(bySport.get(sport) ?? []), activity]);
  }
  const candidates: Candidate[] = [];
  for (const sameSport of bySport.values()) {
    sameSport.sort((a, b) => Date.parse(stringField(a, "start_date_local")) - Date.parse(stringField(b, "start_date_local")));
    let cluster: RecordValue[] = [];
    const flush = () => {
      if (cluster.length < 2) return;
      const pairedIds = [...new Set(cluster.map(a => a.paired_event_id).filter(id => id != null).map(String))];
      if (pairedIds.length !== 1 || !cluster.some(a => a.paired_event_id == null)) return;
      const event = eventsById.get(pairedIds[0]);
      if (event) candidates.push(buildCandidate(event, cluster));
    };
    for (const activity of sameSport) {
      if (!cluster.length) {
        cluster = [activity];
        continue;
      }
      const previous = cluster[cluster.length - 1];
      const gap = (Date.parse(stringField(activity, "start_date_local")) - activityEndMs(previous)) / 60000;
      if (gap >= 0 && gap <= maxGapMinutes && localDate(previous) === localDate(activity)) cluster.push(activity);
      else {
        flush();
        cluster = [activity];
      }
    }
    flush();
  }
  return candidates;
}

function fingerprintPayload(candidate: Candidate): RecordValue {
  return {
    event: {
      id: candidate.event.id,
      name: candidate.event.name,
      type: candidate.event.type,
      indoor: candidate.event.indoor ?? null,
      start_date_local: candidate.event.start_date_local,
      moving_time: plannedDuration(candidate.event),
      description: candidate.event.description,
      updated: candidate.event.updated ?? null,
    },
    activities: candidate.activities.map(activity => ({
      id: activity.id,
      type: activity.type,
      indoor: activity.indoor ?? null,
      start_date_local: activity.start_date_local,
      moving_time: activity.moving_time,
      elapsed_time: activity.elapsed_time,
      icu_intensity: activity.icu_intensity ?? null,
      paired_event_id: activity.paired_event_id ?? null,
      name: activity.name,
      updated: activity.analyzed ?? activity.updated ?? null,
    })),
    replacements: candidate.replacements,
    classification: candidate.classification,
    eligibility_signals: candidate.eligibility_signals,
    advisories: candidate.advisories,
  };
}

async function fingerprint(candidate: Candidate): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(fingerprintPayload(candidate)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function loadCandidates(client: IntervalsClient, date: string, maxGapMinutes: number): Promise<Candidate[]> {
  const [activities, events] = await Promise.all([
    client.get<RecordValue[]>(`/athlete/${client.athleteId}/activities`, { oldest: date, newest: date, limit: "100" }),
    client.get<RecordValue[]>(`/athlete/${client.athleteId}/events`, { oldest: date, newest: date }),
  ]);
  return findCandidates(events ?? [], activities ?? [], maxGapMinutes);
}

function eventWritePayload(event: RecordValue, replacement: Replacement): RecordValue {
  const fields = [
    "category", "target", "targets", "tags", "sub_type", "color",
    "carbs_per_hour", "hide_from_athlete", "athlete_cannot_edit", "structure_read_only",
    "not_on_fitness_chart", "show_as_note", "show_on_ctl_line", "for_week",
    "training_availability", "max_training_time", "can_train_sports", "external_id", "calendar_id",
  ];
  const payload: RecordValue = {
    start_date_local: event.start_date_local,
    category: event.category ?? "WORKOUT",
    type: replacement.type,
    indoor: replacement.indoor,
    name: replacement.name,
    moving_time: replacement.moving_time,
    description: replacement.description,
  };
  for (const field of fields) if (event[field] !== undefined && event[field] !== null) payload[field] = event[field];
  return payload;
}

function originalEventWritePayload(event: RecordValue): RecordValue {
  return eventWritePayload(event, {
    activity_id: "",
    name: stringField(event, "name"),
    moving_time: plannedDuration(event),
    description: stringField(event, "description"),
    type: cyclingType(event) ?? "Ride",
    indoor: event.indoor === true,
  });
}

export function registerSplitReconciliationTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "preview_split_workout_reconciliation",
    {
      description: "Preview eligible easy continuous Ride or VirtualRide workouts split across same-day cycling activities. Requires a >=60-minute sequential workout at <=75% FTP. Completed intensity above 80% is advisory only. Read-only; default maximum gap is 90 minutes.",
      inputSchema: {
        date: z.string().describe("Athlete-local date YYYY-MM-DD"),
        max_gap_minutes: z.number().int().positive().max(720).optional().default(90),
      },
      outputSchema: {
        date: z.string(),
        max_gap_minutes: z.number().int(),
        candidates: z.array(recordSchema),
        count: z.number().int(),
      },
    },
    async ({ date, max_gap_minutes }) => {
      try {
        const resolvedGap = max_gap_minutes ?? 90;
        const candidates = await loadCandidates(client, date, resolvedGap);
        const output = await Promise.all(candidates.map(async candidate => ({
          event_id: String(candidate.event.id),
          original_name: candidate.event.name,
          original_moving_time: plannedDuration(candidate.event),
          activities: candidate.activities.map(activity => ({
            id: activity.id,
            name: activity.name,
            type: activity.type,
            start_date_local: activity.start_date_local,
            moving_time: activity.moving_time,
            elapsed_time: activity.elapsed_time,
            paired_event_id: activity.paired_event_id ?? null,
          })),
          replacements: candidate.replacements,
          classification: candidate.classification,
          eligibility_signals: candidate.eligibility_signals,
          supported: candidate.supported,
          warnings: candidate.warnings,
          advisories: candidate.advisories,
          fingerprint: await fingerprint(candidate),
        })));
        return textResult({ date, max_gap_minutes: resolvedGap, candidates: output, count: output.length });
      } catch (error) {
        return errorResult("previewing split-workout reconciliation", error);
      }
    },
  );

  server.registerTool(
    "reconcile_split_workout",
    {
      description: "Apply a previously previewed split-workout reconciliation. Mutates activities/events and requires explicit confirmation plus the current preview fingerprint.",
      inputSchema: {
        date: z.string().describe("Athlete-local date YYYY-MM-DD used for the preview"),
        event_id: z.string().describe("Original paired event ID"),
        activity_ids: z.array(z.string()).min(2).describe("Ordered activity IDs exactly as shown in the preview"),
        fingerprint: z.string().length(64).describe("Fingerprint returned by preview_split_workout_reconciliation"),
        max_gap_minutes: z.number().int().positive().max(720).optional().default(90),
        confirm: z.literal(true).describe("Must be true after the athlete explicitly approves the preview"),
      },
      outputSchema: {
        applied: z.boolean(),
        original_event_id: z.string(),
        event_ids: z.array(z.string()),
        pairings: z.array(recordSchema),
        rollback_attempted: z.boolean(),
        rollback_complete: z.boolean().nullable(),
        error: z.string().nullable(),
      },
    },
    async ({ date, event_id, activity_ids, fingerprint: expectedFingerprint, max_gap_minutes }) => {
      let originalEvent: RecordValue | null = null;
      let originalActivities: RecordValue[] = [];
      const createdEventIds: string[] = [];
      try {
        const candidates = await loadCandidates(client, date, max_gap_minutes ?? 90);
        const candidate = candidates.find(item => String(item.event.id) === event_id
          && item.activities.map(activity => String(activity.id)).join(",") === activity_ids.join(","));
        if (!candidate) throw new Error("The previewed activity cluster is no longer available.");
        if (!candidate.supported) throw new Error(`This workout cannot be reconciled safely: ${candidate.warnings.join(" ")}`);
        if (await fingerprint(candidate) !== expectedFingerprint) throw new Error("The workout or activities changed after preview. Run the preview again.");

        originalEvent = candidate.event;
        originalActivities = await Promise.all(activity_ids.map(id => client.get<RecordValue>(`/activity/${id}`)));

        for (const activity of originalActivities) {
          await client.put<RecordValue>(`/activity/${activity.id}`, { id: activity.id, paired_event_id: null });
        }

        const firstEvent = await client.put<RecordValue>(
          `/athlete/${client.athleteId}/events/${event_id}`,
          eventWritePayload(originalEvent, candidate.replacements[0]),
        );
        const eventIds = [String(firstEvent.id ?? event_id)];
        for (let index = 1; index < candidate.replacements.length; index++) {
          const created = await client.post<RecordValue>(
            `/athlete/${client.athleteId}/events`,
            eventWritePayload(originalEvent, candidate.replacements[index]),
          );
          const createdId = String(created.id);
          createdEventIds.push(createdId);
          eventIds.push(createdId);
        }

        const pairings: RecordValue[] = [];
        for (let index = 0; index < activity_ids.length; index++) {
          const updated = await client.put<RecordValue>(`/activity/${activity_ids[index]}`, {
            id: activity_ids[index],
            paired_event_id: Number(eventIds[index]),
            name: candidate.replacements[index].name,
          });
          pairings.push({
            activity_id: String(updated.id ?? activity_ids[index]),
            event_id: String(updated.paired_event_id ?? eventIds[index]),
            name: updated.name ?? candidate.replacements[index].name,
            compliance: updated.compliance ?? null,
          });
        }

        for (let index = 0; index < pairings.length; index++) {
          const verified = await client.get<RecordValue>(`/activity/${activity_ids[index]}`);
          if (String(verified.paired_event_id) !== eventIds[index] || verified.name !== candidate.replacements[index].name) {
            throw new Error(`Final verification failed for activity ${activity_ids[index]}.`);
          }
          const verifiedEvent = await client.get<RecordValue>(`/athlete/${client.athleteId}/events/${eventIds[index]}`);
          if (verifiedEvent.name !== candidate.replacements[index].name
            || numberField(verifiedEvent, "moving_time") !== candidate.replacements[index].moving_time
            || verifiedEvent.description !== candidate.replacements[index].description
            || stringField(verifiedEvent, "type") !== candidate.replacements[index].type
            || Boolean(verifiedEvent.indoor) !== candidate.replacements[index].indoor) {
            throw new Error(`Final verification failed for event ${eventIds[index]}.`);
          }
        }

        return textResult({
          applied: true,
          original_event_id: event_id,
          event_ids: eventIds,
          pairings,
          rollback_attempted: false,
          rollback_complete: null,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!originalEvent || !originalActivities.length) {
          return textResult({ applied: false, original_event_id: event_id, event_ids: [], pairings: [], rollback_attempted: false, rollback_complete: null, error: message });
        }
        let rollbackComplete = true;
        for (const createdId of createdEventIds) {
          try { await client.delete(`/athlete/${client.athleteId}/events/${createdId}`); } catch { rollbackComplete = false; }
        }
        try {
          await client.put<RecordValue>(`/athlete/${client.athleteId}/events/${event_id}`, originalEventWritePayload(originalEvent));
        } catch { rollbackComplete = false; }
        for (const activity of originalActivities) {
          try {
            await client.put<RecordValue>(`/activity/${activity.id}`, {
              id: activity.id,
              paired_event_id: activity.paired_event_id ?? null,
              name: activity.name,
            });
          } catch { rollbackComplete = false; }
        }
        return textResult({ applied: false, original_event_id: event_id, event_ids: [], pairings: [], rollback_attempted: true, rollback_complete: rollbackComplete, error: message });
      }
    },
  );
}
