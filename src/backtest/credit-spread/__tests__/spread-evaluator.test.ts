import { describe, it, expect } from "vitest";
import { evaluateSpread } from "../spread-evaluator";
import type { SimulatedSpread, USCreditSpreadBacktestConfig } from "../../us/us-credit-spread-types";

const baseConfig: Pick<USCreditSpreadBacktestConfig, "spreadWidth" | "profitTarget" | "stopLossMultiplier" | "riskFreeRate" | "ivScaleFactor"> = {
  spreadWidth: 5,
  profitTarget: 0.5,
  stopLossMultiplier: 2.0,
  riskFreeRate: 0.045,
  ivScaleFactor: 1.0,
};

function spread(p: Partial<SimulatedSpread>): SimulatedSpread {
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
    state: "OPEN",
    totalCommissions: 1.3,
    ...p,
  };
}

describe("evaluateSpread", () => {
  it("returns EXPIRE/expired_worthless when spotSpy is far above shortStrike at expiry", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01" });
    const result = evaluateSpread(sp, {
      today: "2024-02-01",
      spotSpy: 480,
      vix: 15,
      config: baseConfig,
    });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_worthless");
      expect(result.finalValue).toBe(0);
    }
  });

  it("returns EXPIRE/expired_max_loss when spotSpy is far below longStrike at expiry", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01" });
    const result = evaluateSpread(sp, {
      today: "2024-02-01",
      spotSpy: 400,
      vix: 30,
      config: baseConfig,
    });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_max_loss");
      expect(result.finalValue).toBe(5);
    }
  });

  it("returns EXPIRE/expired_partial when spotSpy is between strikes at expiry", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01" });
    const result = evaluateSpread(sp, {
      today: "2024-02-01",
      spotSpy: 447,
      vix: 20,
      config: baseConfig,
    });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_partial");
      expect(result.finalValue).toBeCloseTo(3, 1);
    }
  });

  it("returns CLOSE/profit_target when currentValue is below profitTargetPrice", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01", creditReceived: 0.85 });
    const result = evaluateSpread(sp, {
      today: "2024-01-25",
      spotSpy: 470,
      vix: 12,
      config: baseConfig,
    });
    expect(result.action).toBe("CLOSE");
    if (result.action === "CLOSE") {
      expect(result.reason).toBe("profit_target");
    }
  });

  it("returns HOLD when not at expiry and not at PT/SL", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01", creditReceived: 0.85 });
    const result = evaluateSpread(sp, {
      today: "2024-01-15",
      spotSpy: 458,
      vix: 18,
      config: baseConfig,
    });
    expect(result.action).toBe("HOLD");
  });
});
