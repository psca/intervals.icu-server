import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addDays, canonicalDiscipline, compareActivityContexts, hasSufficientEvidence, isoDay,
  leastSquaresSlope, loadSpike, loadTrend, median, numberValue, percentChange,
  preferredZoneDistribution, recordDay, sessionFamily, zoneDistributionSimilarity,
  zoneIntentSimilarity, type AnalysisRecord as R, type Discipline,
} from "../analysis.js";
import { IntervalsClient } from "../client.js";
import { errorResult, structuredResult, type ToolTextResult } from "./result.js";

const disciplineSchema = z.enum(["BIKE", "RUN", "SWIM"]);
const recordSchema = z.record(z.string(), z.unknown());
const COMPATIBILITY_THRESHOLD = 70;

function compactActivity(activity: R): R {
  return {
    id: String(activity.id ?? ""), name: activity.name ?? null, type: activity.type ?? null,
    discipline: canonicalDiscipline(activity.type), start_date_local: activity.start_date_local ?? null,
    duration_seconds: activity.moving_time ?? null, distance_meters: activity.distance ?? activity.icu_distance ?? null,
    training_load: activity.icu_training_load ?? null, intensity: activity.icu_intensity ?? null,
    average_hr_bpm: activity.average_heartrate ?? null, max_hr_bpm: activity.max_heartrate ?? null,
    average_power_watts: activity.icu_average_watts ?? null, weighted_power_watts: activity.icu_weighted_avg_watts ?? null,
    pace_mps: activity.pace ?? null, efficiency_factor: activity.icu_efficiency_factor ?? null,
    decoupling_percent: activity.decoupling ?? null, variability_index: activity.icu_variability_index ?? null,
    cadence: activity.average_cadence ?? null, ftp_used: activity.icu_ftp ?? null,
    threshold_pace_mps: activity.threshold_pace ?? null, trainer: activity.trainer ?? null,
    route_id: activity.route_id ?? null, tags: Array.isArray(activity.tags) ? activity.tags : [],
    average_weather_temp: activity.average_weather_temp ?? null, average_wind_speed: activity.average_wind_speed ?? null,
    max_rain: activity.max_rain ?? null,
  };
}

type CandidateScore = { score: number; components: R; reasons: string[]; usedZoneFallback: boolean };

function scoreCandidate(target: R, candidate: R, mode: string, tolerance: number): CandidateScore | null {
  const discipline = canonicalDiscipline(target.type);
  if (!discipline || canonicalDiscipline(candidate.type) !== discipline) return null;
  const indoor = target.trainer === true;
  if ((candidate.trainer === true) !== indoor) return null;
  const targetDuration = numberValue(target.moving_time); const candidateDuration = numberValue(candidate.moving_time);
  const durationDiff = targetDuration && candidateDuration ? Math.abs(candidateDuration - targetDuration) / targetDuration * 100 : null;
  const duration = durationDiff == null ? null : Math.max(0, 100 * (1 - durationDiff / tolerance));
  const targetIntensity = numberValue(target.icu_intensity); const candidateIntensity = numberValue(candidate.icu_intensity);
  const intensity = targetIntensity == null || candidateIntensity == null ? null : Math.max(0, 100 - Math.abs(targetIntensity - candidateIntensity) * 4);
  const family = sessionFamily(target) === sessionFamily(candidate) ? 100 : 0;
  const routeMatch = target.route_id != null && target.route_id === candidate.route_id;
  if (mode === "SAME_ROUTE" && !routeMatch) return null;
  const distribution = zoneDistributionSimilarity(target, candidate, discipline);
  const intent = zoneIntentSimilarity(target, candidate);
  const zone = distribution?.score ?? intent?.score ?? null;
  const usedZoneFallback = mode === "SAME_SESSION_TYPE" && zone == null;
  const weights = mode === "SAME_SESSION_TYPE"
    ? { zone: 45, family: 20, duration: 15, intensity: 10, route: 5 }
    : mode === "SAME_DURATION"
      ? { zone: 10, family: 20, duration: 50, intensity: 15, route: 5 }
      : mode === "SAME_ROUTE"
        ? { zone: 10, family: 10, duration: 10, intensity: 10, route: 60 }
        : { zone: 20, family: 25, duration: 25, intensity: 20, route: 10 };
  const values: Record<string, number | null> = { zone, family, duration, intensity, route: target.route_id == null ? null : routeMatch ? 100 : 0 };
  let weighted = 0; let available = 0;
  for (const [key, weight] of Object.entries(weights)) {
    let value = values[key];
    if (mode === "SAME_SESSION_TYPE" && key === "zone" && value == null) value = (family + (intensity ?? family)) / 2;
    if (value != null && weight > 0) { weighted += value * weight; available += weight; }
  }
  if (!available) return null;
  return {
    score: weighted / available,
    components: {
      session_family: family, duration, duration_difference_percent: durationDiff, intensity,
      route: target.route_id == null ? null : routeMatch ? 100 : 0,
      zone_distribution: distribution?.score ?? null, zone_source: distribution?.source ?? null,
      zone_intent: intent?.score ?? null, zone_intent_match: intent?.match ?? null,
      zone_fallback_used: usedZoneFallback,
    },
    reasons: [
      `same ${discipline.toLowerCase()} discipline`, indoor ? "both indoor" : "both outdoor",
      family === 100 ? `same ${sessionFamily(target).toLowerCase()} session family` : "different session family",
      distribution ? `similar normalized ${distribution.source.toLowerCase()} zone distribution` : intent ? `${intent.match.toLowerCase()} zone intent match` : "zone data unavailable; used family and intensity fallback",
    ],
    usedZoneFallback,
  };
}

type MetricDefinition = { key: string; field: string; lowerIsBetter?: boolean; threshold?: number };

function comparisonMetrics(target: R, mode: string, selected: R[]): { included: MetricDefinition[]; excluded: R[] } {
  const discipline = canonicalDiscipline(target.type);
  const included: MetricDefinition[] = [
    { key: "efficiency_factor", field: "icu_efficiency_factor" },
    { key: "decoupling", field: "decoupling", lowerIsBetter: true, threshold: 1.5 },
    { key: "variability_index", field: "icu_variability_index", lowerIsBetter: true, threshold: 2 },
  ];
  const excluded: R[] = [];
  if (discipline === "BIKE") {
    included.push({ key: "power", field: "icu_weighted_avg_watts" });
    const sharedRoute = mode === "SAME_ROUTE" && target.route_id != null && selected.every(activity => activity.route_id === target.route_id);
    if (sharedRoute) included.push({ key: "speed", field: "pace" });
    else excluded.push({ metric: "speed", reason: "Bike speed is informational and only affects verdicts for SAME_ROUTE comparisons with a shared non-null route ID." });
    excluded.push({ metric: "pace", reason: "Cycling pace/speed is represented as informational speed evidence." });
  } else {
    included.push({ key: "pace", field: "pace" });
    excluded.push({ metric: "power", reason: `Power is not the sport-appropriate primary output for ${discipline?.toLowerCase() ?? "this"} activities.` });
  }
  return { included, excluded };
}

function metricVerdict(target: number | null, comparison: number | null, threshold = 3, lowerIsBetter = false): R {
  const change = percentChange(target, comparison);
  if (target == null || comparison == null || change == null) return { status: "MISSING", target, comparison, change_percent: change };
  const adjusted = lowerIsBetter ? -change : change;
  return { target, comparison, change_percent: change, status: adjusted >= threshold ? "IMPROVED" : adjusted <= -threshold ? "DECLINED" : "STABLE" };
}

function metricReferences(target: R, candidates: { activity: R }[], definitions: MetricDefinition[]): { references: R; verdicts: R } {
  const selected = candidates.map(candidate => candidate.activity);
  const recent = [...selected].sort((a, b) => String(b.start_date_local ?? "").localeCompare(String(a.start_date_local ?? "")))[0] ?? null;
  const selectedMedian: R = {};
  const bestByMetric: R = {};
  const verdicts: R = {};
  for (const definition of definitions) {
    const values = selected.flatMap(activity => {
      const value = numberValue(activity[definition.field]);
      return value == null ? [] : [{ activity, value }];
    });
    selectedMedian[definition.key] = median(values.map(item => item.value));
    const best = values.reduce<{ activity: R; value: number } | null>((chosen, item) => {
      if (!chosen) return item;
      return definition.lowerIsBetter ? item.value < chosen.value ? item : chosen : item.value > chosen.value ? item : chosen;
    }, null);
    bestByMetric[definition.key] = best ? { activity_id: String(best.activity.id ?? ""), value: best.value } : { activity_id: null, value: null };
    const targetValue = numberValue(target[definition.field]);
    verdicts[definition.key] = {
      most_recent: metricVerdict(targetValue, recent ? numberValue(recent[definition.field]) : null, definition.threshold, definition.lowerIsBetter),
      selected_median: metricVerdict(targetValue, numberValue(selectedMedian[definition.key]), definition.threshold, definition.lowerIsBetter),
    };
  }
  return {
    references: {
      most_recent: recent ? {
        activity_id: String(recent.id ?? ""), start_date_local: recent.start_date_local ?? null,
        metrics: Object.fromEntries(definitions.map(definition => [definition.key, numberValue(recent[definition.field])])),
      } : null,
      selected_median: selectedMedian,
      best_by_metric: bestByMetric,
    }, verdicts,
  };
}

function overallComparison(candidates: number, metricVerdicts: R): string {
  if (candidates < 2) return "NOT_COMPARABLE";
  const statuses = Object.values(metricVerdicts).map(value => String(((value as R).selected_median as R).status));
  const valid = statuses.filter(status => status !== "MISSING");
  if (valid.length < 2) return "INSUFFICIENT_DATA";
  const directional = valid.filter(status => status === "IMPROVED" || status === "DECLINED");
  if (directional.length < 2) return valid.filter(status => status === "STABLE").length >= 2 ? "STABLE" : "INSUFFICIENT_DATA";
  const improved = directional.filter(status => status === "IMPROVED").length;
  const declined = directional.length - improved;
  if (improved / directional.length >= .6) return "IMPROVED";
  if (declined / directional.length >= .6) return "DECLINED";
  return "MIXED";
}

function dailyLoads(activities: R[], discipline: Discipline, start: string, end: string): number[] {
  const byDay = new Map<string, number>();
  for (const activity of activities) {
    if (canonicalDiscipline(activity.type) !== discipline) continue;
    const day = recordDay(activity); const load = numberValue(activity.icu_training_load);
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
  const previous = history[Math.max(0, history.length - 8)];
  return { estimated_ctl: ctl, estimated_atl: atl, estimated_tsb: ctl - atl, ramp_rate: ctl - (numberValue(previous?.ctl) ?? ctl), initialization_days: loads.length };
}

function hrvAnalysis(entries: R[], assessment: string): R {
  const available = entries.filter(entry => recordDay(entry) != null && recordDay(entry)! <= assessment && numberValue(entry.hrv) != null);
  const latestEntry = available.at(-1); const latest = numberValue(latestEntry?.hrv);
  const last7 = available.slice(-7).map(entry => numberValue(entry.hrv)!).filter(value => value != null);
  const last28 = available.slice(-28).map(entry => numberValue(entry.hrv)!).filter(value => value != null);
  const average7 = last7.length ? last7.reduce((sum, value) => sum + value, 0) / last7.length : null;
  const baseline = median(last28); const slope = leastSquaresSlope(last7);
  const normalizedSlope = slope != null && baseline ? slope / baseline * 100 : null;
  let streak = 0;
  if (baseline != null) for (const entry of [...available].reverse()) {
    const value = numberValue(entry.hrv); if (value == null || value >= baseline) break; streak += 1;
  }
  const versusBaseline = percentChange(latest, baseline);
  const status = versusBaseline == null ? "MISSING" : versusBaseline <= -20 ? "SEVERE" : versusBaseline <= -10 ? "CAUTION" : "NORMAL";
  const trend = normalizedSlope == null ? "INSUFFICIENT_DATA" : normalizedSlope > 1 ? "RECOVERING" : normalizedSlope < -1 ? "WORSENING" : "STABLE";
  return { latest, average_7_days: average7, baseline_28_day_median: baseline, latest_vs_7_day_average_percent: percentChange(latest, average7), latest_vs_baseline_percent: versusBaseline, consecutive_below_baseline_days: streak, slope_7_day_per_day: slope, normalized_slope_percent_of_baseline_per_day: normalizedSlope, trend, status };
}

function restingHrAnalysis(entries: R[], assessment: string): R {
  const available = entries.filter(entry => recordDay(entry) != null && recordDay(entry)! <= assessment && numberValue(entry.restingHR) != null);
  const latest = numberValue(available.at(-1)?.restingHR); const baseline = median(available.slice(-28).map(entry => numberValue(entry.restingHR)!).filter(value => value != null));
  const deviation = latest == null || baseline == null ? null : latest - baseline;
  const status = deviation == null ? "MISSING" : deviation >= 8 ? "SEVERE" : deviation >= 5 ? "CAUTION" : "NORMAL";
  const range = deviation == null ? "INSUFFICIENT_DATA" : deviation < 0 ? "LOW" : deviation < 1 ? "NORMAL_RANGE" : deviation <= 4 ? "MILDLY_ELEVATED" : "ELEVATED";
  return { latest, baseline_28_day_median: baseline, change_percent: percentChange(latest, baseline), deviation_bpm: deviation, range, status };
}

function periodSummary(items: R[]): R {
  return {
    sessions: items.length,
    hours: items.reduce((sum, item) => sum + (numberValue(item.moving_time) ?? 0), 0) / 3600,
    distance_meters: items.reduce((sum, item) => sum + (numberValue(item.distance ?? item.icu_distance) ?? 0), 0),
    training_load: items.reduce((sum, item) => sum + (numberValue(item.icu_training_load) ?? 0), 0),
    longest_duration_seconds: Math.max(0, ...items.map(item => numberValue(item.moving_time) ?? 0)),
  };
}

function efficiencyCohort(items: R[]): { included: R[]; excluded: R[] } {
  const durationMedian = median(items.map(item => numberValue(item.moving_time)).filter((value): value is number => value != null));
  const included: R[] = []; const excluded: R[] = [];
  for (const activity of items) {
    const reasons: string[] = [];
    if (sessionFamily(activity) === "RACE") reasons.push("race");
    if (durationMedian != null && (numberValue(activity.moving_time) ?? 0) > 2 * durationMedian) reasons.push("duration exceeds twice the period median");
    if (reasons.length) excluded.push({ activity_id: String(activity.id ?? ""), reasons }); else included.push(activity);
  }
  return { included, excluded };
}

function trendForMetric(current: R[], previous: R[], field: string, minimum: number, lowerIsBetter = false, threshold = 3): R {
  const currentValues = current.flatMap(item => numberValue(item[field]) == null ? [] : [numberValue(item[field])!]);
  const previousValues = previous.flatMap(item => numberValue(item[field]) == null ? [] : [numberValue(item[field])!]);
  if (!hasSufficientEvidence(currentValues.length, previousValues.length, minimum)) return { status: "INSUFFICIENT_DATA", current_value: median(currentValues), previous_value: median(previousValues), current_count: currentValues.length, previous_count: previousValues.length };
  return { ...metricVerdict(median(currentValues), median(previousValues), threshold, lowerIsBetter), current_count: currentValues.length, previous_count: previousValues.length };
}

type CurvePoint = { axis: number; value: number | null; activity_id: string | null; start_date_local: unknown; activity: R | null };

function curveBests(data: R, pace: boolean, start: string, end: string, activities: Map<string, R>): { axis_type: string; bests: CurvePoint[]; activity_count: number } {
  const axis = (Array.isArray(data.secs) ? data.secs : Array.isArray(data.distances) ? data.distances : []) as number[];
  const curves = (Array.isArray(data.curves) ? data.curves : []).filter((curve): curve is R => {
    const day = recordDay(curve) ?? recordDay(activities.get(String((curve as R).id ?? "")) ?? {});
    return day != null && day >= start && day <= end;
  });
  const bests = axis.map((point, index): CurvePoint => {
    const candidates = curves.flatMap(curve => {
      const values = (pace ? curve.secs : curve.watts) as unknown[] | undefined; const value = Array.isArray(values) ? numberValue(values[index]) : null;
      const activity = activities.get(String(curve.id ?? "")) ?? curve;
      return value == null ? [] : [{ value, activity_id: String(curve.id ?? ""), start_date_local: curve.start_date_local ?? activity.start_date_local ?? null, activity }];
    });
    const best = candidates.reduce<(typeof candidates)[number] | null>((chosen, candidate) => !chosen || (pace ? candidate.value < chosen.value : candidate.value > chosen.value) ? candidate : chosen, null);
    return best ? { axis: point, ...best } : { axis: point, value: null, activity_id: null, start_date_local: null, activity: null };
  });
  return { axis_type: pace ? "distance_meters" : "duration_seconds", bests, activity_count: curves.length };
}

function thresholdComparison(current: ReturnType<typeof curveBests>, previous: ReturnType<typeof curveBests>, discipline: Discipline): R {
  const points = current.bests.map((point, index) => {
    const prior = previous.bests[index];
    if (point.value == null || prior?.value == null || !point.activity || !prior.activity) return { axis: point.axis, current_value: point.value, previous_value: prior?.value ?? null, current_activity_id: point.activity_id, previous_activity_id: prior?.activity_id ?? null, status: "INSUFFICIENT_DATA" };
    const context = compareActivityContexts(point.activity, prior.activity, discipline);
    if (!context.comparable) return { axis: point.axis, current_value: point.value, previous_value: prior.value, current_activity_id: point.activity_id, previous_activity_id: prior.activity_id, status: "NOT_COMPARABLE", context };
    return { axis: point.axis, current_activity_id: point.activity_id, previous_activity_id: prior.activity_id, ...metricVerdict(point.value, prior.value, 3, discipline !== "BIKE"), context };
  });
  const directional = points.map(point => String(point.status)).filter(status => status === "IMPROVED" || status === "DECLINED");
  const improved = directional.filter(status => status === "IMPROVED").length; const declined = directional.length - improved;
  const status = directional.length === 0 ? (points.some(point => point.status === "STABLE") ? "STABLE" : points.some(point => point.status === "NOT_COMPARABLE") ? "NOT_COMPARABLE" : "INSUFFICIENT_DATA") : improved > declined ? "IMPROVED" : declined > improved ? "DECLINED" : "MIXED";
  return { status, points };
}

async function safeResult(label: string, fn: () => Promise<ToolTextResult>): Promise<ToolTextResult> {
  try { return await fn(); } catch (error) { return errorResult(label, error); }
}

export function registerAnalysisTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool("compare_similar_activities", {
    description: "Compare an activity with compatible recent sessions. Bike speed is verdict-eligible only on the same identified route; references are recent, selected-median, and best-by-metric rather than one universal best session.",
    inputSchema: {
      activity_id: z.string().optional(), sport: disciplineSchema.optional(), lookback_days: z.number().int().min(14).max(365).optional().default(90),
      comparison_count: z.number().int().min(1).max(10).optional().default(3), comparison_mode: z.enum(["AUTO", "SAME_SESSION_TYPE", "SAME_DURATION", "SAME_ROUTE"]).optional().default("AUTO"),
      duration_tolerance_percent: z.number().min(5).max(100).optional().default(25), include_weather_context: z.boolean().optional().default(true), tags: z.array(z.string()).optional(),
    },
    outputSchema: { target: recordSchema, comparisons: z.array(recordSchema), overall_verdict: z.string(), confidence: z.string(), caveats: z.array(z.string()) },
  }, async ({ activity_id, sport, lookback_days, comparison_count, comparison_mode, duration_tolerance_percent, include_weather_context, tags }) => safeResult("comparing similar activities", async () => {
    const end = isoDay(); const start = addDays(end, -lookback_days);
    const activities = await client.get<R[]>(`/athlete/${client.athleteId}/activities`, { oldest: start, newest: end, limit: "250" });
    const sorted = [...(activities ?? [])].sort((a, b) => String(b.start_date_local ?? "").localeCompare(String(a.start_date_local ?? "")));
    const target = activity_id ? sorted.find(activity => String(activity.id) === activity_id) : sorted.find(activity => !sport || canonicalDiscipline(activity.type) === sport);
    if (!target) throw new Error("Target activity was not found in the selected lookback period.");
    if (sport && canonicalDiscipline(target.type) !== sport) throw new Error("sport does not match the target activity.");
    const targetWithTags = tags?.length ? { ...target, tags } : target;
    const scored = sorted.flatMap(candidate => {
      if (String(candidate.id) === String(target.id)) return [];
      const match = scoreCandidate(targetWithTags, candidate, comparison_mode, duration_tolerance_percent);
      return match ? [{ activity: candidate, ...match }] : [];
    }).sort((a, b) => b.score - a.score);
    const selected = scored.filter(candidate => candidate.score >= COMPATIBILITY_THRESHOLD).slice(0, comparison_count);
    const metrics = comparisonMetrics(target, comparison_mode, selected.map(candidate => candidate.activity));
    const referenceData = metricReferences(target, selected, metrics.included);
    const overall = overallComparison(selected.length, referenceData.verdicts);
    const comparisons = selected.map(candidate => ({ ...compactActivity(candidate.activity), similarity_score: candidate.score, score_components: candidate.components, selection_reasons: candidate.reasons }));
    const highest = scored[0]?.score ?? null; const minimum = selected.length ? Math.min(...selected.map(candidate => candidate.score)) : null;
    const fallback = selected.some(candidate => candidate.usedZoneFallback);
    const confidence = selected.length < 2 ? "INSUFFICIENT" : fallback || selected.length < 3 ? "LOW" : "MODERATE";
    const caveats = [
      "Summary metrics only; no streams or interval details were fetched.",
      include_weather_context ? "Weather uses stored activity summary fields when available." : "Weather context was not requested.",
      fallback ? "At least one SAME_SESSION_TYPE comparison lacked compatible zone data, so family and intensity fallback lowered confidence." : null,
    ].filter((value): value is string => Boolean(value));
    return structuredResult(`Compared ${String(target.name ?? target.id)} with ${selected.length} compatible activities: ${overall}.`, {
      target: { ...compactActivity(target), session_family: sessionFamily(target), preferred_zone_distribution: canonicalDiscipline(target.type) ? preferredZoneDistribution(target, canonicalDiscipline(target.type)!) : null },
      comparisons, references: referenceData.references, metric_verdicts: referenceData.verdicts, overall_verdict: overall, confidence,
      comparison_basis: { included_metrics: metrics.included.map(metric => metric.key), excluded_metrics: metrics.excluded, candidate_count: scored.length, selected_count: selected.length, minimum_compatibility: minimum, highest_compatibility: highest, compatibility_threshold: COMPATIBILITY_THRESHOLD },
      evidence_activity_ids: [String(target.id), ...selected.map(candidate => String(candidate.activity.id))], caveats,
    });
  }));

  server.registerTool("get_training_readiness", {
    description: "Compact advisory readiness snapshot combining HRV/RHR trends, server-estimated discipline load state, and upcoming demand. Freshness caused by low recent training is not a positive signal.",
    inputSchema: { date: z.string().optional(), wellness_lookback_days: z.number().int().min(7).max(42).optional().default(14), activity_lookback_days: z.number().int().min(14).max(90).optional().default(42), planned_lookahead_days: z.number().int().min(0).max(14).optional().default(7), sport: z.union([disciplineSchema, z.literal("ALL")]).optional().default("ALL"), include_upcoming_load: z.boolean().optional().default(true) },
    outputSchema: { status: z.string(), confidence: z.string(), systemic_recovery: recordSchema, discipline_load: z.array(recordSchema), caveats: z.array(z.string()) },
  }, async ({ date, wellness_lookback_days, activity_lookback_days, planned_lookahead_days, sport, include_upcoming_load }) => safeResult("calculating training readiness", async () => {
    const assessment = date ?? isoDay(); const seedStart = addDays(assessment, -180); const wellnessDays = Math.max(28, wellness_lookback_days); const wellnessStart = addDays(assessment, -wellnessDays + 1);
    const [wellness, activities, events] = await Promise.all([
      client.get<R[]>(`/athlete/${client.athleteId}/wellness`, { oldest: wellnessStart, newest: assessment }),
      client.get<R[]>(`/athlete/${client.athleteId}/activities`, { oldest: seedStart, newest: assessment, limit: "500" }),
      include_upcoming_load ? client.get<R[]>(`/athlete/${client.athleteId}/events`, { oldest: assessment, newest: addDays(assessment, planned_lookahead_days) }) : Promise.resolve([]),
    ]);
    const entries = [...(wellness ?? [])].sort((a, b) => String(recordDay(a) ?? "").localeCompare(String(recordDay(b) ?? "")));
    const latest = [...entries].reverse().find(entry => recordDay(entry) != null && recordDay(entry)! <= assessment) ?? {};
    const hrv = hrvAnalysis(entries, assessment); const rhr = restingHrAnalysis(entries, assessment);
    const sleepHours = numberValue(latest.sleepSecs) == null ? null : numberValue(latest.sleepSecs)! / 3600;
    const sleepStatus = sleepHours == null ? "MISSING" : sleepHours < 5 ? "SEVERE" : sleepHours < 6 ? "CAUTION" : "NORMAL";
    const selectedDisciplines: Discipline[] = sport === "ALL" ? ["BIKE", "RUN", "SWIM"] : [sport];
    const disciplineLoad = selectedDisciplines.map(discipline => {
      const all = (activities ?? []).filter(activity => canonicalDiscipline(activity.type) === discipline && recordDay(activity) != null && recordDay(activity)! <= assessment);
      const loaded42 = all.filter(activity => recordDay(activity)! >= addDays(assessment, -41) && numberValue(activity.icu_training_load) != null);
      const loads = dailyLoads(activities ?? [], discipline, seedStart, addDays(assessment, -1)); const model = loadModel(loads);
      const recent = dailyLoads(activities ?? [], discipline, addDays(assessment, -42), addDays(assessment, -1));
      const load14 = recent.slice(-14).reduce((sum, value) => sum + value, 0); const preceding28 = recent.slice(0, 28).reduce((sum, value) => sum + value, 0);
      const lastDay = all.map(recordDay).filter((value): value is string => value != null).sort().at(-1) ?? null;
      const lowRecent = lastDay == null || lastDay < addDays(assessment, -13) || load14 < preceding28 / 4;
      const tsb = numberValue(model.estimated_tsb);
      const trainingState = loaded42.length < 3 ? "INSUFFICIENT_DATA" : lowRecent ? "LOW_RECENT_TRAINING" : tsb != null && tsb < -10 ? "FATIGUED" : tsb != null && tsb >= 0 ? "TRAINED_AND_FRESH" : "BALANCED";
      return { discipline, ...model, loaded_activity_count_42_days: loaded42.length, most_recent_activity_date: lastDay, load_7_days: recent.slice(-7).reduce((sum, value) => sum + value, 0), load_14_days: load14, preceding_28_day_load: preceding28, preceding_28_day_normalized_to_14_days: preceding28 / 2, load_42_days: recent.reduce((sum, value) => sum + value, 0), training_state: trainingState };
    });
    const injury = numberValue(latest.injury) ?? 0; const fatigue = numberValue(latest.fatigue) ?? 0; const soreness = numberValue(latest.soreness) ?? 0;
    const severeSubjective = injury >= 7 || fatigue >= 7 || soreness >= 7;
    const severe = [hrv, rhr].filter(value => value.status === "SEVERE").length + (sleepStatus === "SEVERE" ? 1 : 0) + (severeSubjective ? 1 : 0);
    const cautions = [hrv, rhr].filter(value => value.status === "CAUTION").length + (sleepStatus === "CAUTION" ? 1 : 0) + (injury > 0 || fatigue > 0 || soreness > 0 ? 1 : 0) + disciplineLoad.filter(value => value.training_state === "FATIGUED").length;
    const status = severe >= 2 || severeSubjective ? "REST_RECOMMENDED" : severe || cautions >= 2 ? "CAUTION" : cautions ? "MODERATE" : entries.length >= 7 ? "READY" : "INSUFFICIENT_DATA";
    const upcoming = (events ?? []).map(event => ({ id: String(event.id ?? ""), name: event.name ?? null, type: event.type ?? null, date: recordDay(event), training_load: numberValue(event.icu_training_load ?? event.load_target), intensity: numberValue(event.icu_intensity) }));
    const knownLoads = upcoming.filter(event => event.training_load != null); const missingLoadCount = upcoming.length - knownLoads.length;
    const hardest = upcoming.reduce<(typeof upcoming)[number] | null>((chosen, event) => !chosen || (event.training_load ?? -1) > (chosen.training_load ?? -1) || ((event.training_load ?? -1) === (chosen.training_load ?? -1) && (event.intensity ?? -1) > (chosen.intensity ?? -1)) ? event : chosen, null);
    const hard = hardest != null && ((hardest.intensity ?? -1) >= 90 || (hardest.training_load ?? -1) >= 75);
    const compatibility = !hardest || (hardest.training_load == null && hardest.intensity == null) ? "UNKNOWN" : !hard ? "COMPATIBLE" : status === "READY" ? "COMPATIBLE" : status === "MODERATE" ? "USE_CAUTION" : status === "CAUTION" || status === "REST_RECOMMENDED" ? "NOT_RECOMMENDED" : "UNKNOWN";
    const positiveSignals: string[] = []; const cautionSignals: string[] = [];
    if (hrv.status === "NORMAL" && hrv.trend !== "WORSENING") positiveSignals.push(`HRV is within baseline range (${hrv.trend}).`); else if (hrv.status !== "MISSING") cautionSignals.push(`HRV is ${String(hrv.status).toLowerCase()} and trending ${String(hrv.trend).toLowerCase()}.`);
    if (rhr.status === "NORMAL" && (rhr.range === "NORMAL_RANGE" || rhr.range === "LOW")) positiveSignals.push(`Resting HR is ${String(rhr.range).toLowerCase()}.`); else if (rhr.status !== "MISSING") cautionSignals.push(`Resting HR is ${String(rhr.range).toLowerCase()} (${rhr.deviation_bpm} bpm from baseline).`);
    if (sleepStatus === "NORMAL") positiveSignals.push("Sleep duration is normal."); else if (sleepStatus !== "MISSING") cautionSignals.push(`Sleep is ${sleepStatus.toLowerCase()} (${sleepHours?.toFixed(1)} hours).`);
    for (const load of disciplineLoad) {
      if (load.training_state === "TRAINED_AND_FRESH" || load.training_state === "BALANCED") positiveSignals.push(`${load.discipline} training state is ${String(load.training_state).toLowerCase()}.`);
      if (load.training_state === "FATIGUED" || load.training_state === "LOW_RECENT_TRAINING") cautionSignals.push(`${load.discipline} training state is ${String(load.training_state).toLowerCase()}.`);
    }
    if (injury > 0 || fatigue > 0 || soreness > 0) cautionSignals.push(`Subjective injury/fatigue/soreness: ${injury}/${fatigue}/${soreness}.`);
    if (hard && compatibility !== "COMPATIBLE") cautionSignals.push(`Hardest upcoming session is ${compatibility.toLowerCase().replaceAll("_", " ")}.`);
    const primaryLimiter = severeSubjective || injury > 0 ? "INJURY_OR_SEVERE_SUBJECTIVE_DATA" : hrv.status === "SEVERE" || hrv.status === "CAUTION" ? "HRV" : rhr.status === "SEVERE" || rhr.status === "CAUTION" ? "RESTING_HR" : sleepStatus === "SEVERE" || sleepStatus === "CAUTION" ? "SLEEP" : disciplineLoad.some(load => load.training_state === "FATIGUED") ? "DISCIPLINE_FATIGUE" : hard && compatibility !== "COMPATIBLE" ? "UPCOMING_DEMAND" : null;
    return structuredResult(`Readiness for ${assessment}: ${status}.`, {
      status, confidence: entries.length >= 28 && (activities?.length ?? 0) > 20 ? "MODERATE" : "LOW",
      systemic_recovery: { hrv, resting_hr: rhr, sleep_hours: sleepHours, sleep_status: sleepStatus, device_readiness: latest.readiness ?? null, injury: latest.injury ?? null, fatigue: latest.fatigue ?? null, soreness: latest.soreness ?? null },
      intervals_aggregate: { ctl: latest.ctl ?? null, atl: latest.atl ?? null, ramp_rate: latest.rampRate ?? null }, discipline_load: disciplineLoad,
      future_demand: { planned_load_next_48_hours: knownLoads.filter(event => event.date != null && event.date! <= addDays(assessment, 1)).reduce((sum, event) => sum + event.training_load!, 0), planned_load_lookahead: knownLoads.reduce((sum, event) => sum + event.training_load!, 0), planned_sessions_missing_load: missingLoadCount, hardest_upcoming_session: hardest, hardest_session_is_hard: hard, compatibility },
      upcoming_sessions: upcoming, positive_signals: positiveSignals, caution_signals: cautionSignals, status_reasons: [...cautionSignals, ...positiveSignals], primary_limiter: primaryLimiter, evidence_activity_count: activities?.length ?? 0,
      caveats: ["Discipline CTL, ATL, and TSB are server estimates derived from activity load, not Intervals.icu values.", `Wellness fetch window: ${wellnessDays} days (at least 28 for baseline); requested reporting window: ${wellness_lookback_days} days. Discipline state uses 42 days and load-model initialization uses 180 days; requested activity summary window: ${activity_lookback_days} days.`],
    });
  }));

  server.registerTool("get_discipline_trends", {
    description: "Separate training-volume direction from fitness, efficiency, durability, and context-compatible threshold evidence. Discipline CTL/ATL/TSB are not used here and remain server estimates in readiness.",
    inputSchema: { lookback_days: z.number().int().min(28).max(365).optional().default(84), disciplines: z.array(disciplineSchema).optional().default(["BIKE", "RUN", "SWIM"]), windows_weeks: z.array(z.union([z.literal(4), z.literal(8), z.literal(12)])).optional().default([4, 8, 12]), include_efficiency_trends: z.boolean().optional().default(true), include_durability_trends: z.boolean().optional().default(true), minimum_sessions_per_period: z.number().int().min(1).max(10).optional().default(3) },
    outputSchema: { disciplines: z.array(recordSchema), confidence: z.string(), caveats: z.array(z.string()) },
  }, async ({ lookback_days, disciplines, windows_weeks, include_efficiency_trends, include_durability_trends, minimum_sessions_per_period }) => safeResult("calculating discipline trends", async () => {
    const end = isoDay(); const largestDays = Math.max(...windows_weeks) * 7; const start = addDays(end, -Math.max(180, lookback_days * 2, largestDays * 2));
    const activities = await client.get<R[]>(`/athlete/${client.athleteId}/activities`, { oldest: start, newest: end, limit: "500" });
    const results = await Promise.all(disciplines.map(async discipline => {
      const relevant = (activities ?? []).filter(activity => canonicalDiscipline(activity.type) === discipline);
      const curvePath = discipline === "BIKE" ? "activity-power-curves" : "activity-pace-curves";
      const maxCurrentStart = addDays(end, -largestDays + 1); const maxPreviousEnd = addDays(maxCurrentStart, -1); const maxPreviousStart = addDays(maxCurrentStart, -largestDays);
      const params: Record<string, string> = discipline === "BIKE" ? { type: "Ride", oldest: maxCurrentStart, newest: end, secs: "300,1200,1800,3600" } : { type: discipline === "RUN" ? "Run" : "Swim", oldest: maxCurrentStart, newest: end, distances: discipline === "RUN" ? "1000,5000,10000,21097" : "200,400,800,1500" };
      const [currentRaw, previousRaw] = await Promise.all([client.get<R>(`/athlete/${client.athleteId}/${curvePath}`, params), client.get<R>(`/athlete/${client.athleteId}/${curvePath}`, { ...params, oldest: maxPreviousStart, newest: maxPreviousEnd })]);
      const combined: R = { ...(currentRaw ?? {}), curves: [...(Array.isArray(currentRaw?.curves) ? currentRaw.curves : []), ...(Array.isArray(previousRaw?.curves) ? previousRaw.curves : [])] };
      const activityMap = new Map(relevant.map(activity => [String(activity.id ?? ""), activity]));
      const windows = windows_weeks.map(weeks => {
        const days = weeks * 7; const currentStart = addDays(end, -days + 1); const currentEnd = end; const previousEnd = addDays(currentStart, -1); const previousStart = addDays(currentStart, -days);
        const current = relevant.filter(activity => recordDay(activity) != null && recordDay(activity)! >= currentStart && recordDay(activity)! <= currentEnd);
        const previous = relevant.filter(activity => recordDay(activity) != null && recordDay(activity)! >= previousStart && recordDay(activity)! <= previousEnd);
        const currentSummary = periodSummary(current); const previousSummary = periodSummary(previous); const volume = loadTrend(numberValue(currentSummary.training_load) ?? 0, numberValue(previousSummary.training_load) ?? 0);
        const currentCohort = efficiencyCohort(current); const previousCohort = efficiencyCohort(previous);
        const fitnessField = discipline === "BIKE" ? "icu_weighted_avg_watts" : "pace";
        const fitness = trendForMetric(currentCohort.included, previousCohort.included, fitnessField, minimum_sessions_per_period);
        const efficiency = include_efficiency_trends ? trendForMetric(currentCohort.included, previousCohort.included, "icu_efficiency_factor", minimum_sessions_per_period) : { status: "NOT_REQUESTED" };
        const longSeconds = discipline === "BIKE" ? 5400 : discipline === "RUN" ? 3600 : 2700;
        const currentLong = current.filter(activity => (numberValue(activity.moving_time) ?? 0) >= longSeconds && numberValue(activity.decoupling) != null);
        const previousLong = previous.filter(activity => (numberValue(activity.moving_time) ?? 0) >= longSeconds && numberValue(activity.decoupling) != null);
        const durability = includeDurability(include_durability_trends, currentLong, previousLong);
        const currentCurve = curveBests(combined, discipline !== "BIKE", currentStart, currentEnd, activityMap); const previousCurve = curveBests(combined, discipline !== "BIKE", previousStart, previousEnd, activityMap);
        const threshold = thresholdComparison(currentCurve, previousCurve, discipline);
        return {
          weeks, current_start: currentStart, current_end: currentEnd, previous_start: previousStart, previous_end: previousEnd,
          current: currentSummary, previous: previousSummary, volume_trend: volume,
          load_spike: loadSpike(dailyLoads(relevant, discipline, addDays(currentEnd, -34), currentEnd)), fitness_trend: fitness,
          efficiency_trend: efficiency, durability_trend: durability, threshold_evidence: threshold,
          evidence: {
            current_window_activity_ids: current.map(activity => String(activity.id ?? "")), previous_window_activity_ids: previous.map(activity => String(activity.id ?? "")),
            efficiency_cohort: { current_included_ids: currentCohort.included.map(activity => String(activity.id ?? "")), previous_included_ids: previousCohort.included.map(activity => String(activity.id ?? "")), current_excluded: currentCohort.excluded, previous_excluded: previousCohort.excluded },
            durability: { current_qualifying_ids: currentLong.map(activity => String(activity.id ?? "")), previous_qualifying_ids: previousLong.map(activity => String(activity.id ?? "")) },
            curve_points: (threshold.points as R[]).map(point => ({ axis: point.axis, current_activity_id: point.current_activity_id, previous_activity_id: point.previous_activity_id })),
          },
          curve_evidence: { current: stripCurveActivities(currentCurve), previous: stripCurveActivities(previousCurve) },
        };
      });
      const summaryWindow = windows.find(window => window.weeks === Math.max(...windows_weeks)) ?? windows[0];
      return { discipline, summary: disciplineSummary(summaryWindow, minimum_sessions_per_period), windows };
    }));
    return structuredResult(`Discipline trends calculated for ${disciplines.join(", ")}.`, { disciplines: results, confidence: (activities?.length ?? 0) >= 30 ? "MODERATE" : "LOW", caveats: ["Volume includes every activity; load direction is not a fitness verdict.", "Efficiency cohorts exclude races and sessions longer than twice the period median.", "Efficiency and durability use summary metrics only; streams were not fetched.", "Curve comparisons are directional only when sport-specific contexts are compatible; cycling position is used only from explicit tags."] });
  }));
}

function includeDurability(requested: boolean, current: R[], previous: R[]): R {
  if (!requested) return { status: "NOT_REQUESTED", current_qualifying_count: current.length, previous_qualifying_count: previous.length, current_activity_ids: current.map(item => String(item.id ?? "")), previous_activity_ids: previous.map(item => String(item.id ?? "")) };
  const result = hasSufficientEvidence(current.length, previous.length, 3) ? metricVerdict(median(current.map(item => numberValue(item.decoupling)!).filter(value => value != null)), median(previous.map(item => numberValue(item.decoupling)!).filter(value => value != null)), 1.5, true) : { status: "INSUFFICIENT_DATA" };
  return { ...result, current_qualifying_count: current.length, previous_qualifying_count: previous.length, current_activity_ids: current.map(item => String(item.id ?? "")), previous_activity_ids: previous.map(item => String(item.id ?? "")) };
}

function stripCurveActivities(curve: ReturnType<typeof curveBests>): R {
  return { axis_type: curve.axis_type, bests: curve.bests.map(({ activity: _activity, ...point }) => point), activity_count: curve.activity_count };
}

function disciplineSummary(window: R, minimum: number): string {
  const current = window.current as R; const previous = window.previous as R;
  const currentSessions = numberValue(current.sessions) ?? 0; const previousSessions = numberValue(previous.sessions) ?? 0;
  if (currentSessions < minimum && previousSessions < minimum) return "INSUFFICIENT_DATA";
  if (previousSessions >= minimum && currentSessions < minimum && (numberValue(current.training_load) ?? 0) <= .5 * (numberValue(previous.training_load) ?? 0)) return "LOW_RECENT_TRAINING";
  const statuses = [window.fitness_trend, window.efficiency_trend, window.durability_trend, window.threshold_evidence].map(value => String((value as R).status));
  const improved = statuses.filter(status => status === "IMPROVED").length; const declined = statuses.filter(status => status === "DECLINED").length;
  if (improved >= 2 && declined === 0) return "RECENTLY_IMPROVING";
  if (declined >= 2 && improved === 0) return "DECLINING";
  return "STABLE";
}
