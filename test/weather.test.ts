import { describe, it, expect } from "vitest";
import {
  isHeadwind,
  degToCardinal,
  weathercodeToDescription,
  tempBar,
  selectOpenMeteoUrl,
} from "../src/weather";

describe("isHeadwind", () => {
  it("returns true when wind is directly in face (delta = 0)", () => {
    expect(isHeadwind(90, 90)).toBe(true);
  });

  it("returns true when delta is just under 90°", () => {
    expect(isHeadwind(0, 89)).toBe(true);
  });

  it("returns false when delta is exactly 90°", () => {
    expect(isHeadwind(0, 90)).toBe(false);
  });

  it("returns false when wind is from behind (delta = 180)", () => {
    expect(isHeadwind(90, 270)).toBe(false);
  });

  it("handles wrap-around correctly (positive intermediate)", () => {
    expect(isHeadwind(350, 10)).toBe(true);
  });

  it("handles wrap-around with negative intermediate — JS % trap", () => {
    expect(isHeadwind(10, 350)).toBe(true);
  });
});

describe("degToCardinal", () => {
  it("converts 0 to N", () => expect(degToCardinal(0)).toBe("N"));
  it("converts 90 to E", () => expect(degToCardinal(90)).toBe("E"));
  it("converts 180 to S", () => expect(degToCardinal(180)).toBe("S"));
  it("converts 270 to W", () => expect(degToCardinal(270)).toBe("W"));
  it("converts 45 to NE", () => expect(degToCardinal(45)).toBe("NE"));
});

describe("weathercodeToDescription", () => {
  it("maps 0 to Clear sky", () => expect(weathercodeToDescription(0)).toBe("Clear sky"));
  it("maps 1 to Partly cloudy", () => expect(weathercodeToDescription(1)).toBe("Partly cloudy"));
  it("maps 2 to Partly cloudy", () => expect(weathercodeToDescription(2)).toBe("Partly cloudy"));
  it("maps 3 to Overcast", () => expect(weathercodeToDescription(3)).toBe("Overcast"));
  it("maps 45 to Foggy", () => expect(weathercodeToDescription(45)).toBe("Foggy"));
  it("maps 48 to Foggy", () => expect(weathercodeToDescription(48)).toBe("Foggy"));
  it("maps 51 to Drizzle", () => expect(weathercodeToDescription(51)).toBe("Drizzle"));
  it("maps 61 to Rain", () => expect(weathercodeToDescription(61)).toBe("Rain"));
  it("maps 71 to Snow", () => expect(weathercodeToDescription(71)).toBe("Snow"));
  it("maps 80 to Rain showers", () => expect(weathercodeToDescription(80)).toBe("Rain showers"));
  it("maps 95 to Thunderstorm", () => expect(weathercodeToDescription(95)).toBe("Thunderstorm"));
  it("maps 99 to Thunderstorm", () => expect(weathercodeToDescription(99)).toBe("Thunderstorm"));
  it("maps unknown code (e.g. 100) to Mixed conditions", () => expect(weathercodeToDescription(4)).toBe("Mixed conditions"));
});

describe("tempBar", () => {
  it("returns two lines", () => {
    const result = tempBar(20, 18);
    expect(result.split("\n")).toHaveLength(2);
  });

  it("contains temperature values", () => {
    const result = tempBar(26.8, 31.0);
    expect(result).toContain("26.8");
    expect(result).toContain("31.0");
  });

  it("uses block characters", () => {
    const result = tempBar(30, 30);
    expect(result).toContain("█");
    expect(result).toContain("░");
  });
});

describe("selectOpenMeteoUrl", () => {
  it("uses forecast endpoint for recent activity (≤5 days ago)", () => {
    const recentDate = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const url = selectOpenMeteoUrl(48.8, 2.3, recentDate);
    expect(url).toContain("api.open-meteo.com/v1/forecast");
    expect(url).toContain("past_days=");
  });

  it("uses archive endpoint for old activity (>5 days ago)", () => {
    const oldDate = "2025-01-01";
    const url = selectOpenMeteoUrl(48.8, 2.3, oldDate);
    expect(url).toContain("archive-api.open-meteo.com/v1/archive");
    expect(url).toContain("start_date=2025-01-01");
  });
});
