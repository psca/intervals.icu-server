import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { defaultDateRange, toolHandler } from "../utils.js";

const POWER_CURVE_DURATIONS: [number, string][] = [
  [1, "1s"], [5, "5s"], [10, "10s"], [30, "30s"],
  [60, "1min"], [300, "5min"], [600, "10min"],
  [1200, "20min"], [1800, "30min"], [3600, "60min"],
];

const HR_CURVE_DURATIONS: [number, string][] = [
  [30, "30s"], [60, "1min"], [300, "5min"], [600, "10min"],
  [1200, "20min"], [1800, "30min"], [3600, "60min"],
];

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

export function registerAthleteTools(server: McpServer, client: IntervalsClient): void {

  server.registerTool(
    "get_athlete_profile",
    {
      description: "Get the athlete's current fitness thresholds and zones: FTP, LTHR, max HR, power zones, HR zones, threshold pace, and weight. Use when the user asks about their fitness level, training zones, thresholds, or capabilities — or when interpreting activity data requires knowing their baseline.",
      inputSchema: {},
    },
    async () => {
      return toolHandler(async () => {
        const athlete = await client.get<Record<string, unknown>>(`/athlete/${client.athleteId}`);

        let text = `Athlete Profile: ${athlete.firstname ?? ""} ${athlete.lastname ?? ""}`.trim();
        if (athlete.city || athlete.country) {
          text += ` (${[athlete.city, athlete.country].filter(Boolean).join(", ")})`;
        }
        text += "\n\n";

        text += `Weight: ${athlete.icu_weight ?? "N/A"} kg\n`;
        text += `Resting HR: ${athlete.icu_resting_hr ?? "N/A"} bpm\n`;
        if (athlete.icu_date_of_birth) text += `Date of Birth: ${athlete.icu_date_of_birth}\n`;

        const sportSettings = athlete.sportSettings as Record<string, unknown>[] | undefined;
        if (sportSettings?.length) {
          text += "\nSport Settings:\n";
          for (const s of sportSettings) {
            text += `\n  ${formatSportSettingLabel(s)}:\n`;
            if (s.ftp) text += `    FTP: ${s.ftp}w\n`;
            if (s.indoor_ftp && s.indoor_ftp !== s.ftp) text += `    Indoor FTP: ${s.indoor_ftp}w\n`;
            if (s.lthr) text += `    LTHR: ${s.lthr} bpm\n`;
            if (s.max_hr) text += `    Max HR: ${s.max_hr} bpm\n`;
            if (s.threshold_pace) {
              text += `    Threshold Pace: ${formatThresholdPace(
                s.threshold_pace as number,
                s.pace_units as string | undefined,
              )}\n`;
            }
            const powerZones = s.power_zones as number[] | undefined;
            if (powerZones?.length) {
              text += `    Power Zones (W): ${powerZones.join(", ")}\n`;
            }
            const hrZones = s.hr_zones as number[] | undefined;
            if (hrZones?.length) {
              text += `    HR Zones (bpm): ${hrZones.join(", ")}\n`;
            }
          }
        }

        const bikes = athlete.bikes as { name: string; distance: number }[] | undefined;
        const shoes = athlete.shoes as { name: string; distance: number }[] | undefined;

        if (bikes?.length) {
          text += "\nBikes:\n";
          for (const b of bikes) {
            text += `  ${b.name}: ${formatDistance(b.distance)}\n`;
          }
        }
        if (shoes?.length) {
          text += "\nShoes:\n";
          for (const s of shoes) {
            text += `  ${s.name}: ${formatDistance(s.distance)}\n`;
          }
        }

        return text;
      }, "fetching athlete profile");
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
    },
    async ({ query, limit }) => {
      return toolHandler(async () => {
        const results = await client.get<Record<string, unknown>[]>(
          `/athlete/${client.athleteId}/activities/search`,
          { q: query, limit: String(limit) }
        );
        if (!results?.length) return `No activities found matching "${query}".`;

        let text = `Search results for "${query}":\n\n`;
        for (const a of results) {
          text += `ID: ${a.id}\n`;
          text += `  Name: ${a.name ?? "Unnamed"}\n`;
          text += `  Date: ${(a.start_date_local as string)?.slice(0, 10) ?? "N/A"}\n`;
          text += `  Type: ${a.type ?? "N/A"}\n`;
          if (a.distance) text += `  Distance: ${formatDistance(a.distance as number)}\n`;
          if (a.moving_time) text += `  Duration: ${formatDuration(a.moving_time as number)}\n`;
          if (a.tags) text += `  Tags: ${a.tags}\n`;
          text += "\n";
        }
        return text;
      }, "searching activities");
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
    },
    async ({ activity_type, start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      return toolHandler(async () => {
        const data = await client.get<{ list: Record<string, unknown>[] }>(
          `/athlete/${client.athleteId}/power-curves`,
          { type: activity_type, oldest: start_date ?? start, newest: end_date ?? end }
        );
        const curves = data?.list ?? [];
        if (!curves.length) return "No power curve data found.";

        let text = `Power Curves (${activity_type}):\n`;
        for (const curve of curves) {
          text += `\n${curve.label} (${(curve.start_date_local as string)?.slice(0, 10)} – ${(curve.end_date_local as string)?.slice(0, 10)}):\n`;
          const secs = curve.secs as number[] ?? [];
          const watts = curve.watts as number[] ?? [];
          const wkg = curve.watts_per_kg as number[] ?? [];
          for (const [dur, label] of POWER_CURVE_DURATIONS) {
            const idx = secs.indexOf(dur);
            if (idx !== -1 && watts[idx]) {
              const wkgVal = wkg[idx] ? ` (${wkg[idx].toFixed(2)} w/kg)` : "";
              text += `  ${label.padEnd(6)}: ${watts[idx]}w${wkgVal}\n`;
            }
          }
          if (curve.vo2max_5m) text += `  VO2max (5min estimate): ${(curve.vo2max_5m as number).toFixed(1)}\n`;
        }
        return text;
      }, "fetching power curves");
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
    },
    async ({ activity_type, start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      return toolHandler(async () => {
        const data = await client.get<{ list: Record<string, unknown>[] }>(
          `/athlete/${client.athleteId}/pace-curves`,
          { type: activity_type, oldest: start_date ?? start, newest: end_date ?? end }
        );
        const curves = data?.list ?? [];
        if (!curves.length) return "No pace curve data found.";

        let text = `Pace Curves (${activity_type}):\n`;
        for (const curve of curves) {
          text += `\n${curve.label} (${(curve.start_date_local as string)?.slice(0, 10)} – ${(curve.end_date_local as string)?.slice(0, 10)}):\n`;
          const models = curve.paceModels as { type: string; criticalSpeed: number; dPrime: number; r2: number }[] | undefined;
          if (models?.length) {
            for (const m of models) {
              text += `  Model (${m.type}):\n`;
              text += `    Critical Speed: ${metersPerSecToMinPerKm(m.criticalSpeed)} (${m.criticalSpeed.toFixed(3)} m/s)\n`;
              text += `    D': ${m.dPrime.toFixed(1)}m\n`;
              if (m.r2) text += `    R²: ${m.r2.toFixed(3)}\n`;
            }
          }
        }
        return text;
      }, "fetching pace curves");
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
    },
    async ({ activity_type, start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      return toolHandler(async () => {
        const data = await client.get<{ list: Record<string, unknown>[] }>(
          `/athlete/${client.athleteId}/hr-curves`,
          { type: activity_type, oldest: start_date ?? start, newest: end_date ?? end }
        );
        const curves = data?.list ?? [];
        if (!curves.length) return "No HR curve data found.";

        let text = `HR Curves (${activity_type}):\n`;
        for (const curve of curves) {
          text += `\n${curve.label} (${(curve.start_date_local as string)?.slice(0, 10)} – ${(curve.end_date_local as string)?.slice(0, 10)}):\n`;
          const secs = curve.secs as number[] ?? [];
          const values = curve.values as number[] ?? [];
          for (const [dur, label] of HR_CURVE_DURATIONS) {
            const idx = secs.indexOf(dur);
            if (idx !== -1 && values[idx]) {
              text += `  ${label.padEnd(6)}: ${values[idx]} bpm\n`;
            }
          }
        }
        return text;
      }, "fetching HR curves");
    }
  );

  server.registerTool(
    "get_gear",
    {
      description: "List the athlete's gear (bikes, shoes, equipment) with usage statistics.",
      inputSchema: {},
    },
    async () => {
      return toolHandler(async () => {
        const gear = await client.get<Record<string, unknown>[]>(`/athlete/${client.athleteId}/gear`);
        if (!gear?.length) return "No gear found.";

        const byType: Record<string, typeof gear> = {};
        for (const item of gear) {
          const type = (item.type as string) ?? "Other";
          (byType[type] ??= []).push(item);
        }

        let text = "Gear:\n";
        for (const [type, items] of Object.entries(byType)) {
          text += `\n${type}:\n`;
          for (const item of items) {
            if (item.retired) continue;
            text += `  ${item.name}`;
            if (item.distance) text += ` — ${formatDistance(item.distance as number)}`;
            if (item.activities) text += ` over ${item.activities} activities`;
            if (item.time) text += ` (${formatDuration(item.time as number)})`;
            text += "\n";
          }
        }

        // Show retired gear separately
        const retired = gear.filter(g => g.retired);
        if (retired.length) {
          text += "\nRetired:\n";
          for (const item of retired) {
            text += `  ${item.name} (${item.type}) — ${formatDistance(item.distance as number)}\n`;
          }
        }

        return text;
      }, "fetching gear");
    }
  );

} // end registerAthleteTools
