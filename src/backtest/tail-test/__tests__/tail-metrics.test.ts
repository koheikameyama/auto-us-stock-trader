import { describe, it, expect } from "vitest";
import { calculateTailMetrics, calculateVixBuckets } from "../tail-metrics";
import type { SimulatedSpread } from "../../us/us-credit-spread-types";
import type { DailyEquity } from "../../types";

function spread(p: Partial<SimulatedSpread> & { netPnl: number }): SimulatedSpread {
  return {
    underlyingSymbol: "SPY",
    entryDate: "2024-01-01",
    expirationDate: "2024-02-01",
    entrySpotPrice: 470,
    entryIV: 0.15,
    shortStrike: 450,
    longStrike: 445,
    shortDeltaAtEntry: -0.2,
    creditReceived: 0.85,
    contracts: 1,
    state: "CLOSED",
    closeDate: "2024-01-20",
    closeReason: "profit_target",
    closeSpreadPrice: 0.4,
    totalCommissions: 2.6,
    ...p,
  } as SimulatedSpread;
}

describe("calculateTailMetrics", () => {
  it("computes cvar5 as average of worst 5% trades", () => {
    const spreads: SimulatedSpread[] = [
      spread({ netPnl: -500 }),
      spread({ netPnl: -400 }),
      ...Array.from({ length: 18 }, (_, i) => spread({ netPnl: 50 + i })),
    ];
    // 20 trades, worst 5% = 1 trade => cvar5 = -500
    const m = calculateTailMetrics(spreads, []);
    expect(m.cvar5).toBe(-500);
    expect(m.worstSpread?.netPnl).toBe(-500);
  });

  it("computes consecutiveLossCount", () => {
    const spreads: SimulatedSpread[] = [
      spread({ netPnl: 50, closeDate: "2024-01-10" }),
      spread({ netPnl: -30, closeDate: "2024-01-15" }),
      spread({ netPnl: -40, closeDate: "2024-01-20" }),
      spread({ netPnl: -20, closeDate: "2024-01-25" }), // 連敗ピーク 3
      spread({ netPnl: 100, closeDate: "2024-02-01" }),
      spread({ netPnl: -10, closeDate: "2024-02-05" }),
    ];
    const m = calculateTailMetrics(spreads, []);
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
