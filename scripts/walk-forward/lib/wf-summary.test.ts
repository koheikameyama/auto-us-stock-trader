import { describe, it, expect } from "vitest";
import {
  judge,
  summarizeWFResults,
  type WFWindow,
} from "./wf-summary";
import type { PerformanceMetrics } from "../../../src/backtest/types";

function makeMetrics(over: Partial<PerformanceMetrics>): PerformanceMetrics {
  return {
    totalTrades: 10,
    wins: 6,
    losses: 4,
    stillOpen: 0,
    winRate: 60,
    avgWinPct: 2,
    avgLossPct: -1,
    profitFactor: 3,
    maxDrawdown: 5,
    maxDrawdownPeriod: null,
    sharpeRatio: 1,
    avgHoldingDays: 5,
    totalPnl: 100,
    totalReturnPct: 10,
    byRegime: {},
    totalCommission: 0,
    totalTax: 0,
    totalGrossPnl: 100,
    totalNetPnl: 100,
    netReturnPct: 10,
    costImpactPct: 0,
    expectancy: 1,
    riskRewardRatio: 2,
    ...over,
  };
}

function makeWindow(over: Partial<WFWindow> = {}): WFWindow {
  return {
    windowIdx: 0,
    isStart: "2026-01-01",
    isEnd: "2026-06-30",
    oosStart: "2026-07-01",
    oosEnd: "2026-09-30",
    bestIsParams: { foo: 1 },
    isMetrics: makeMetrics({ profitFactor: 2 }),
    oosMetrics: makeMetrics({ profitFactor: 1.5, sharpeRatio: 0.8 }),
    ...over,
  };
}

describe("judge", () => {
  it("returns robust when oosPF >= 1.3 and isOosRatio <= 2.0", () => {
    expect(judge(1.5, 1.5)).toBe("robust");
  });
  it("returns watch when oosPF >= 1.0 and isOosRatio <= 3.0", () => {
    expect(judge(1.1, 2.5)).toBe("watch");
  });
  it("returns overfit otherwise", () => {
    expect(judge(0.8, 1.5)).toBe("overfit");
    expect(judge(1.5, 4.0)).toBe("overfit");
  });
});

describe("summarizeWFResults", () => {
  const config = { isMonths: 6, oosMonths: 3, slideMonths: 3, numWindows: 2 };

  it("aggregates active and skipped windows", () => {
    const windows: WFWindow[] = [
      makeWindow({ windowIdx: 0 }),
      makeWindow({ windowIdx: 1, oosMetrics: null }),
    ];
    const s = summarizeWFResults("test", windows, config);
    expect(s.aggregate.activeWindows).toBe(1);
    expect(s.aggregate.skippedWindows).toBe(1);
  });

  it("computes oosWinRate from active windows", () => {
    const windows = [
      makeWindow({
        oosMetrics: makeMetrics({ totalTrades: 10, wins: 7, losses: 3 }),
      }),
    ];
    const s = summarizeWFResults("test", windows, config);
    expect(s.aggregate.oosTotalTrades).toBe(10);
    expect(s.aggregate.oosWinRate).toBe(70);
  });

  it("computes Sharpe / Calmar from active windows only", () => {
    const windows = [
      makeWindow({
        oosMetrics: makeMetrics({
          sharpeRatio: 1.0,
          maxDrawdown: 10,
          totalReturnPct: 20,
        }),
      }),
      makeWindow({
        windowIdx: 1,
        oosMetrics: makeMetrics({
          sharpeRatio: 2.0,
          maxDrawdown: 5,
          totalReturnPct: 10,
        }),
      }),
      makeWindow({ windowIdx: 2, oosMetrics: null }),
    ];
    const s = summarizeWFResults("test", windows, config);
    expect(s.aggregate.oosAvgSharpe).toBeCloseTo(1.5, 5);
    expect(s.aggregate.oosAvgMaxDD).toBeCloseTo(7.5, 5);
    expect(s.aggregate.oosAvgReturnPct).toBeCloseTo(15, 5);
    expect(s.aggregate.oosCalmar).toBeCloseTo(15 / 7.5, 5);
  });

  it("treats null sharpeRatio as missing", () => {
    const windows = [
      makeWindow({ oosMetrics: makeMetrics({ sharpeRatio: null }) }),
    ];
    const s = summarizeWFResults("test", windows, config);
    expect(s.aggregate.oosAvgSharpe).toBeNull();
  });

  it("returns 0 PF when no losses and no wins", () => {
    const windows = [
      makeWindow({
        oosMetrics: makeMetrics({
          wins: 0,
          losses: 0,
          totalTrades: 0,
          avgWinPct: 0,
          avgLossPct: 0,
        }),
      }),
    ];
    const s = summarizeWFResults("test", windows, config);
    expect(s.aggregate.oosAggregatePF).toBe(0);
  });
});
