import { describe, it, expect } from "vitest";
import { generateEntrySignal } from "../signal-generator";
import { US_CREDIT_SPREAD_DEFAULTS } from "../../us/us-credit-spread-config";
import type { USCreditSpreadBacktestConfig } from "../../us/us-credit-spread-types";

const fullConfig: USCreditSpreadBacktestConfig = {
  ...US_CREDIT_SPREAD_DEFAULTS,
  startDate: "2024-01-01",
  endDate: "2024-12-31",
};

const baseTradingDays = ["2024-01-15", "2024-01-22", "2024-01-29", "2024-02-05", "2024-02-12", "2024-02-19", "2024-02-26"];

describe("generateEntrySignal", () => {
  it("returns SKIP_MAX_POSITIONS when at max", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 2,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_MAX_POSITIONS");
  });

  it("returns SKIP_DD_STOP when ddStopActive=true", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: true,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_DD_STOP");
  });

  it("returns SKIP_VIX_CAP when vix > vixCap", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 35,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_VIX_CAP");
  });

  it("returns SKIP_TREND_FILTER when gspc < smaGspc", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4400,
      spotSpy: 440,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_TREND_FILTER");
  });

  it("returns SKIP_INSUFFICIENT_CASH when cash is too low", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 100,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_INSUFFICIENT_CASH");
  });

  it("returns ENTERED with strikes when conditions are met", () => {
    const tradingDays: string[] = [];
    for (let i = 0; i < 100; i++) {
      const d = new Date("2024-01-15");
      d.setDate(d.getDate() + i);
      tradingDays.push(d.toISOString().slice(0, 10));
    }

    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("ENTERED");
    if (result.reason === "ENTERED") {
      expect(result.shortStrike).toBeGreaterThan(440);
      expect(result.shortStrike).toBeLessThan(470);
      expect(result.longStrike).toBe(result.shortStrike - 5);
      expect(result.estimatedCredit).toBeGreaterThan(0.05);
    }
  });

  it("respects indexTrendFilter=false (no SMA check)", () => {
    const tradingDays: string[] = [];
    for (let i = 0; i < 100; i++) {
      const d = new Date("2024-01-15");
      d.setDate(d.getDate() + i);
      tradingDays.push(d.toISOString().slice(0, 10));
    }

    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4400,
      spotSpy: 440,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays,
      config: { ...fullConfig, indexTrendFilter: false },
    });
    expect(result.reason).toBe("ENTERED");
  });
});
