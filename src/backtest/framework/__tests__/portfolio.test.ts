import { describe, it, expect } from "vitest";
import { combineEquityCurves } from "../portfolio";
import type { DailyEquity } from "../../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return {
    date,
    cash: 0,
    positionsValue: totalEquity,
    totalEquity,
    openPositionCount: 0,
  };
}

describe("combineEquityCurves", () => {
  it("combines two curves with 50/50 weight (equal start)", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-01", 100), eq("2024-01-02", 90), eq("2024-01-03", 100)];
    // 50/50 portfolio: each has $50 initial.
    // Day 1: 50, 50 → 100
    // Day 2: 55 (110%), 45 (90%) → 100
    // Day 3: 60 (120%), 50 (100%) → 110
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 100 },
      { curve: b, weight: 0.5, initialBudget: 100 },
    ]);
    expect(portfolio.map((p) => p.totalEquity)).toEqual([100, 100, 110]);
  });

  it("normalizes by individual initialBudget then applies weight", () => {
    const a = [eq("2024-01-01", 1000), eq("2024-01-02", 1100)]; // 10% return
    const b = [eq("2024-01-01", 500), eq("2024-01-02", 525)]; //  5% return
    // Combined initialBudget = a.initial * w_a + b.initial * w_b
    // For 50/50, total = 1000 * 0.5 + 500 * 0.5 = 750
    // Day 0: 750 (start)
    // Day 1: a returns 10% (10% * 0.5 = 5%), b returns 5% (5% * 0.5 = 2.5%) → 7.5% portfolio return
    //   = 750 * 1.075 = 806.25
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 1000 },
      { curve: b, weight: 0.5, initialBudget: 500 },
    ]);
    expect(portfolio[0].totalEquity).toBeCloseTo(750, 2);
    expect(portfolio[1].totalEquity).toBeCloseTo(806.25, 2);
  });

  it("aligns dates and skips non-overlap", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-02", 100), eq("2024-01-03", 105), eq("2024-01-04", 110)];
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 100 },
      { curve: b, weight: 0.5, initialBudget: 100 },
    ]);
    expect(portfolio.map((p) => p.date)).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it("throws when weights don't sum to 1.0 (within tolerance)", () => {
    const a = [eq("2024-01-01", 100)];
    expect(() =>
      combineEquityCurves([
        { curve: a, weight: 0.4, initialBudget: 100 },
        { curve: a, weight: 0.4, initialBudget: 100 },
      ]),
    ).toThrow(/weight/i);
  });

  it("returns empty when no overlap", () => {
    const a = [eq("2024-01-01", 100)];
    const b = [eq("2024-02-01", 100)];
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 100 },
      { curve: b, weight: 0.5, initialBudget: 100 },
    ]);
    expect(portfolio).toEqual([]);
  });
});
