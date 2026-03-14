// src/formatting.ts
// Complete port of intervals-mcp-server/src/intervals_mcp_server/utils/formatting.py

type R = Record<string, unknown>;

function get(obj: R, ...keys: string[]): unknown {
  for (const k of keys) { if (obj[k] != null) return obj[k]; }
  return "N/A";
}

export function formatActivitySummary(a: R): string {
  // Port of format_activity_summary()
  let startTime = String(get(a, "startTime", "start_date_local", "start_date"));
  if (startTime.length > 10) {
    try {
      const dt = new Date(startTime);
      startTime = dt.toISOString().replace("T", " ").slice(0, 19);
    } catch { /* keep as-is */ }
  }

  let rpe: string = String(get(a, "perceived_exertion", "icu_rpe"));
  if (rpe !== "N/A" && !isNaN(Number(rpe))) rpe = `${rpe}/10`;

  let feel: string = String(get(a, "feel"));
  if (feel !== "N/A" && !isNaN(Number(feel))) feel = `${feel}/5`;

  return `
Activity: ${get(a, "name") ?? "Unnamed"}
ID: ${get(a, "id")}
Type: ${get(a, "type")}
Date: ${startTime}
Description: ${get(a, "description")}
Distance: ${get(a, "distance")} meters
Duration: ${get(a, "duration", "elapsed_time")} seconds
Moving Time: ${get(a, "moving_time")} seconds
Elevation Gain: ${get(a, "elevationGain", "total_elevation_gain")} meters
Elevation Loss: ${get(a, "total_elevation_loss")} meters

Power Data:
Average Power: ${get(a, "avgPower", "icu_average_watts", "average_watts")} watts
Weighted Avg Power: ${get(a, "icu_weighted_avg_watts")} watts
Training Load: ${get(a, "trainingLoad", "icu_training_load")}
FTP: ${get(a, "icu_ftp")} watts
Kilojoules: ${get(a, "icu_joules")}
Intensity: ${get(a, "icu_intensity")}
Power:HR Ratio: ${get(a, "icu_power_hr")}
Variability Index: ${get(a, "icu_variability_index")}

Heart Rate Data:
Average Heart Rate: ${get(a, "avgHr", "average_heartrate")} bpm
Max Heart Rate: ${get(a, "max_heartrate")} bpm
LTHR: ${get(a, "lthr")} bpm
Resting HR: ${get(a, "icu_resting_hr")} bpm
Decoupling: ${get(a, "decoupling")}

Other Metrics:
Cadence: ${get(a, "average_cadence")} rpm
Calories: ${get(a, "calories")}
Average Speed: ${get(a, "average_speed")} m/s
Max Speed: ${get(a, "max_speed")} m/s
Average Stride: ${get(a, "average_stride")}
L/R Balance: ${get(a, "avg_lr_balance")}
Weight: ${get(a, "icu_weight")} kg
RPE: ${rpe}
Session RPE: ${get(a, "session_rpe")}
Feel: ${feel}

Environment:
Trainer: ${get(a, "trainer")}
Average Temp: ${get(a, "average_temp")}°C
Min Temp: ${get(a, "min_temp")}°C
Max Temp: ${get(a, "max_temp")}°C
Avg Wind Speed: ${get(a, "average_wind_speed")} km/h
Headwind %: ${get(a, "headwind_percent")}%
Tailwind %: ${get(a, "tailwind_percent")}%

Training Metrics:
Fitness (CTL): ${get(a, "icu_ctl")}
Fatigue (ATL): ${get(a, "icu_atl")}
TRIMP: ${get(a, "trimp")}
Polarization Index: ${get(a, "polarization_index")}
Power Load: ${get(a, "power_load")}
HR Load: ${get(a, "hr_load")}
Pace Load: ${get(a, "pace_load")}
Efficiency Factor: ${get(a, "icu_efficiency_factor")}

Device Info:
Device: ${get(a, "device_name")}
Power Meter: ${get(a, "power_meter")}
File Type: ${get(a, "file_type")}
`.trim();
}

export function formatIntervals(data: R): string {
  // Port of format_intervals()
  let result = `Intervals Analysis:\n\nID: ${get(data, "id")}\nAnalyzed: ${get(data, "analyzed")}\n\n`;

  const intervals = (data.icu_intervals as R[]) ?? [];
  if (intervals.length) {
    result += "Individual Intervals:\n\n";
    for (let i = 0; i < intervals.length; i++) {
      const iv = intervals[i];
      result += `[${i + 1}] ${iv.label ?? `Interval ${i + 1}`} (${get(iv, "type")})\n`;
      result += `Duration: ${get(iv, "elapsed_time")} seconds (moving: ${get(iv, "moving_time")} seconds)\n`;
      result += `Distance: ${get(iv, "distance")} meters\n`;
      result += `Start-End Indices: ${get(iv, "start_index")}-${get(iv, "end_index")}\n\n`;
      result += `Power Metrics:\n`;
      result += `  Average Power: ${get(iv, "average_watts")} watts (${get(iv, "average_watts_kg")} W/kg)\n`;
      result += `  Max Power: ${get(iv, "max_watts")} watts (${get(iv, "max_watts_kg")} W/kg)\n`;
      result += `  Weighted Avg Power: ${get(iv, "weighted_average_watts")} watts\n`;
      result += `  Intensity: ${get(iv, "intensity")}\n`;
      result += `  Training Load: ${get(iv, "training_load")}\n`;
      result += `  Joules: ${get(iv, "joules")}\n`;
      result += `  Joules > FTP: ${get(iv, "joules_above_ftp")}\n`;
      result += `  Power Zone: ${get(iv, "zone")} (${get(iv, "zone_min_watts")}-${get(iv, "zone_max_watts")} watts)\n`;
      result += `  W' Balance: Start ${get(iv, "wbal_start")}, End ${get(iv, "wbal_end")}\n`;
      result += `  L/R Balance: ${get(iv, "avg_lr_balance")}\n`;
      result += `  Variability: ${get(iv, "w5s_variability")}\n`;
      result += `  Torque: Avg ${get(iv, "average_torque")}, Min ${get(iv, "min_torque")}, Max ${get(iv, "max_torque")}\n\n`;
      result += `Heart Rate & Metabolic:\n`;
      result += `  Heart Rate: Avg ${get(iv, "average_heartrate")}, Min ${get(iv, "min_heartrate")}, Max ${get(iv, "max_heartrate")} bpm\n`;
      result += `  Decoupling: ${get(iv, "decoupling")}\n`;
      result += `  DFA α1: ${get(iv, "average_dfa_a1")}\n`;
      result += `  Respiration: ${get(iv, "average_respiration")} breaths/min\n`;
      result += `  EPOC: ${get(iv, "average_epoc")}\n`;
      result += `  SmO2: ${get(iv, "average_smo2")}% / ${get(iv, "average_smo2_2")}%\n`;
      result += `  THb: ${get(iv, "average_thb")} / ${get(iv, "average_thb_2")}\n\n`;
      result += `Speed & Cadence:\n`;
      result += `  Speed: Avg ${get(iv, "average_speed")}, Min ${get(iv, "min_speed")}, Max ${get(iv, "max_speed")} m/s\n`;
      result += `  GAP: ${get(iv, "gap")} m/s\n`;
      result += `  Cadence: Avg ${get(iv, "average_cadence")}, Min ${get(iv, "min_cadence")}, Max ${get(iv, "max_cadence")} rpm\n`;
      result += `  Stride: ${get(iv, "average_stride")}\n\n`;
      result += `Elevation & Environment:\n`;
      result += `  Elevation Gain: ${get(iv, "total_elevation_gain")} meters\n`;
      result += `  Altitude: Min ${get(iv, "min_altitude")}, Max ${get(iv, "max_altitude")} meters\n`;
      result += `  Gradient: ${get(iv, "average_gradient")}%\n`;
      result += `  Temperature: ${get(iv, "average_temp")}°C (Weather: ${get(iv, "average_weather_temp")}°C, Feels like: ${get(iv, "average_feels_like")}°C)\n`;
      result += `  Wind: Speed ${get(iv, "average_wind_speed")} km/h, Gust ${get(iv, "average_wind_gust")} km/h, Direction ${get(iv, "prevailing_wind_deg")}°\n`;
      result += `  Headwind: ${get(iv, "headwind_percent")}%, Tailwind: ${get(iv, "tailwind_percent")}%\n\n`;
    }
  }

  const groups = (data.icu_groups as R[]) ?? [];
  if (groups.length) {
    result += "Interval Groups:\n\n";
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      result += `Group: ${get(g, "id")} (Contains ${get(g, "count")} intervals)\n`;
      result += `Duration: ${get(g, "elapsed_time")} seconds (moving: ${get(g, "moving_time")} seconds)\n`;
      result += `Distance: ${get(g, "distance")} meters\n`;
      result += `Power: Avg ${get(g, "average_watts")} watts (${get(g, "average_watts_kg")} W/kg), Max ${get(g, "max_watts")} watts\n`;
      result += `W. Avg Power: ${get(g, "weighted_average_watts")} watts, Intensity: ${get(g, "intensity")}\n`;
      result += `Heart Rate: Avg ${get(g, "average_heartrate")}, Max ${get(g, "max_heartrate")} bpm\n`;
      result += `Speed: Avg ${get(g, "average_speed")}, Max ${get(g, "max_speed")} m/s\n`;
      result += `Cadence: Avg ${get(g, "average_cadence")}, Max ${get(g, "max_cadence")} rpm\n\n`;
    }
  }
  return result;
}

export function formatEventSummary(e: R): string {
  // Port of format_event_summary()
  const eventDate = get(e, "start_date_local", "date");
  const eventType = e.workout ? "Workout" : e.race ? "Race" : "Other";
  return `Date: ${eventDate}\nID: ${get(e, "id")}\nType: ${eventType}\nName: ${get(e, "name") ?? "Unnamed"}\nDescription: ${get(e, "description")}`;
}

export function formatEventDetails(e: R): string {
  // Port of format_event_details()
  let out = `Event Details:\n\nID: ${get(e, "id")}\nDate: ${get(e, "date")}\nName: ${get(e, "name") ?? "Unnamed"}\nDescription: ${get(e, "description")}`;

  const workout = e.workout as R | undefined;
  if (workout) {
    out += `\n\nWorkout Information:\nWorkout ID: ${get(workout, "id")}\nSport: ${get(workout, "sport")}\nDuration: ${get(workout, "duration")} seconds\nTSS: ${get(workout, "tss")}`;
    const ivs = workout.intervals as unknown[] | undefined;
    if (Array.isArray(ivs)) out += `\nIntervals: ${ivs.length}`;
  }

  if (e.race) {
    out += `\n\nRace Information:\nPriority: ${get(e, "priority")}\nResult: ${get(e, "result")}`;
  }

  const cal = e.calendar as R | undefined;
  if (cal) out += `\n\nCalendar: ${get(cal, "name")}`;

  return out;
}

export function formatWellnessEntry(w: R): string {
  // Port of format_wellness_entry() — all sections
  const lines: string[] = ["Wellness Data:", `Date: ${get(w, "id", "date")}`, ""];

  // Training metrics
  const tm: string[] = [];
  for (const [k, label] of [["ctl","Fitness (CTL)"],["atl","Fatigue (ATL)"],["rampRate","Ramp Rate"],["ctlLoad","CTL Load"],["atlLoad","ATL Load"]] as [string,string][]) {
    if (w[k] != null) tm.push(`- ${label}: ${w[k]}`);
  }
  if (tm.length) { lines.push("Training Metrics:", ...tm, ""); }

  // Sport-specific eFTP
  const si = w.sportInfo as R[] | undefined;
  if (Array.isArray(si) && si.length) {
    const slines = si.filter(s => s.eftp != null).map(s => `- ${s.type}: eFTP = ${s.eftp}`);
    if (slines.length) lines.push("Sport-Specific Info:", ...slines, "");
  }

  // Vital signs
  const vs: string[] = [];
  for (const [k, label, unit] of [
    ["weight","Weight","kg"],["restingHR","Resting HR","bpm"],["hrv","HRV",""],
    ["hrvSDNN","HRV SDNN",""],["avgSleepingHR","Average Sleeping HR","bpm"],
    ["spO2","SpO2","%"],["respiration","Respiration","breaths/min"],
    ["bloodGlucose","Blood Glucose","mmol/L"],["lactate","Lactate","mmol/L"],
    ["vo2max","VO2 Max","ml/kg/min"],["bodyFat","Body Fat","%"],
    ["abdomen","Abdomen","cm"],["baevskySI","Baevsky Stress Index",""],
  ] as [string,string,string][]) {
    if (w[k] != null) {
      if (k === "restingHR" && w.systolic != null && w.diastolic != null) {
        vs.push(`- Blood Pressure: ${w.systolic}/${w.diastolic} mmHg`);
      }
      vs.push(`- ${label}: ${w[k]}${unit ? " " + unit : ""}`);
    }
  }
  if (vs.length) lines.push("Vital Signs:", ...vs, "");

  // Sleep & Recovery
  const sl: string[] = [];
  const sleepHours = w.sleepSecs != null
    ? `${(Number(w.sleepSecs) / 3600).toFixed(2)}`
    : w.sleepHours != null ? String(w.sleepHours) : null;
  if (sleepHours) sl.push(`  Sleep: ${sleepHours} hours`);
  if (w.sleepQuality != null) {
    const q: Record<number, string> = {1:"Great",2:"Good",3:"Average",4:"Poor"};
    sl.push(`  Sleep Quality: ${w.sleepQuality} (${q[Number(w.sleepQuality)] ?? w.sleepQuality})`);
  }
  if (w.sleepScore != null) sl.push(`  Device Sleep Score: ${w.sleepScore}/100`);
  if (w.readiness != null) sl.push(`  Readiness: ${w.readiness}/10`);
  if (sl.length) lines.push("Sleep & Recovery:", ...sl, "");

  // Menstrual
  if (w.menstrualPhase != null || w.menstrualPhasePredicted != null) {
    const ml: string[] = [];
    if (w.menstrualPhase != null) ml.push(`  Menstrual Phase: ${String(w.menstrualPhase).charAt(0).toUpperCase() + String(w.menstrualPhase).slice(1)}`);
    if (w.menstrualPhasePredicted != null) ml.push(`  Predicted Phase: ${String(w.menstrualPhasePredicted).charAt(0).toUpperCase() + String(w.menstrualPhasePredicted).slice(1)}`);
    lines.push("Menstrual Tracking:", ...ml, "");
  }

  // Subjective feelings
  const sf: string[] = [];
  for (const [k, label] of [["soreness","Soreness"],["fatigue","Fatigue"],["stress","Stress"],["mood","Mood"],["motivation","Motivation"],["injury","Injury Level"]] as [string,string][]) {
    if (w[k] != null) sf.push(`  ${label}: ${w[k]}/10`);
  }
  if (sf.length) lines.push("Subjective Feelings:", ...sf, "");

  // Nutrition
  const nf: string[] = [];
  if (w.kcalConsumed != null) nf.push(`- Calories Consumed: ${w.kcalConsumed}`);
  if (w.hydrationVolume != null) nf.push(`- Hydration Volume: ${w.hydrationVolume}`);
  if (w.hydration != null) nf.push(`  Hydration Score: ${w.hydration}/10`);
  if (nf.length) lines.push("Nutrition & Hydration:", ...nf, "");

  // Steps
  if (w.steps != null) lines.push("Activity:", `- Steps: ${w.steps}`, "");

  // Comments / lock
  if (w.comments) lines.push(`Comments: ${w.comments}`);
  if ("locked" in w) lines.push(`Status: ${w.locked ? "Locked" : "Unlocked"}`);

  return lines.join("\n");
}
