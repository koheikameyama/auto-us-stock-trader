import { describe, it, expect } from "vitest";
import { evaluateCondor } from "../condor-evaluator";
import type { SimulatedCondor, USIronCondorBacktestConfig } from "../../us/us-iron-condor-types";

const baseConfig: Pick<
  USIronCondorBacktestConfig,
  "spreadWidth" | "profitTarget" | "stopLossMultiplier" | "riskFreeRate" | "ivScaleFactor" | "putSkewSlope" | "callSkewSlope"
> = {
  spreadWidth: 5,
  profitTarget: 0.5,
  stopLossMultiplier: 2.0,
  riskFreeRate: 0.045,
  ivScaleFactor: 1.0,
  putSkewSlope: 6.3,
  callSkewSlope: 4.05,
};

function condor(p: Partial<SimulatedCondor>): SimulatedCondor {
  return {
    underlyingSymbol: "SPY",
    entryDate: "2024-01-01",
    expirationDate: "2024-02-01",
    entrySpotPrice: 470,
    entryIV: 0.15,
    putShortStrike: 450,
    putLongStrike: 445,
    callShortStrike: 490,
    callLongStrike: 495,
    putShortDeltaAtEntry: -0.2,
    callShortDeltaAtEntry: 0.2,
    putCredit: 0.5,
    callCredit: 0.4,
    creditReceived: 0.9,
    contracts: 1,
    state: "OPEN",
    totalCommissions: 2.6,
    ...p,
  };
}

describe("evaluateCondor", () => {
  it("EXPIRE/expired_worthless when spot lands between short strikes at expiry", () => {
    const c = condor({ expirationDate: "2024-02-01" });
    const result = evaluateCondor(c, { today: "2024-02-01", spotSpy: 470, vix: 15, config: baseConfig });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_worthless");
      expect(result.finalValue).toBe(0);
    }
  });

  it("EXPIRE/expired_max_loss when spot far below put long strike (put side maxed)", () => {
    const c = condor({ expirationDate: "2024-02-01" });
    const result = evaluateCondor(c, { today: "2024-02-01", spotSpy: 400, vix: 30, config: baseConfig });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_max_loss");
      expect(result.finalValue).toBe(5);
    }
  });

  it("EXPIRE/expired_max_loss when spot far above call long strike (call side maxed)", () => {
    const c = condor({ expirationDate: "2024-02-01" });
    const result = evaluateCondor(c, { today: "2024-02-01", spotSpy: 520, vix: 30, config: baseConfig });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_max_loss");
      expect(result.finalValue).toBe(5);
    }
  });

  it("EXPIRE/expired_partial when call side finishes partially ITM", () => {
    const c = condor({ expirationDate: "2024-02-01" });
    const result = evaluateCondor(c, { today: "2024-02-01", spotSpy: 493, vix: 20, config: baseConfig });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_partial");
      expect(result.finalValue).toBeCloseTo(3, 1);
    }
  });

  it("CLOSE/profit_target when current condor value is below target price", () => {
    // spot が両ショート strike の中央付近・満期直前 → 残価値がほぼゼロで PT 到達
    const c = condor({ expirationDate: "2024-02-01", creditReceived: 0.9 });
    const result = evaluateCondor(c, { today: "2024-01-30", spotSpy: 470, vix: 12, config: baseConfig });
    expect(result.action).toBe("CLOSE");
    if (result.action === "CLOSE") {
      expect(result.reason).toBe("profit_target");
    }
  });

  it("HOLD when not at expiry and not at PT/SL", () => {
    const c = condor({ expirationDate: "2024-02-01", creditReceived: 0.9 });
    const result = evaluateCondor(c, { today: "2024-01-05", spotSpy: 470, vix: 18, config: baseConfig });
    expect(result.action).toBe("HOLD");
  });
});
