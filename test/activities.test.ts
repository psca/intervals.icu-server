import { describe, it, expect } from "vitest";
import { computeSampleIndices } from "../src/tools/activities";

describe("computeSampleIndices", () => {
  it("returns stride-based indices when timeData is empty", () => {
    const indices = computeSampleIndices([], 100, 10);
    expect(indices).toEqual(Array.from({ length: 10 }, (_, i) => i * 10));
  });

  it("returns empty array when totalPoints is 0 and timeData is empty", () => {
    const indices = computeSampleIndices([], 0, 10);
    expect(indices).toEqual([]);
  });

  it("samples at interval boundaries from time data", () => {
    // time data: 0, 1, 2, ... 59 seconds; interval = 30s
    const timeData = Array.from({ length: 60 }, (_, i) => i);
    const indices = computeSampleIndices(timeData, 60, 30);
    // Index 0 (t=0) and index 30 (t=30) are multiples of 30
    expect(indices).toEqual([0, 30]);
  });

  it("always includes index 0 even if time[0] is not a multiple of interval", () => {
    const timeData = [5, 35, 65]; // none are multiples of 30
    const indices = computeSampleIndices(timeData, 3, 30);
    expect(indices[0]).toBe(0);
  });

  it("handles single-point data", () => {
    const indices = computeSampleIndices([0], 1, 1800);
    expect(indices).toEqual([0]);
  });

  it("does not duplicate index 0 when time[0] is already a multiple", () => {
    const timeData = [0, 10, 20, 30];
    const indices = computeSampleIndices(timeData, 4, 10);
    // All are multiples of 10, so all are sampled. Index 0 should not appear twice.
    expect(indices).toEqual([0, 1, 2, 3]);
    expect(indices.filter(i => i === 0).length).toBe(1);
  });
});
