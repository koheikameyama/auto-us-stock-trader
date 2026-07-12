import { describe, it, expect } from "vitest";
import { generateCondorEntrySignal } from "../condor-signal-generator";
import { US_IRON_CONDOR_DEFAULTS } from "../../us/us-iron-condor-config";
import type { USIronCondorBacktestConfig } from "../../us/us-iron-condor-types";

const fullConfig: USIronCondorBacktestConfig = {
  ...US_IRON_CONDOR_DEFAULTS,
  startDate: "2024-01-01",
  endDate: "2024-12-31",
};

const baseTradingDays = ["2024-01-15", "2024-01-22", "2024-01-29", "2024-02-05", "2024-02-12", "2024-02-19", "2024-02-26"];

function longTradingDays(): string[] {
  const days: string[] = [];
  for (let i = 0; i < 100; i++) {
    const d = new Date("2024-01-15");
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

describe("generateCondorEntrySignal", () => {
  it("returns SKIP_MAX_POSITIONS when at max", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4700, spotSpy: 470, vix: 15, smaGspc: 4500,
      cash: 10000, openPositionCount: 2, ddStopActive: false,
      tradingDays: baseTradingDays, config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_MAX_POSITIONS");
  });

  it("returns SKIP_DD_STOP when ddStopActive=true", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4700, spotSpy: 470, vix: 15, smaGspc: 4500,
      cash: 10000, openPositionCount: 0, ddStopActive: true,
      tradingDays: baseTradingDays, config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_DD_STOP");
  });

  it("returns SKIP_VIX_CAP when vix > vixCap", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4700, spotSpy: 470, vix: 35, smaGspc: 4500,
      cash: 10000, openPositionCount: 0, ddStopActive: false,
      tradingDays: baseTradingDays, config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_VIX_CAP");
  });

  it("returns SKIP_TREND_FILTER when gspc < smaGspc", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4400, spotSpy: 440, vix: 15, smaGspc: 4500,
      cash: 10000, openPositionCount: 0, ddStopActive: false,
      tradingDays: baseTradingDays, config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_TREND_FILTER");
  });

  it("returns SKIP_INSUFFICIENT_CASH when cash is too low", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4700, spotSpy: 470, vix: 15, smaGspc: 4500,
      cash: 100, openPositionCount: 0, ddStopActive: false,
      tradingDays: longTradingDays(), config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_INSUFFICIENT_CASH");
  });

  it("returns ENTERED with 4 legs bracketing spot when conditions are met", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4700, spotSpy: 470, vix: 15, smaGspc: 4500,
      cash: 10000, openPositionCount: 0, ddStopActive: false,
      tradingDays: longTradingDays(), config: fullConfig,
    });
    expect(result.reason).toBe("ENTERED");
    if (result.reason === "ENTERED") {
      // put 側は spot 未満、call 側は spot 超（condor が spot を挟む）
      expect(result.putShortStrike).toBeLessThan(470);
      expect(result.callShortStrike).toBeGreaterThan(470);
      expect(result.putLongStrike).toBe(result.putShortStrike - 5);
      expect(result.callLongStrike).toBe(result.callShortStrike + 5);
      // put/call 双方からクレジットを受領（IC の 2倍プレミアム構造）
      expect(result.putCredit).toBeGreaterThan(0);
      expect(result.callCredit).toBeGreaterThan(0);
      expect(result.estimatedCredit).toBeCloseTo(result.putCredit + result.callCredit, 6);
    }
  });

  it("put skew slope が急なほど put credit が薄くなる", () => {
    const ctx = {
      today: "2024-01-15", gspc: 4700, spotSpy: 470, vix: 20, smaGspc: 4500,
      cash: 10000, openPositionCount: 0, ddStopActive: false,
      tradingDays: longTradingDays(),
    };
    const flat = generateCondorEntrySignal({ ...ctx, config: { ...fullConfig, putSkewSlope: 0, callSkewSlope: 0, entrySlippage: 0 } });
    const skewed = generateCondorEntrySignal({ ...ctx, config: { ...fullConfig, putSkewSlope: 6.3, callSkewSlope: 0, entrySlippage: 0 } });
    expect(flat.reason).toBe("ENTERED");
    expect(skewed.reason).toBe("ENTERED");
    if (flat.reason === "ENTERED" && skewed.reason === "ENTERED") {
      // skew を入れると short(高 IV) と long の差が縮み put credit が薄くなる
      expect(skewed.putCredit).toBeLessThan(flat.putCredit);
      // call 側 slope は 0 のままなので不変
      expect(skewed.callCredit).toBeCloseTo(flat.callCredit, 6);
    }
  });

  it("respects indexTrendFilter=false (no SMA check)", () => {
    const result = generateCondorEntrySignal({
      today: "2024-01-15", gspc: 4400, spotSpy: 440, vix: 15, smaGspc: 4500,
      cash: 10000, openPositionCount: 0, ddStopActive: false,
      tradingDays: longTradingDays(), config: { ...fullConfig, indexTrendFilter: false },
    });
    expect(result.reason).toBe("ENTERED");
  });
});
