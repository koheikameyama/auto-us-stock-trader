import { describe, it, expect } from "vitest";
import { selectMomentumAsset } from "../asset-selector";

describe("selectMomentumAsset", () => {
  const riskOff = "AGG";

  it("selects highest-momentum equity when above threshold", () => {
    const result = selectMomentumAsset(
      [
        { ticker: "SPY", momentum: 12.0 },
        { ticker: "EFA", momentum: 8.0 },
      ],
      0,
      riskOff
    );
    expect(result.selected).toBe("SPY");
    expect(result.reason).toBe("best_equity");
    expect(result.sortedRankings[0].ticker).toBe("SPY");
  });

  it("selects risk-off when all equities below threshold", () => {
    const result = selectMomentumAsset(
      [
        { ticker: "SPY", momentum: -5.0 },
        { ticker: "EFA", momentum: -3.0 },
      ],
      0,
      riskOff
    );
    expect(result.selected).toBe("AGG");
    expect(result.reason).toBe("risk_off");
  });

  it("selects risk-off when rankings array is empty", () => {
    const result = selectMomentumAsset([], 0, riskOff);
    expect(result.selected).toBe("AGG");
    expect(result.reason).toBe("risk_off");
    expect(result.sortedRankings).toEqual([]);
  });

  it("respects positive threshold (e.g., +5%)", () => {
    const result = selectMomentumAsset(
      [{ ticker: "SPY", momentum: 3.0 }],
      5,
      riskOff
    );
    expect(result.selected).toBe("AGG");
    expect(result.reason).toBe("risk_off");
  });

  it("sorts rankings descending by momentum", () => {
    const result = selectMomentumAsset(
      [
        { ticker: "EFA", momentum: 5.0 },
        { ticker: "SPY", momentum: 12.0 },
        { ticker: "QQQ", momentum: 8.0 },
      ],
      0,
      riskOff
    );
    expect(result.sortedRankings.map((r) => r.ticker)).toEqual(["SPY", "QQQ", "EFA"]);
  });
});
