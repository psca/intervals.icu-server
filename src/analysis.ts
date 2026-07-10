export type AnalysisRecord = Record<string, unknown>;
export type Discipline = "BIKE" | "RUN" | "SWIM";

const DAY = 86_400_000;

export function isoDay(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function canonicalDiscipline(type: unknown): Discipline | null {
  const value = String(type ?? "");
  if (["Ride", "VirtualRide", "MountainBikeRide", "GravelRide", "TrackRide", "Cyclocross"].includes(value)) return "BIKE";
  if (["Run", "VirtualRun", "TrailRun"].includes(value)) return "RUN";
  if (["Swim", "OpenWaterSwim"].includes(value)) return "SWIM";
  return null;
}

export function recordDay(record: AnalysisRecord): string | null {
  const value = record.start_date_local ?? record.start_date ?? record.id;
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

export function median(values: number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentChange(current: number | null, baseline: number | null): number | null {
  return current == null || baseline == null || baseline === 0 ? null : ((current - baseline) / Math.abs(baseline)) * 100;
}

export function sessionFamily(activity: AnalysisRecord): string {
  if (activity.race === true || activity.sub_type === "RACE" || (Array.isArray(activity.tags) && activity.tags.some(tag => /(^|\b)RACE(\b|$)/i.test(String(tag))))) return "RACE";
  const intensity = numberValue(activity.icu_intensity);
  if (intensity == null) return "UNCLASSIFIED";
  if (intensity < 60) return "RECOVERY";
  if (intensity < 80) return "ENDURANCE";
  if (intensity < 90) return "TEMPO";
  if (intensity <= 105) return "THRESHOLD";
  return "HIGH_INTENSITY";
}

function zoneSeconds(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (!value || typeof value !== "object") return null;
  const record = value as AnalysisRecord;
  for (const key of ["secs", "seconds", "time", "value"]) {
    const seconds = numberValue(record[key]);
    if (seconds != null && seconds >= 0) return seconds;
  }
  return null;
}

function normalizedZones(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const seconds = value.map(zoneSeconds);
  if (!seconds.length || seconds.some(item => item == null)) return null;
  const total = (seconds as number[]).reduce((sum, item) => sum + item, 0);
  return total > 0 ? (seconds as number[]).map(item => item / total) : null;
}

export function preferredZoneDistribution(activity: AnalysisRecord, discipline: Discipline): { source: string; percentages: number[] } | null {
  const fields = discipline === "BIKE"
    ? [["POWER", activity.icu_zone_times], ["HR", activity.icu_hr_zone_times]] as const
    : [["PACE", activity.pace_zone_times], ["HR", activity.icu_hr_zone_times]] as const;
  for (const [source, value] of fields) {
    const percentages = normalizedZones(value);
    if (percentages) return { source, percentages };
  }
  return null;
}

export function zoneDistributionSimilarity(target: AnalysisRecord, candidate: AnalysisRecord, discipline: Discipline): { score: number; source: string } | null {
  const left = preferredZoneDistribution(target, discipline);
  const right = preferredZoneDistribution(candidate, discipline);
  if (!left || !right || left.source !== right.source) return null;
  const size = Math.max(left.percentages.length, right.percentages.length);
  let distance = 0;
  for (let index = 0; index < size; index += 1) {
    distance += Math.abs((left.percentages[index] ?? 0) - (right.percentages[index] ?? 0));
  }
  return { score: Math.max(0, 100 - 50 * distance), source: left.source };
}

type ZoneRange = { low: number; high: number; token: string };

export function extractZoneIntent(activity: AnalysisRecord): ZoneRange[] {
  const text = [activity.name, ...(Array.isArray(activity.tags) ? activity.tags : [])].filter(value => typeof value === "string").join(" ");
  const ranges: ZoneRange[] = [];
  const expression = /\bZ\s*([1-9])(?:\s*-\s*(?:Z\s*)?([1-9]))?\b/gi;
  for (const match of text.matchAll(expression)) {
    const first = Number(match[1]);
    const second = match[2] ? Number(match[2]) : first;
    const low = Math.min(first, second); const high = Math.max(first, second);
    const token = low === high ? `Z${low}` : `Z${low}-Z${high}`;
    if (!ranges.some(range => range.token === token)) ranges.push({ low, high, token });
  }
  return ranges;
}

export function zoneIntentSimilarity(target: AnalysisRecord, candidate: AnalysisRecord): { score: number; match: string } | null {
  const targetRanges = extractZoneIntent(target);
  const candidateRanges = extractZoneIntent(candidate);
  if (!targetRanges.length || !candidateRanges.length) return null;
  const targetTokens = targetRanges.map(range => range.token).sort().join(",");
  const candidateTokens = candidateRanges.map(range => range.token).sort().join(",");
  if (targetTokens === candidateTokens) return { score: 100, match: "EXACT" };
  let best = 0;
  for (const left of targetRanges) for (const right of candidateRanges) {
    const overlap = Math.max(0, Math.min(left.high, right.high) - Math.max(left.low, right.low) + 1);
    const union = Math.max(left.high, right.high) - Math.min(left.low, right.low) + 1;
    best = Math.max(best, overlap / union * 100);
  }
  return { score: best, match: best > 0 ? "PARTIAL" : "NONE" };
}

export function hasSufficientEvidence(current: number, previous: number, minimum: number): boolean {
  return current >= minimum && previous >= minimum;
}

export function loadTrend(current: number, previous: number): { status: "INCREASED" | "DECREASED" | "STABLE"; change_percent: number | null } {
  const change = percentChange(current, previous);
  return { status: change != null && change >= 10 ? "INCREASED" : change != null && change <= -10 ? "DECREASED" : "STABLE", change_percent: change };
}

export function loadSpike(loads: number[]): { status: "CAUTION" | "SEVERE" | "NORMAL" | "INSUFFICIENT_DATA"; ratio: number | null; current_7_day_load: number | null; preceding_4_block_mean: number | null } {
  if (loads.length < 35) return { status: "INSUFFICIENT_DATA", ratio: null, current_7_day_load: null, preceding_4_block_mean: null };
  const recent = loads.slice(-7).reduce((sum, value) => sum + value, 0);
  const prior = loads.slice(-35, -7);
  const blocks = Array.from({ length: 4 }, (_, index) => prior.slice(index * 7, index * 7 + 7).reduce((sum, value) => sum + value, 0));
  const mean = blocks.reduce((sum, value) => sum + value, 0) / 4;
  const ratio = mean > 0 ? recent / mean : recent > 0 ? null : 1;
  return {
    status: ratio == null ? "INSUFFICIENT_DATA" : ratio >= 2 ? "SEVERE" : ratio >= 1.5 ? "CAUTION" : "NORMAL",
    ratio,
    current_7_day_load: recent,
    preceding_4_block_mean: mean,
  };
}

function explicitPosition(activity: AnalysisRecord): string | null {
  const tags = Array.isArray(activity.tags) ? activity.tags.map(value => String(value).toUpperCase()) : [];
  if (tags.some(tag => /(^|[^A-Z])AERO([^A-Z]|$)|TT POSITION|TIME TRIAL POSITION/.test(tag))) return "AERO";
  if (tags.some(tag => /(^|[^A-Z])ROAD([^A-Z]|$)|ROAD POSITION|HOODS|DROPS/.test(tag))) return "ROAD";
  return null;
}

export function activityContext(activity: AnalysisRecord, discipline: Discipline): AnalysisRecord {
  const race = activity.race === true || activity.sub_type === "RACE" || (Array.isArray(activity.tags) && activity.tags.some(tag => /(^|\b)RACE(\b|$)/i.test(String(tag))));
  if (discipline === "BIKE") return { environment: activity.trainer === true ? "INDOOR" : activity.trainer === false ? "OUTDOOR" : "UNKNOWN", purpose: race ? "RACE" : "TRAINING", position: explicitPosition(activity) };
  if (discipline === "RUN") return { purpose: race ? "RACE" : "TRAINING" };
  return { environment: String(activity.type) === "OpenWaterSwim" ? "OPEN_WATER" : "POOL", pool_length: numberValue(activity.pool_length), purpose: race ? "RACE" : "TRAINING" };
}

export function compareActivityContexts(current: AnalysisRecord, previous: AnalysisRecord, discipline: Discipline): { comparable: boolean; current: AnalysisRecord; previous: AnalysisRecord; reasons: string[] } {
  const left = activityContext(current, discipline); const right = activityContext(previous, discipline);
  const reasons: string[] = [];
  if (left.purpose !== right.purpose) reasons.push("race and training contexts differ");
  if (discipline === "BIKE") {
    if (left.environment === "UNKNOWN" || right.environment === "UNKNOWN") reasons.push("indoor/outdoor context is missing");
    else if (left.environment !== right.environment) reasons.push("indoor and outdoor contexts differ");
    if ((left.position != null || right.position != null) && left.position !== right.position) reasons.push("explicit aero/road position tags differ or are missing");
  }
  if (discipline === "SWIM") {
    if (left.environment !== right.environment) reasons.push("pool and open-water contexts differ");
    if (left.environment === "POOL" && (left.pool_length == null || right.pool_length == null || left.pool_length !== right.pool_length)) reasons.push("pool lengths differ or are missing");
  }
  return { comparable: reasons.length === 0, current: left, previous: right, reasons };
}

export function leastSquaresSlope(values: number[]): number | null {
  if (values.length < 2) return null;
  const meanX = (values.length - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0; let denominator = 0;
  values.forEach((value, index) => { numerator += (index - meanX) * (value - meanY); denominator += (index - meanX) ** 2; });
  return denominator > 0 ? numerator / denominator : null;
}
