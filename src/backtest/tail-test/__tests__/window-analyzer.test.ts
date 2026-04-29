import { describe, it, expect } from "vitest";
import { analyzeWindow, tagDDsWithEvents } from "../window-analyzer";
import type { DailyEquity } from "../../types";
import type { SimulatedSpread } from "../../us/us-credit-spread-types";
import type { DDPeriod, StressWindow } from "../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: totalEquity, positionsValue: 0, totalEquity, openPositionCount: 0 };
}

describe("analyzeWindow", () => {
  const curve: DailyEquity[] = [
    eq("2020-01-31", 100),
    eq("2020-02-28", 90),
    eq("2020-03-23", 70),
    eq("2020-04-30", 95),
  ];
  const window: StressWindow = { name: "COVID-19", start: "2020-02-15", end: "2020-04-30" };

  it("calculates pnl, ddPct, etc. for given window", () => {
    const spreads: SimulatedSpread[] = [];
    const r = analyzeWindow(window, curve, spreads);
    expect(r.dataAvailable).toBe(true);
    expect(r.startEquity).toBe(90); // 2020-02-28 (first day in window)
    expect(r.endEquity).toBe(95);
    expect(r.pnl).toBe(5);
    expect(r.ddPct).toBeCloseTo((90 - 70) / 90, 3); // 22.2%
  });

  it("returns dataAvailable=false when window outside curve range", () => {
    const r = analyzeWindow(
      { name: "Old", start: "2007-01-01", end: "2007-12-31" },
      curve,
      [],
    );
    expect(r.dataAvailable).toBe(false);
  });
});

describe("tagDDsWithEvents", () => {
  it("tags a DD period if peak or trough overlaps a stress window", () => {
    const dds: DDPeriod[] = [{
      peakDate: "2020-02-19",
      troughDate: "2020-03-23",
      recoveryDate: "2020-06-08",
      peakEquity: 100, troughEquity: 70, ddPct: 0.3, ddDollar: 30, durationDays: 33,
      matchedEvent: null, tradesInPeriod: [],
    }];
    const tagged = tagDDsWithEvents(dds, [
      { name: "COVID-19", start: "2020-02-15", end: "2020-04-30" },
    ]);
    expect(tagged[0].matchedEvent).toBe("COVID-19");
  });

  it("returns null matchedEvent when no overlap", () => {
    const dds: DDPeriod[] = [{
      peakDate: "2024-01-01", troughDate: "2024-01-15", recoveryDate: "2024-02-01",
      peakEquity: 100, troughEquity: 90, ddPct: 0.1, ddDollar: 10, durationDays: 14,
      matchedEvent: null, tradesInPeriod: [],
    }];
    const tagged = tagDDsWithEvents(dds, [{ name: "X", start: "2020-01-01", end: "2020-12-31" }]);
    expect(tagged[0].matchedEvent).toBeNull();
  });
});
