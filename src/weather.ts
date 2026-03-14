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
