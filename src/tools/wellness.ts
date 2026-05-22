import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IntervalsClient } from "../client.js";
import { defaultDateRange } from "../utils.js";
import { textResult } from "./result.js";

function normalizeWellnessEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const sleepHours = entry.sleepSecs != null
    ? Number((Number(entry.sleepSecs) / 3600).toFixed(2))
    : typeof entry.sleepHours === "number" ? entry.sleepHours : null;

  return {
    date: entry.id ?? entry.date ?? null,
    ctl: entry.ctl ?? null,
    atl: entry.atl ?? null,
    ramp_rate: entry.rampRate ?? null,
    ctl_load: entry.ctlLoad ?? null,
    atl_load: entry.atlLoad ?? null,
    weight_kg: entry.weight ?? null,
    resting_hr_bpm: entry.restingHR ?? null,
    hrv: entry.hrv ?? null,
    hrv_sdnn: entry.hrvSDNN ?? null,
    avg_sleeping_hr_bpm: entry.avgSleepingHR ?? null,
    spo2: entry.spO2 ?? null,
    respiration: entry.respiration ?? null,
    blood_glucose: entry.bloodGlucose ?? null,
    lactate: entry.lactate ?? null,
    vo2max: entry.vo2max ?? null,
    body_fat: entry.bodyFat ?? null,
    abdomen_cm: entry.abdomen ?? null,
    baevsky_stress_index: entry.baevskySI ?? null,
    sleep_hours: sleepHours,
    sleep_quality: entry.sleepQuality ?? null,
    sleep_score: entry.sleepScore ?? null,
    readiness: entry.readiness ?? null,
    menstrual_phase: entry.menstrualPhase ?? null,
    menstrual_phase_predicted: entry.menstrualPhasePredicted ?? null,
    soreness: entry.soreness ?? null,
    fatigue: entry.fatigue ?? null,
    stress: entry.stress ?? null,
    mood: entry.mood ?? null,
    motivation: entry.motivation ?? null,
    injury: entry.injury ?? null,
    kcal_consumed: entry.kcalConsumed ?? null,
    hydration_volume: entry.hydrationVolume ?? null,
    hydration: entry.hydration ?? null,
    steps: entry.steps ?? null,
    comments: entry.comments ?? null,
    locked: entry.locked ?? null,
    sport_info: Array.isArray(entry.sportInfo) ? entry.sportInfo : [],
  };
}

export function registerWellnessTools(server: McpServer, client: IntervalsClient): void {
  server.registerTool(
    "get_wellness_data",
    {
      description: "Get wellness data (HRV, resting HR, CTL, ATL, TSB, weight, sleep) for the athlete",
      inputSchema: {
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (default: today)"),
      },
      outputSchema: {
        entries: z.array(z.record(z.string(), z.unknown())),
        count: z.number().int(),
      },
    },
    async ({ start_date, end_date }) => {
      const { start, end } = defaultDateRange();
      const params = { oldest: start_date ?? start, newest: end_date ?? end };

      try {
        const result = await client.get<unknown[]>(
          `/athlete/${client.athleteId}/wellness`,
          params
        );
        if (!result || (Array.isArray(result) && result.length === 0)) {
          return textResult({ entries: [], count: 0 });
        }
        const entries = Array.isArray(result) ? result : Object.values(result as object);
        return textResult({
          entries: entries.map(e => normalizeWellnessEntry(e as Record<string, unknown>)),
          count: entries.length,
        });
      } catch (e) {
        return { content: [{ type: "text", text: `Error fetching wellness data: ${e}` }], isError: true };
      }
    }
  );
}
