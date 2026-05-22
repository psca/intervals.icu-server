import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { defaultDateRange } from "../utils.js";
import { errorResult, textResult, type ToolTextResult } from "./result.js";

type AthleteRecord = Record<string, unknown>;

const POWER_CURVE_DURATIONS: [number, string][] = [
  [1, "1s"], [5, "5s"], [10, "10s"], [30, "30s"],
  [60, "1min"], [300, "5min"], [600, "10min"],
  [1200, "20min"], [1800, "30min"], [3600, "60min"],
];

const HR_CURVE_DURATIONS: [number, string][] = [
  [30, "30s"], [60, "1min"], [300, "5min"], [600, "10min"],
  [1200, "20min"], [1800, "30min"], [3600, "60min"],
];

const genericObjectSchema = z.record(z.string(), z.unknown());

function metersPerSecToMinPerKm(mps: number): string {
  if (!mps || mps <= 0) return "N/A";
  const secPerKm = 1000 / mps;
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")}/km`;
}

function metersPerSecToPacePer100m(mps: number): string {
  if (!mps || mps <= 0) return "N/A";
  const secPer100m = 100 / mps;
  const min = Math.floor(secPer100m / 60);
  const sec = Math.round(secPer100m % 60);
  return `${min}:${sec.toString().padStart(2, "0")}/100m`;
}

function formatThresholdPace(mps: number, paceUnits?: string): string {
  if (paceUnits === "SECS_100M") return metersPerSecToPacePer100m(mps);
  return metersPerSecToMinPerKm(mps);
}

function formatSportSettingLabel(setting: Record<string, unknown>): string {
  const types = setting.types as string[] | undefined;
  if (types?.length) return types.join(", ");

  const type = setting.type as string | undefined;
  if (type) return type;

  return "Unknown";
}

function formatDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}km`;
  return `${Math.round(meters)}m`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function withAthleteToolResult(
  errorLabel: string,
  fn: () => Promise<ToolTextResult>,
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (error) {
    return errorResult(errorLabel, error);
  }
}

function distanceDisplay(meters: unknown): string | null {
  if (typeof meters !== "number") return null;
  return formatDistance(meters);
}

function normalizeGear(items: unknown): Record<string, unknown>[] {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const gear = item as Record<string, unknown>;
    return {
      name: gear.name ?? null,
      distance_meters: typeof gear.distance === "number" ? gear.distance : null,
      distance_display: distanceDisplay(gear.distance),
      activities: typeof gear.activities === "number" ? gear.activities : null,
      time_seconds: typeof gear.time === "number" ? gear.time : null,
      retired: Boolean(gear.retired),
      type: gear.type ?? null,
    };
  });
}

function normalizeSportSettings(settings: unknown): Record<string, unknown>[] {
  if (!Array.isArray(settings)) return [];
  return settings.map((setting) => {
    const sportSetting = setting as Record<string, unknown>;
    return {
      label: formatSportSettingLabel(sportSetting),
      types: Array.isArray(sportSetting.types) ? sportSetting.types : [],
      type: sportSetting.type ?? null,
      ftp: sportSetting.ftp ?? null,
      indoor_ftp: sportSetting.indoor_ftp ?? null,
      lthr: sportSetting.lthr ?? null,
      max_hr: sportSetting.max_hr ?? null,
      threshold_pace_mps: sportSetting.threshold_pace ?? null,
      threshold_pace_display: typeof sportSetting.threshold_pace === "number"
        ? formatThresholdPace(
          sportSetting.threshold_pace,
          sportSetting.pace_units as string | undefined,
        )
        : null,
      pace_units: sportSetting.pace_units ?? null,
      power_zones: Array.isArray(sportSetting.power_zones) ? sportSetting.power_zones : [],
      hr_zones: Array.isArray(sportSetting.hr_zones) ? sportSetting.hr_zones : [],
    };
  });
}

function normalizePowerCurve(curve: AthleteRecord): Record<string, unknown> {
  const secs = curve.secs as number[] ?? [];
  const watts = curve.watts as number[] ?? [];
  const wkg = curve.watts_per_kg as number[] ?? [];
  const bests = POWER_CURVE_DURATIONS.flatMap(([dur, label]) => {
    const idx = secs.indexOf(dur);
    if (idx === -1 || !watts[idx]) return [];
    return [{
      duration_seconds: dur,
      label,
      watts: watts[idx],
      watts_per_kg: wkg[idx] ?? null,
    }];
  });

  return {
    label: curve.label ?? null,
    start_date_local: curve.start_date_local ?? null,
    end_date_local: curve.end_date_local ?? null,
    bests,
    vo2max_5m: curve.vo2max_5m ?? null,
    raw_curve: curve,
  };
}

function normalizePaceCurve(curve: AthleteRecord): Record<string, unknown> {
  const models = curve.paceModels as { type: string; criticalSpeed: number; dPrime: number; r2: number }[] | undefined;
  return {
    label: curve.label ?? null,
    start_date_local: curve.start_date_local ?? null,
    end_date_local: curve.end_date_local ?? null,
    pace_models: (models ?? []).map((model) => ({
      type: model.type,
      critical_speed_mps: model.criticalSpeed,
      critical_speed_display: metersPerSecToMinPerKm(model.criticalSpeed),
      d_prime_meters: model.dPrime,
      r2: model.r2,
    })),
    raw_curve: curve,
  };
}

function normalizeHrCurve(curve: AthleteRecord): Record<string, unknown> {
  const secs = curve.secs as number[] ?? [];
  const values = curve.values as number[] ?? [];
  const bests = HR_CURVE_DURATIONS.flatMap(([dur, label]) => {
    const idx = secs.indexOf(dur);
    if (idx === -1 || !values[idx]) return [];
    return [{
      duration_seconds: dur,
      label,
      bpm: values[idx],
    }];
  });

  return {
    label: curve.label ?? null,
    start_date_local: curve.start_date_local ?? null,
    end_date_local: curve.end_date_local ?? null,
    bests,
    raw_curve: curve,
  };
}

const athleteProfileSchema = {
  full_name: z.string(),
  location: z.string().nullable(),
  weight_kg: z.number().nullable(),
  resting_hr_bpm: z.number().nullable(),
  date_of_birth: z.string().nullable(),
  sport_settings: z.array(z.object({
    label: z.string(),
    types: z.array(z.unknown()),
    type: z.unknown().nullable(),
    ftp: z.unknown().nullable(),
    indoor_ftp: z.unknown().nullable(),
    lthr: z.unknown().nullable(),
    max_hr: z.unknown().nullable(),
    threshold_pace_mps: z.unknown().nullable(),
    threshold_pace_display: z.string().nullable(),
    pace_units: z.unknown().nullable(),
    power_zones: z.array(z.unknown()),
    hr_zones: z.array(z.unknown()),
  })),
  bikes: z.array(genericObjectSchema),
  shoes: z.array(genericObjectSchema),
};

export function registerAthleteTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "get_athlete_profile",
    {
      description: "Get the athlete's current fitness thresholds and zones: FTP, LTHR, max HR, power zones, HR zones, threshold pace, and weight. Use when the user asks about their fitness level, training zones, thresholds, or capabilities — or when interpreting activity data requires knowing their baseline.",
      inputSchema: {},
      outputSchema: {
        athlete_profile: z.object(athleteProfileSchema),
      },
    },
    async () => {
      return withAthleteToolResult("fetching athlete profile", async () => {
        const athlete = await client.get<AthleteRecord>(`/athlete/${client.athleteId}`);

        const fullName = [athlete.firstname, athlete.lastname].filter(Boolean).join(" ").trim();
        const locationParts = [athlete.city, athlete.country].filter(Boolean).map(String);
        return textResult({
          athlete_profile: {
            full_name: fullName,
            location: locationParts.length ? locationParts.join(", ") : null,
            weight_kg: typeof athlete.icu_weight === "number" ? athlete.icu_weight : null,
            resting_hr_bpm: typeof athlete.icu_resting_hr === "number" ? athlete.icu_resting_hr : null,
            date_of_birth: typeof athlete.icu_date_of_birth === "string" ? athlete.icu_date_of_birth : null,
            sport_settings: normalizeSportSettings(athlete.sportSettings),
            bikes: normalizeGear(athlete.bikes),
            shoes: normalizeGear(athlete.shoes),
          },
        });
      });
    }
  );

  server.registerTool(
    "search_activities",
    {
      description: "Search for activities by name or tag (e.g. 'tempo run', 'race', 'threshold'). Returns summary info.",
      inputSchema: {
        query: z.string().describe("Search query — matches activity name or tag"),
        limit: z.number().int().optional().default(10).describe("Max results to return"),
      },
      outputSchema: {
        query: z.string(),
        activities: z.array(genericObjectSchema),
        count: z.number().int(),
      },
    },
    async ({ query, limit }) => {
      return withAthleteToolResult("searching activities", async () => {
        const results = await client.get<AthleteRecord[]>(
          `/athlete/${client.athleteId}/activities/search`,
          { q: query, limit: String(limit) }
        );
        if (!results?.length) {
          return textResult({ query, activities: [], count: 0 });
        }

        return textResult({ query, activities: results, count: results.length });
      });
    }
  );

  server.registerTool(
    "get_power_curves",
    {
      description: "Get best power curves for the athlete over a date range. Shows peak power at key durations (1s to 60min). Requires activity type (e.g. Ride, VirtualRide).",
      inputSchema: {
        activity_type: z.string().describe("Activity type e.g. Ride, VirtualRide, Run"),
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      },
      outputSchema: {
        activity_type: z.string(),
        curves: z.array(genericObjectSchema),
        count: z.number().int(),
      },
    },
    async ({ activity_type, start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      return withAthleteToolResult("fetching power curves", async () => {
        const data = await client.get<{ list: AthleteRecord[] }>(
          `/athlete/${client.athleteId}/power-curves`,
          { type: activity_type, oldest: start_date ?? start, newest: end_date ?? end }
        );
        const curves = data?.list ?? [];
        if (!curves.length) return textResult({ activity_type, curves: [], count: 0 });

        const normalizedCurves = curves.map((curve) => {
          return normalizePowerCurve(curve);
        });
        return textResult({ activity_type, curves: normalizedCurves, count: normalizedCurves.length });
      });
    }
  );

  server.registerTool(
    "get_pace_curves",
    {
      description: "Get best pace curves for the athlete over a date range. Shows critical speed (threshold pace) and D' from the pace model. Requires activity type (e.g. Run, Swim).",
      inputSchema: {
        activity_type: z.string().describe("Activity type e.g. Run, Swim, Walk"),
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      },
      outputSchema: {
        activity_type: z.string(),
        curves: z.array(genericObjectSchema),
        count: z.number().int(),
      },
    },
    async ({ activity_type, start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      return withAthleteToolResult("fetching pace curves", async () => {
        const data = await client.get<{ list: AthleteRecord[] }>(
          `/athlete/${client.athleteId}/pace-curves`,
          { type: activity_type, oldest: start_date ?? start, newest: end_date ?? end }
        );
        const curves = data?.list ?? [];
        if (!curves.length) return textResult({ activity_type, curves: [], count: 0 });

        const normalizedCurves = curves.map((curve) => {
          return normalizePaceCurve(curve);
        });
        return textResult({ activity_type, curves: normalizedCurves, count: normalizedCurves.length });
      });
    }
  );

  server.registerTool(
    "get_hr_curves",
    {
      description: "Get best heart rate curves for the athlete over a date range. Shows peak HR sustained at key durations. Requires activity type (e.g. Run, Ride).",
      inputSchema: {
        activity_type: z.string().describe("Activity type e.g. Run, Ride, VirtualRide"),
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      },
      outputSchema: {
        activity_type: z.string(),
        curves: z.array(genericObjectSchema),
        count: z.number().int(),
      },
    },
    async ({ activity_type, start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      return withAthleteToolResult("fetching HR curves", async () => {
        const data = await client.get<{ list: AthleteRecord[] }>(
          `/athlete/${client.athleteId}/hr-curves`,
          { type: activity_type, oldest: start_date ?? start, newest: end_date ?? end }
        );
        const curves = data?.list ?? [];
        if (!curves.length) return textResult({ activity_type, curves: [], count: 0 });

        const normalizedCurves = curves.map((curve) => {
          return normalizeHrCurve(curve);
        });
        return textResult({ activity_type, curves: normalizedCurves, count: normalizedCurves.length });
      });
    }
  );

  server.registerTool(
    "get_gear",
    {
      description: "List the athlete's gear (bikes, shoes, equipment) with usage statistics.",
      inputSchema: {},
      outputSchema: {
        gear: z.array(genericObjectSchema),
        active_gear_by_type: genericObjectSchema,
        retired_gear: z.array(genericObjectSchema),
      },
    },
    async () => {
      return withAthleteToolResult("fetching gear", async () => {
        const gear = await client.get<AthleteRecord[]>(`/athlete/${client.athleteId}/gear`);
        if (!gear?.length) {
          return textResult({ gear: [], active_gear_by_type: {}, retired_gear: [] });
        }

        const byType: Record<string, AthleteRecord[]> = {};
        for (const item of gear) {
          const type = (item.type as string) ?? "Other";
          (byType[type] ??= []).push(item);
        }

        const retired = gear.filter(item => item.retired);

        const normalizedGear = normalizeGear(gear);
        const activeGearByType = Object.fromEntries(
          Object.entries(byType).map(([type, items]) => [type, normalizeGear(items.filter(item => !item.retired))])
        );
        const retiredGear = normalizeGear(retired);

        return textResult({
          gear: normalizedGear,
          active_gear_by_type: activeGearByType,
          retired_gear: retiredGear,
        });
      });
    }
  );
}
