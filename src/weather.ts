// Pure utility functions — all exported for testing

const VARIABLES = "temperature_2m,apparent_temperature,windspeed_10m,winddirection_10m,precipitation,snowfall,cloudcover,weathercode";

export function isHeadwind(travelBearing: number, windFromDeg: number): boolean {
  // NOTE: JavaScript % returns negative for negative operands (unlike Python).
  // The `(... + 360) % 360` guard ensures a non-negative result before subtracting 180.
  const delta = Math.abs((((travelBearing - windFromDeg + 180) % 360) + 360) % 360 - 180);
  return delta < 90;
}

export function degToCardinal(deg: number): string {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

export function weathercodeToDescription(code: number): string {
  if (code === 0) return "Clear sky";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 55) return "Drizzle";
  if (code >= 61 && code <= 65) return "Rain";
  if (code >= 71 && code <= 75) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 95) return "Thunderstorm";
  return "Mixed conditions";
}

export function tempBar(temp: number, feelsLike: number, width = 20): string {
  const lo = 15, hi = 45;
  const bar = (val: number) => {
    const filled = Math.max(0, Math.min(width, Math.round((val - lo) / (hi - lo) * width)));
    return "█".repeat(filled) + "░".repeat(width - filled);
  };
  return [
    `  Temp       ${temp.toFixed(1).padStart(5)}°C  ${bar(temp)}`,
    `  Feels like ${feelsLike.toFixed(1).padStart(5)}°C  ${bar(feelsLike)}`,
  ].join("\n");
}

export function selectOpenMeteoUrl(lat: number, lng: number, date: string): string {
  const daysAgo = Math.floor((Date.now() - new Date(date).getTime()) / 864e5);
  if (daysAgo <= 5) {
    return `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lng}&hourly=${VARIABLES}` +
      `&past_days=${Math.min(daysAgo + 1, 5)}&forecast_days=1` +
      `&timezone=auto&wind_speed_unit=kmh`;
  }
  return `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${lat}&longitude=${lng}&start_date=${date}&end_date=${date}` +
    `&hourly=${VARIABLES}&timezone=auto&wind_speed_unit=kmh`;
}

interface WaypointWeather {
  temp: number;
  feelsLike: number;
  windSpeed: number;
  windDeg: number;
  precipitation: number;
  snowfall: number;
  clouds: number;
  weathercode: number;
}

async function fetchWaypointWeather(
  lat: number, lng: number, date: string, hour: number
): Promise<WaypointWeather> {
  const url = selectOpenMeteoUrl(lat, lng, date);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const data = await res.json() as { hourly: Record<string, number[]> };
  const h = data.hourly;
  const target = `${date}T${String(hour).padStart(2, "0")}:00`;
  const idx = h.time?.findIndex((t: unknown) => String(t).startsWith(target.slice(0, 13))) ?? 0;
  const i = idx >= 0 ? idx : 0;
  return {
    temp: h.temperature_2m[i],
    feelsLike: h.apparent_temperature[i],
    windSpeed: h.windspeed_10m[i],
    windDeg: h.winddirection_10m[i],
    precipitation: h.precipitation[i],
    snowfall: h.snowfall[i],
    clouds: h.cloudcover[i],
    weathercode: h.weathercode[i],
  };
}

export interface WeatherResult {
  description: string;
  average_temp: number;
  average_feels_like: number;
  average_wind_speed: number;
  prevailing_wind_deg: number;
  prevailing_wind_cardinal: string;
  headwind_percent: number;
  tailwind_percent: number;
  avg_yaw: number | null;
  max_rain: number;
  max_snow: number;
  average_clouds: number;
  temp_bar: string;
  source: "open-meteo";
}

export async function computeActivityWeather(
  date: string,
  startHour: number,
  lats: number[],
  lngs: number[],
  bearings: (number | null)[],
  timeElapsed: number[],
  sampleOriginalIndices: number[],
): Promise<WeatherResult> {
  const weatherPoints = await Promise.all(
    lats.map((lat, i) => {
      const hour = (startHour + Math.floor((timeElapsed[i] ?? 0) / 3600)) % 24;
      return fetchWaypointWeather(lat, lngs[i], date, hour);
    })
  );

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  const avgTemp = Math.round(avg(weatherPoints.map(w => w.temp)) * 10) / 10;
  const avgFeels = Math.round(avg(weatherPoints.map(w => w.feelsLike)) * 10) / 10;
  const avgWind = Math.round(avg(weatherPoints.map(w => w.windSpeed)) * 10) / 10;
  // Circular mean for angular data — arithmetic mean is wrong for wind direction
  // (e.g. mean of 350° and 10° should be 0°, not 180°)
  const sinSum = weatherPoints.reduce((s, w) => s + Math.sin(w.windDeg * Math.PI / 180), 0);
  const cosSum = weatherPoints.reduce((s, w) => s + Math.cos(w.windDeg * Math.PI / 180), 0);
  const avgWindDeg = Math.round(((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360 * 10) / 10;
  const avgClouds = Math.round(avg(weatherPoints.map(w => w.clouds)) * 10) / 10;
  const maxRain = Math.max(...weatherPoints.map(w => w.precipitation));
  const maxSnow = Math.max(...weatherPoints.map(w => w.snowfall));
  const worstCode = Math.max(...weatherPoints.map(w => w.weathercode));

  let hwCount = 0, twCount = 0, yawSum = 0, total = 0;
  for (let i = 0; i < bearings.length; i++) {
    const b = bearings[i];
    if (b == null) continue;
    const nearestWpIdx = sampleOriginalIndices.reduce((best, wpOrigIdx, wi) =>
      Math.abs(wpOrigIdx - i) < Math.abs(sampleOriginalIndices[best] - i) ? wi : best, 0
    );
    const windFrom = weatherPoints[nearestWpIdx].windDeg;
    const delta = Math.abs((((b - windFrom + 180) % 360) + 360) % 360 - 180);
    yawSum += delta;
    if (isHeadwind(b, windFrom)) hwCount++; else twCount++;
    total++;
  }

  return {
    description: weathercodeToDescription(worstCode),
    average_temp: avgTemp,
    average_feels_like: avgFeels,
    average_wind_speed: avgWind,
    prevailing_wind_deg: avgWindDeg,
    prevailing_wind_cardinal: degToCardinal(avgWindDeg),
    headwind_percent: total ? Math.round(hwCount / total * 1000) / 10 : 0,
    tailwind_percent: total ? Math.round(twCount / total * 1000) / 10 : 0,
    avg_yaw: total ? Math.round(yawSum / total * 10) / 10 : null,
    max_rain: maxRain,
    max_snow: maxSnow,
    average_clouds: avgClouds,
    temp_bar: tempBar(avgTemp, avgFeels),
    source: "open-meteo",
  };
}
