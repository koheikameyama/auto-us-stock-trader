import { describe, it, expect } from "vitest";
import {
  calculateSharpeRatio,
  calculateAnnualizedReturn,
} from "../portfolio-metrics";
import type { DailyEquity } from "../../types";

function eq(d: string, v: number): DailyEquity {
  return { date: d, cash: 0, positionsValue: v, totalEquity: v, openPositionCount: 0 };
}

describe("calculateAnnualizedReturn (CAGR)", () => {
  it("returns 0 for unchanged equity", () => {
    const curve = [eq("2024-01-01", 100), eq("2024-12-31", 100)];
    // 252 trading days ~= 1 year, equity unchanged
    expect(calculateAnnualizedReturn(curve, 100)).toBeCloseTo(0, 4);
  });

  it("returns ~10% for 10% return over 1 year", () => {
    const curve: DailyEquity[] = [];
    for (let i = 0; i < 252; i++) {
      curve.push(eq(`2024-D${i}`, 100 + (i * 10) / 252));
    }
    expect(calculateAnnualizedReturn(curve, 100)).toBeCloseTo(0.1, 2);
  });

  it("returns 0 when curve has < 2 points", () => {
    expect(calculateAnnualizedReturn([], 100)).toBe(0);
  });
});

describe("calculateSharpeRatio", () => {
  it("returns positive value for positive trending curve", () => {
    const curve: DailyEquity[] = [];
    for (let i = 0; i < 252; i++) curve.push(eq(`D${i}`, 100 * (1 + 0.0004 * i)));
    const s = calculateSharpeRatio(curve);
    expect(s).toBeGreaterThan(0);
  });

  it("returns 0 for constant equity (zero variance)", () => {
    const curve = Array.from({ length: 100 }, (_, i) => eq(`D${i}`, 100));
    expect(calculateSharpeRatio(curve)).toBe(0);
  });
});
