import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { errorResult, structuredResult, type ToolTextResult } from "./result.js";

type R = Record<string, unknown>;
type Discipline = "BIKE" | "RUN" | "SWIM";

const disciplineSchema = z.enum(["BIKE", "RUN", "SWIM"]);
const activitySchema = z.record(z.string(), z.unknown());
const DAY = 864e5;

function isoDay(date = new Date()): string { return date.toISOString().slice(0, 10); }
function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}
function num(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function canonical(type: unknown): Discipline | null {
  const value = String(type ?? "");
  if (["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "TrackRide", "Cyclocross"].includes(value)) return "BIKE";
  if (["Run", "VirtualRun", "TrailRun"].includes(value)) return "RUN";
  if (["Swim", "OpenWaterSwim"].includes(value)) return "SWIM";
  return null;
}
function localDay(activity: R): string | null {
  const value = activity.start_date_local ?? activity.start_date;
  return typeof value === "string" ? value.slice(0, 10) : null;
}
function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function pct(current: number | null, baseline: number | null): number | null {
  return current == null || baseline == null || baseline === 0 ? null : ((current - baseline) / baseline) * 100;
}
function compactActivity(activity: R): R {
  return {
    id: String(activity.id ?? ""), name: activity.name ?? null, type: activity.type ?? null,
    discipline: canonical(activity.type), start_date_local: activity.start_date_local ?? null,
    duration_seconds: activity.moving_time ?? null, distance_meters: activity.distance ?? activity.icu_distance ?? null,
    training_load: activity.icu_training_load ?? null, intensity: activity.icu_intensity ?? null,
    average_hr_bpm: activity.average_heartrate ?? null, max_hr_bpm: activity.max_heartrate ?? null,
    average_power_watts: activity.icu_average_watts ?? null, weighted_power_watts: activity.icu_weighted_avg_watts ?? null,
    pace_mps: activity.pace ?? null, efficiency_factor: activity.icu_efficiency_factor ?? null,
    decoupling_percent: activity.decoupling ?? null, variability_index: activity.icu_variability_index ?? null,
    cadence: activity.average_cadence ?? null, ftp_used: activity.icu_ftp ?? null,
    threshold_pace_mps: activity.threshold_pace ?? null, trainer: activity.trainer ?? null,
    route_id: activity.route_id ?? null, tags: Array.isArray(activity.tags) ? activity.tags : [],
    average_weather_temp: activity.average_weather_temp ?? null,
    average_wind_speed: activity.average_wind_speed ?? null,
    max_rain: activity.max_rain ?? null,
  };
}
function sessionFamily(activity: R): string {
  if (activity.race === true) return "RACE";
  const intensity = num(activity.icu_intensity);
  if (intensity == null) return "UNCLASSIFIED";
  if (intensity < 60) return "RECOVERY";
  if (intensity < 80) return "ENDURANCE";
  if (intensity < 90) return "TEMPO";
  if (intensity <= 105) return "THRESHOLD";
  return "HIGH_INTENSITY";
}
function scoreCandidate(target: R, candidate: R, mode: string, tolerance: number): { score: number; components: R; reasons: string[] } | null {
  const targetDiscipline = canonical(target.type);
  if (!targetDiscipline || canonical(candidate.type) !== targetDiscipline) return null;
  const targetTrainer = target.trainer === true;
  if ((candidate.trainer === true) !== targetTrainer) return null;
  const targetTags = Array.isArray(target.tags) ? target.tags.map(String) : [];
  const candidateTags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : [];
  const targetDuration = num(target.moving_time); const candidateDuration = num(candidate.moving_time);
  const durationDiff = targetDuration && candidateDuration ? Math.abs(candidateDuration - targetDuration) / targetDuration * 100 : null;
  const durationScore = durationDiff == null ? null : Math.max(0, 100 * (1 - durationDiff / tolerance));
  const targetIntensity = num(target.icu_intensity); const candidateIntensity = num(candidate.icu_intensity);
  const intensityScore = targetIntensity == null || candidateIntensity == null ? null : Math.max(0, 100 - Math.abs(targetIntensity - candidateIntensity) * 4);
  const sessionScore = sessionFamily(target) === sessionFamily(candidate) ? 100 : 0;
  const routeMatch = target.route_id != null && target.route_id === candidate.route_id;
  if (mode === "SAME_ROUTE" && !routeMatch) return null;
  const tagScore = targetTags.length ? (targetTags.every(tag => candidateTags.includes(tag)) ? 100 : 0) : null;
  const weights = mode === "SAME_SESSION_TYPE"
    ? { session: 50, duration: 20, intensity: 15, route: 10, tags: 5 }
    : mode === "SAME_DURATION"
      ? { session: 25, duration: 50, intensity: 15, route: 5, tags: 5 }
      : mode === "SAME_ROUTE"
        ? { session: 15, duration: 15, intensity: 10, route: 60, tags: 0 }
        : { session: 30, duration: 25, intensity: 20, route: 10, tags: 5 };
  const values: R = { session: sessionScore, duration: durationScore, intensity: intensityScore, route: target.route_id == null ? null : routeMatch ? 100 : 0, tags: tagScore };
  let weighted = 0; let available = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const value = num(values[key]);
    if (value != null && weight > 0) { weighted += value * weight; available += weight; }
  }
  if (!available) return null;
  const score = weighted / available;
  return { score, components: { ...values, duration_difference_percent: durationDiff }, reasons: [
    `same ${targetDiscipline.toLowerCase()} discipline`, targetTrainer ? "both indoor" : "both outdoor",
    sessionFamily(target) === sessionFamily(candidate) ? `same ${sessionFamily(target).toLowerCase()} session family` : "different session family",
  ] };
}
function verdict(target: number | null, comparison: number | null, thresholdPercent = 3, lowerIsBetter = false): R {
  if (target == null || comparison == null || comparison === 0) return { status: "MISSING", target, comparison, change_percent: null };
  const change = ((target - comparison) / Math.abs(comparison)) * 100;
  const adjusted = lowerIsBetter ? -change : change;
  return { target, comparison, change_percent: change, status: adjusted >= thresholdPercent ? "IMPROVED" : adjusted <= -thresholdPercent ? "DECLINED" : "STABLE" };
}
function dailyLoads(activities: R[], discipline: Discipline, start: string, end: string): number[] {
  const byDay = new Map<string, number>();
  for (const activity of activities) {
    if (canonical(activity.type) !== discipline) continue;
    const day = localDay(activity); const load = num(activity.icu_training_load);
    if (day && load != null) byDay.set(day, (byDay.get(day) ?? 0) + load);
  }
  const values: number[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) values.push(byDay.get(day) ?? 0);
  return values;
}
function loadModel(loads: number[]): R {
  let ctl = 0; let atl = 0; const ctlFactor = 1 - Math.exp(-1 / 42); const atlFactor = 1 - Math.exp(-1 / 7);
  const history: R[] = [];
  for (const load of loads) { ctl += (load - ctl) * ctlFactor; atl += (load - atl) * atlFactor; history.push({ ctl, atl }); }
  const previous = history[Math.max(0, history.length - 8)] as R | undefined;
  return { estimated_ctl: ctl, estimated_atl: atl, estimated_tsb: ctl - atl, ramp_rate: ctl - (num(previous?.ctl) ?? ctl), initialization_days: loads.length };
}
function compactCurveEvidence(data: R, pace: boolean): R {
  const axis = (Array.isArray(data.secs) ? data.secs : Array.isArray(data.distances) ? data.distances : []) as number[];
  const curves = Array.isArray(data.curves) ? data.curves as R[] : [];
  const bests = axis.map((point, index) => {
    const candidates = curves.flatMap(curve => {
      const values = (pace ? curve.secs : curve.watts) as unknown[] | undefined;
      const value = Array.isArray(values) ? num(values[index]) : null;
      return value == null ? [] : [{ value, activity_id: String(curve.id ?? ""), start_date_local: curve.start_date_local ?? null }];
    });
    if (!candidates.length) return { axis: point, value: null, activity_id: null, start_date_local: null };
    const best = candidates.reduce((selected, candidate) => pace
      ? candidate.value < selected.value ? candidate : selected
      : candidate.value > selected.value ? candidate : selected);
    return { axis: point, ...best };
  });
  return { axis_type: pace ? "distance_meters" : "duration_seconds", bests, activity_count: curves.length };
}
function signal(latest: number | null, baseline: number | null, kind: "HRV" | "RHR"): R {
  const change = pct(latest, baseline);
  if (latest == null || baseline == null) return { status: "MISSING", latest, baseline, change_percent: change };
  const caution = kind === "HRV" ? change! <= -10 : latest - baseline >= 5;
  const severe = kind === "HRV" ? change! <= -20 : latest - baseline >= 8;
  return { latest, baseline, change_percent: change, status: severe ? "SEVERE" : caution ? "CAUTION" : "NORMAL" };
}
async function safeResult(label: string, fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
  try { return await fn(); } catch (error) { return errorResult(label, error); }
}

export function registerAnalysisTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool("compare_similar_activities", {
    description: "Compare an activity with genuinely similar recent sessions using summary metrics and explicit compatibility checks.",
    inputSchema: {
      activity_id: z.string().optional(), sport: disciplineSchema.optional(), lookback_days: z.number().int().min(14).max(365).optional().default(90),
      comparison_count: z.number().int().min(1).max(10).optional().default(3),
      comparison_mode: z.enum(["AUTO", "SAME_SESSION_TYPE", "SAME_DURATION", "SAME_ROUTE"]).optional().default("AUTO"),
      duration_tolerance_percent: z.number().min(5).max(100).optional().default(25),
      include_weather_context: z.boolean().optional().default(true), tags: z.array(z.string()).optional(),
    }, outputSchema: { target: activitySchema, comparisons: z.array(activitySchema), overall_verdict: z.string(), confidence: z.string(), caveats: z.array(z.string()) },
  }, async ({ activity_id, sport, lookback_days, comparison_count, comparison_mode, duration_tolerance_percent, include_weather_context, tags }) => safeResult("comparing similar activities", async () => {
    const end = isoDay(); const start = addDays(end, -lookback_days);
    const activities = await client.get<R[]>(`/athlete/${client.athleteId}/activities`, { oldest: start, newest: end, limit: "250" });
    const sorted = [...(activities ?? [])].sort((a, b) => String(b.start_date_local ?? "").localeCompare(String(a.start_date_local ?? "")));
    const target = activity_id ? sorted.find(activity => String(activity.id) === activity_id) : sorted.find(activity => !sport || canonical(activity.type) === sport);
    if (!target) throw new Error("Target activity was not found in the selected lookback period.");
    if (sport && canonical(target.type) !== sport) throw new Error("sport does not match the target activity.");
    const targetWithTags = tags?.length ? { ...target, tags } : target;
    const candidates = sorted.flatMap(candidate => {
      if (String(candidate.id) === String(target.id)) return [];
      const match = scoreCandidate(targetWithTags, candidate, comparison_mode, duration_tolerance_percent);
      return match && match.score >= 60 ? [{ activity: candidate, ...match }] : [];
    }).sort((a, b) => b.score - a.score).slice(0, comparison_count);
    const primary = candidates[0]?.activity;
    const targetCompact = compactActivity(target);
    const comparisonOutput = candidates.map(candidate => ({ ...compactActivity(candidate.activity), similarity_score: candidate.score, score_components: candidate.components, selection_reasons: candidate.reasons }));
    const metricVerdicts = {
      efficiency_factor: verdict(num(target.icu_efficiency_factor), primary ? num(primary.icu_efficiency_factor) : null),
      decoupling: verdict(num(target.decoupling), primary ? num(primary.decoupling) : null, 1.5, true),
      variability_index: verdict(num(target.icu_variability_index), primary ? num(primary.icu_variability_index) : null, 2, true),
      power: verdict(num(target.icu_weighted_avg_watts), primary ? num(primary.icu_weighted_avg_watts) : null),
      pace: verdict(num(target.pace), primary ? num(primary.pace) : null),
    };
    const statuses = Object.values(metricVerdicts).map(value => String((value as R).status));
    const improved = statuses.filter(status => status === "IMPROVED").length; const declined = statuses.filter(status => status === "DECLINED").length;
    const overall = !candidates.length ? "INSUFFICIENT_DATA" : improved >= 2 && improved > declined ? "IMPROVED" : declined >= 2 && declined > improved ? "DECLINED" : improved && declined ? "MIXED" : "STABLE";
    const caveats = [
      "Summary metrics only; no streams or interval details were fetched.",
      include_weather_context ? "Weather uses stored activity summary fields when available." : "Weather context was not requested.",
      num(target.icu_ftp) != null && primary && num(primary.icu_ftp) != null && Math.abs(num(target.icu_ftp)! - num(primary.icu_ftp)!) / num(primary.icu_ftp)! > .02 ? "FTP changed by more than 2%; zone-relative comparisons are not directly comparable." : null,
    ].filter((value): value is string => Boolean(value));
    return structuredResult(`Compared ${String(target.name ?? target.id)} with ${candidates.length} similar activities: ${overall}.`, {
      target: { ...targetCompact, session_family: sessionFamily(target) }, comparisons: comparisonOutput,
      metric_verdicts: metricVerdicts, overall_verdict: overall,
      confidence: candidates.length >= 3 ? "MODERATE" : candidates.length ? "LOW" : "INSUFFICIENT",
      evidence_activity_ids: [String(target.id), ...candidates.map(candidate => String(candidate.activity.id))], caveats,
    });
  }));

  server.registerTool("get_training_readiness", {
    description: "Compact advisory readiness snapshot combining wellness trends, discipline-specific load estimates, and planned demand.",
    inputSchema: { date: z.string().optional(), wellness_lookback_days: z.number().int().min(7).max(42).optional().default(14), activity_lookback_days: z.number().int().min(14).max(90).optional().default(42), planned_lookahead_days: z.number().int().min(0).max(14).optional().default(7), sport: z.union([disciplineSchema, z.literal("ALL")]).optional().default("ALL"), include_upcoming_load: z.boolean().optional().default(true) },
    outputSchema: { status: z.string(), confidence: z.string(), systemic_recovery: activitySchema, discipline_load: z.array(activitySchema), caveats: z.array(z.string()) },
  }, async ({ date, wellness_lookback_days, activity_lookback_days, planned_lookahead_days, sport, include_upcoming_load }) => safeResult("calculating training readiness", async () => {
    const assessment = date ?? isoDay(); const seedStart = addDays(assessment, -180); const wellnessStart = addDays(assessment, -42);
    const [wellness, activities, events] = await Promise.all([
      client.get<R[]>(`/athlete/${client.athleteId}/wellness`, { oldest: wellnessStart, newest: assessment }),
      client.get<R[]>(`/athlete/${client.athleteId}/activities`, { oldest: seedStart, newest: assessment, limit: "500" }),
      include_upcoming_load ? client.get<R[]>(`/athlete/${client.athleteId}/events`, { oldest: assessment, newest: addDays(assessment, planned_lookahead_days) }) : Promise.resolve([]),
    ]);
    const entries = [...(wellness ?? [])].sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")));
    const latest = entries.find(entry => String(entry.id) === assessment) ?? entries.at(-1) ?? {};
    const prior = entries.filter(entry => String(entry.id ?? "") < assessment).slice(-28);
    const hrv = signal(num(latest.hrv), median(prior.map(entry => num(entry.hrv)).filter((v): v is number => v != null)), "HRV");
    const rhr = signal(num(latest.restingHR), median(prior.map(entry => num(entry.restingHR)).filter((v): v is number => v != null)), "RHR");
    const sleepHours = num(latest.sleepSecs) == null ? null : num(latest.sleepSecs)! / 3600;
    const sleepStatus = sleepHours == null ? "MISSING" : sleepHours < 5 ? "SEVERE" : sleepHours < 6 ? "CAUTION" : "NORMAL";
    const disciplines: Discipline[] = sport === "ALL" ? ["BIKE", "RUN", "SWIM"] : [sport];
    const load: R[] = disciplines.map(discipline => {
      const loads = dailyLoads(activities ?? [], discipline, seedStart, addDays(assessment, -1));
      const model = loadModel(loads);
      const recent = dailyLoads(activities ?? [], discipline, addDays(assessment, -42), addDays(assessment, -1));
      return { discipline, ...model, load_7_days: recent.slice(-7).reduce((a, b) => a + b, 0), load_14_days: recent.slice(-14).reduce((a, b) => a + b, 0), load_42_days: recent.reduce((a, b) => a + b, 0) };
    });
    const severe = [hrv, rhr].filter(value => value.status === "SEVERE").length + (sleepStatus === "SEVERE" ? 1 : 0) + (num(latest.injury) != null && num(latest.injury)! >= 7 ? 1 : 0);
    const cautions = [hrv, rhr].filter(value => value.status === "CAUTION").length + (sleepStatus === "CAUTION" ? 1 : 0) + (num(latest.injury) != null && num(latest.injury)! > 0 ? 1 : 0) + load.filter(value => num(value.estimated_tsb)! < -10 || num(value.ramp_rate)! > 7).length;
    const status = severe >= 2 || (num(latest.injury) ?? 0) >= 7 ? "REST_RECOMMENDED" : severe || cautions >= 2 ? "CAUTION" : cautions ? "MODERATE" : entries.length >= 7 ? "READY" : "INSUFFICIENT_DATA";
    const upcoming = (events ?? []).map(event => ({ id: String(event.id ?? ""), name: event.name ?? null, type: event.type ?? null, date: localDay(event), training_load: event.icu_training_load ?? event.load_target ?? null, intensity: event.icu_intensity ?? null }));
    return structuredResult(`Readiness for ${assessment}: ${status}.`, {
      status, confidence: entries.length >= 28 && (activities?.length ?? 0) > 20 ? "MODERATE" : "LOW",
      systemic_recovery: { hrv, resting_hr: rhr, sleep_hours: sleepHours, sleep_status: sleepStatus, device_readiness: latest.readiness ?? null, injury: latest.injury ?? null, fatigue: latest.fatigue ?? null, soreness: latest.soreness ?? null },
      intervals_aggregate: { ctl: latest.ctl ?? null, atl: latest.atl ?? null, ramp_rate: latest.rampRate ?? null },
      discipline_load: load, upcoming_sessions: upcoming, evidence_activity_count: activities?.length ?? 0,
      caveats: ["Discipline CTL, ATL, and TSB are server estimates derived from activity load, not Intervals.icu values.", `Wellness reporting window: ${wellness_lookback_days} days; activity summary window: ${activity_lookback_days} days.`],
    });
  }));

  server.registerTool("get_discipline_trends", {
    description: "Summarize 4-, 8-, and 12-week swim, bike, and run trends with compact curve evidence.",
    inputSchema: { lookback_days: z.number().int().min(28).max(365).optional().default(84), disciplines: z.array(disciplineSchema).optional().default(["BIKE", "RUN", "SWIM"]), windows_weeks: z.array(z.union([z.literal(4), z.literal(8), z.literal(12)])).optional().default([4, 8, 12]), include_efficiency_trends: z.boolean().optional().default(true), include_durability_trends: z.boolean().optional().default(true), minimum_sessions_per_period: z.number().int().min(1).max(10).optional().default(3) },
    outputSchema: { disciplines: z.array(activitySchema), confidence: z.string(), caveats: z.array(z.string()) },
  }, async ({ lookback_days, disciplines, windows_weeks, include_efficiency_trends, include_durability_trends, minimum_sessions_per_period }) => safeResult("calculating discipline trends", async () => {
    const end = isoDay(); const start = addDays(end, -Math.max(180, lookback_days * 2));
    const activities = await client.get<R[]>(`/athlete/${client.athleteId}/activities`, { oldest: start, newest: end, limit: "500" });
    const results = await Promise.all(disciplines.map(async discipline => {
      const relevant = (activities ?? []).filter(activity => canonical(activity.type) === discipline);
      const windows = windows_weeks.map(weeks => {
        const days = weeks * 7; const currentStart = addDays(end, -days + 1); const previousStart = addDays(currentStart, -days);
        const current = relevant.filter(activity => { const day = localDay(activity); return day != null && day >= currentStart && day <= end; });
        const previous = relevant.filter(activity => { const day = localDay(activity); return day != null && day >= previousStart && day < currentStart; });
        const summary = (items: R[]) => ({ sessions: items.length, hours: items.reduce((sum, item) => sum + (num(item.moving_time) ?? 0), 0) / 3600, distance_meters: items.reduce((sum, item) => sum + (num(item.distance) ?? 0), 0), training_load: items.reduce((sum, item) => sum + (num(item.icu_training_load) ?? 0), 0), longest_duration_seconds: Math.max(0, ...items.map(item => num(item.moving_time) ?? 0)) });
        const currentSummary = summary(current); const previousSummary = summary(previous);
        const currentEndurance = current.filter(activity => sessionFamily(activity) === "ENDURANCE"); const previousEndurance = previous.filter(activity => sessionFamily(activity) === "ENDURANCE");
        const efficiency = include_efficiency_trends && currentEndurance.length >= minimum_sessions_per_period && previousEndurance.length >= minimum_sessions_per_period
          ? verdict(median(currentEndurance.map(activity => num(activity.icu_efficiency_factor)).filter((v): v is number => v != null)), median(previousEndurance.map(activity => num(activity.icu_efficiency_factor)).filter((v): v is number => v != null)))
          : { status: "INSUFFICIENT_DATA" };
        const longSeconds = discipline === "BIKE" ? 5400 : discipline === "RUN" ? 3600 : 2700;
        const durability = include_durability_trends ? verdict(median(current.filter(activity => (num(activity.moving_time) ?? 0) >= longSeconds).map(activity => num(activity.decoupling)).filter((v): v is number => v != null)), median(previous.filter(activity => (num(activity.moving_time) ?? 0) >= longSeconds).map(activity => num(activity.decoupling)).filter((v): v is number => v != null)), 1.5, true) : { status: "NOT_REQUESTED" };
        return { weeks, current: currentSummary, previous: previousSummary, load_change: verdict(currentSummary.training_load, previousSummary.training_load), efficiency_factor: efficiency, durability_decoupling: durability };
      });
      const curvePath = discipline === "BIKE" ? "activity-power-curves" : "activity-pace-curves";
      const largest = Math.max(...windows_weeks) * 7; const currentStart = addDays(end, -largest + 1); const previousEnd = addDays(currentStart, -1); const previousStart = addDays(currentStart, -largest);
      const params: Record<string, string> = discipline === "BIKE" ? { type: "Ride", oldest: currentStart, newest: end, secs: "300,1200,1800,3600" } : { type: discipline === "RUN" ? "Run" : "Swim", oldest: currentStart, newest: end, distances: discipline === "RUN" ? "1000,5000,10000,21097" : "200,400,800,1500" };
      const previousParams = { ...params, oldest: previousStart, newest: previousEnd };
      const [currentCurve, previousCurve] = await Promise.all([client.get<R>(`/athlete/${client.athleteId}/${curvePath}`, params), client.get<R>(`/athlete/${client.athleteId}/${curvePath}`, previousParams)]);
      return { discipline, windows, curve_evidence: { current: compactCurveEvidence(currentCurve, discipline !== "BIKE"), previous: compactCurveEvidence(previousCurve, discipline !== "BIKE") }, evidence_activity_ids: relevant.map(activity => String(activity.id)) };
    }));
    return structuredResult(`Discipline trends calculated for ${disciplines.join(", ")}.`, { disciplines: results, confidence: (activities?.length ?? 0) >= 30 ? "MODERATE" : "LOW", caveats: ["Efficiency and durability use activity summary metrics only; streams were not fetched.", "Curve evidence is date-bounded raw activity-curve evidence; use activity IDs for deeper inspection."] });
  }));
}
