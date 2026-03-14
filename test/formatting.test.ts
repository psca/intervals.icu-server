import { describe, it, expect } from "vitest";
import {
  formatActivitySummary,
  formatIntervals,
  formatEventSummary,
  formatEventDetails,
  formatWellnessEntry,
} from "../src/formatting";

describe("formatActivitySummary", () => {
  it("includes activity name and type", () => {
    const result = formatActivitySummary({
      name: "Morning Ride",
      type: "Ride",
      start_date_local: "2026-03-10T09:00:00",
      distance: 50000,
      moving_time: 5400,
      icu_training_load: 65,
    });
    expect(result).toContain("Morning Ride");
    expect(result).toContain("Ride");
  });

  it("handles missing optional fields gracefully", () => {
    const result = formatActivitySummary({ name: "Unnamed", type: "Run" });
    expect(result).toContain("Unnamed");
  });
});

describe("formatWellnessEntry", () => {
  it("includes date and HRV if present", () => {
    const result = formatWellnessEntry({
      date: "2026-03-10",
      hrv: 52,
      restingHR: 48,
    });
    expect(result).toContain("2026-03-10");
    expect(result).toContain("52");
  });
});

describe("formatEventSummary", () => {
  it("includes event name and date", () => {
    const result = formatEventSummary({
      name: "Easy Run",
      start_date_local: "2026-03-15T07:00:00",
      type: "Run",
    });
    expect(result).toContain("Easy Run");
    expect(result).toContain("2026-03-15");
  });
});
