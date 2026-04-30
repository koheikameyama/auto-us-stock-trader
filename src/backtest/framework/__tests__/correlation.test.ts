import { describe, it, expect } from "vitest";
import {
  calculatePearsonCorrelation,
  alignEquityCurves,
  dailyReturns,
  calculateCorrelationMatrix,
} from "../correlation";
import type { DailyEquity } from "../../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: 0, positionsValue: totalEquity, totalEquity, openPositionCount: 0 };
}

describe("dailyReturns", () => {
  it("returns successive percent changes", () => {
    const curve = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 99)];
    const ret = dailyReturns(curve);
    expect(ret).toHaveLength(2);
    expect(ret[0]).toBeCloseTo(0.1, 5);  // 110/100 - 1
    expect(ret[1]).toBeCloseTo(-0.1, 5); // 99/110 - 1
  });

  it("returns empty array when curve has < 2 points", () => {
    expect(dailyReturns([])).toEqual([]);
    expect(dailyReturns([eq("2024-01-01", 100)])).toEqual([]);
  });

  it("skips entries where prev equity is zero or negative", () => {
    const curve = [eq("2024-01-01", 0), eq("2024-01-02", 100), eq("2024-01-03", 110)];
    const ret = dailyReturns(curve);
    expect(ret).toHaveLength(1);
    expect(ret[0]).toBeCloseTo(0.1, 5);
  });
});

describe("alignEquityCurves", () => {
  it("returns common date range only", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-02", 50), eq("2024-01-03", 60), eq("2024-01-04", 70)];
    const aligned = alignEquityCurves(a, b);
    expect(aligned.dates).toEqual(["2024-01-02", "2024-01-03"]);
    expect(aligned.equityA).toEqual([110, 120]);
    expect(aligned.equityB).toEqual([50, 60]);
  });

  it("returns empty when no overlap", () => {
    const a = [eq("2024-01-01", 100)];
    const b = [eq("2024-02-01", 50)];
    const aligned = alignEquityCurves(a, b);
    expect(aligned.dates).toEqual([]);
    expect(aligned.equityA).toEqual([]);
    expect(aligned.equityB).toEqual([]);
  });

  it("preserves date order ascending", () => {
    const a = [eq("2024-01-03", 120), eq("2024-01-01", 100), eq("2024-01-02", 110)];
    const b = [eq("2024-01-01", 50), eq("2024-01-02", 60), eq("2024-01-03", 70)];
    const aligned = alignEquityCurves(a, b);
    expect(aligned.dates).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(aligned.equityA).toEqual([100, 110, 120]);
    expect(aligned.equityB).toEqual([50, 60, 70]);
  });
});

describe("calculatePearsonCorrelation", () => {
  it("returns 1.0 for identical series", () => {
    expect(calculatePearsonCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeCloseTo(1.0, 5);
  });

  it("returns -1.0 for perfectly inversely correlated series", () => {
    expect(calculatePearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1.0, 5);
  });

  it("returns ~0 for uncorrelated series", () => {
    const r = calculatePearsonCorrelation([1, -1, 1, -1, 1], [1, 1, -1, -1, 1]);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it("throws on length mismatch", () => {
    expect(() => calculatePearsonCorrelation([1, 2, 3], [1, 2])).toThrow();
  });

  it("returns 0 for constant series (zero variance)", () => {
    expect(calculatePearsonCorrelation([5, 5, 5, 5], [1, 2, 3, 4])).toBe(0);
  });

  it("returns 0 for empty arrays", () => {
    expect(calculatePearsonCorrelation([], [])).toBe(0);
  });
});

describe("calculateCorrelationMatrix", () => {
  it("returns symmetric matrix with 1.0 diagonal", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-01", 100), eq("2024-01-02", 105), eq("2024-01-03", 110)];
    const matrix = calculateCorrelationMatrix([
      { name: "A", curve: a },
      { name: "B", curve: b },
    ]);
    expect(matrix.length).toBe(2);
    expect(matrix[0].length).toBe(2);
    expect(matrix[0][0]).toBeCloseTo(1.0, 5); // A vs A
    expect(matrix[1][1]).toBeCloseTo(1.0, 5); // B vs B
    expect(matrix[0][1]).toBeCloseTo(matrix[1][0], 5); // symmetric
  });

  it("identifies perfectly correlated curves", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-01", 50), eq("2024-01-02", 55), eq("2024-01-03", 60)]; // same daily returns
    const matrix = calculateCorrelationMatrix([
      { name: "A", curve: a },
      { name: "B", curve: b },
    ]);
    expect(matrix[0][1]).toBeCloseTo(1.0, 5);
  });
});
