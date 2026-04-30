import { describe, it, expect } from "vitest";
import { calculateTailMetrics, calculateVixBuckets } from "../tail-metrics";
import type { Trade } from "../../strategy-result";

function trade(p: Partial<Trade> & { netPnl: number }): Trade {
  return {
    symbol: "SPY",
    entryDate: "2024-01-01",
    closeDate: "2024-01-20",
    pnlPct: null,
    holdingDays: null,
    ...p,
  };
}

describe("calculateTailMetrics", () => {
  it("computes cvar5 as average of worst 5% trades", () => {
    const trades: Trade[] = [
      trade({ netPnl: -500 }),
      trade({ netPnl: -400 }),
      ...Array.from({ length: 18 }, (_, i) => trade({ netPnl: 50 + i })),
    ];
    // 20 trades, worst 5% = 1 trade => cvar5 = -500
    const m = calculateTailMetrics(trades, []);
    expect(m.cvar5).toBe(-500);
    expect(m.worstTrade?.netPnl).toBe(-500);
  });

  it("computes consecutiveLossCount", () => {
    const trades: Trade[] = [
      trade({ netPnl: 50, closeDate: "2024-01-10" }),
      trade({ netPnl: -30, closeDate: "2024-01-15" }),
      trade({ netPnl: -40, closeDate: "2024-01-20" }),
      trade({ netPnl: -20, closeDate: "2024-01-25" }), // 連敗ピーク 3
      trade({ netPnl: 100, closeDate: "2024-02-01" }),
      trade({ netPnl: -10, closeDate: "2024-02-05" }),
    ];
    const m = calculateTailMetrics(trades, []);
    expect(m.consecutiveLossCount).toBe(3);
  });
});

describe("calculateVixBuckets", () => {
  it("buckets trading days by VIX level", () => {
    const tradingDays = ["2024-01-01", "2024-01-02", "2024-01-03"];
    const vix = new Map([
      ["2024-01-01", 12],   // ≤20
      ["2024-01-02", 25],   // 20-30
      ["2024-01-03", 35],   // >30
    ]);
    const result = calculateVixBuckets(tradingDays, vix, []);
    expect(result.find((b) => b.label === "≤20")?.tradingDays).toBe(1);
    expect(result.find((b) => b.label === "20-30")?.tradingDays).toBe(1);
    expect(result.find((b) => b.label === ">30")?.tradingDays).toBe(1);
  });
});
