import { describe, it, expect } from "vitest";
import { calculatePeadStopLoss } from "../stop-loss-calculator";

describe("calculatePeadStopLoss", () => {
  it("returns ATR-based stop when ATR stop is tighter than max-loss cap", () => {
    // entry=100, ATR=2, atrMult=1 -> rawSL=98
    // maxLossPct=0.05 -> maxSL=95
    // max(98, 95) = 98 (ATR is tighter)
    const sl = calculatePeadStopLoss({
      entryPrice: 100,
      atr14: 2,
      atrMultiplier: 1,
      maxLossPct: 0.05,
    });
    expect(sl).toBe(98);
  });

  it("returns max-loss cap when ATR stop would be deeper than cap", () => {
    // entry=100, ATR=10, atrMult=1 -> rawSL=90
    // maxLossPct=0.05 -> maxSL=95
    // max(90, 95) = 95 (cap is tighter)
    const sl = calculatePeadStopLoss({
      entryPrice: 100,
      atr14: 10,
      atrMultiplier: 1,
      maxLossPct: 0.05,
    });
    expect(sl).toBe(95);
  });

  it("respects atrMultiplier scaling", () => {
    // entry=100, ATR=2, atrMult=1.5 -> rawSL=97
    // maxLossPct=0.05 -> maxSL=95
    // max(97, 95) = 97
    const sl = calculatePeadStopLoss({
      entryPrice: 100,
      atr14: 2,
      atrMultiplier: 1.5,
      maxLossPct: 0.05,
    });
    expect(sl).toBe(97);
  });

  it("returns null when computed SL is at or above entry (degenerate)", () => {
    // ATR=0 -> rawSL=100, max with maxSL=95 -> 100, not below entry
    expect(
      calculatePeadStopLoss({
        entryPrice: 100,
        atr14: 0,
        atrMultiplier: 1,
        maxLossPct: 0.05,
      }),
    ).toBeNull();
  });

  it("respects maxLossPct=0 edge case (cap = entry, returns null)", () => {
    // maxLossPct=0 -> maxSL=100=entry; ATR cap could be tighter
    // With atrMult=1, atr=2 -> rawSL=98, max(98, 100) = 100 (>= entry) -> null
    expect(
      calculatePeadStopLoss({
        entryPrice: 100,
        atr14: 2,
        atrMultiplier: 1,
        maxLossPct: 0,
      }),
    ).toBeNull();
  });

  it("handles small entryPrice with large ATR (cap dominates)", () => {
    // entry=10, ATR=5, atrMult=1 -> rawSL=5
    // maxLossPct=0.1 -> maxSL=9
    // max(5, 9) = 9
    const sl = calculatePeadStopLoss({
      entryPrice: 10,
      atr14: 5,
      atrMultiplier: 1,
      maxLossPct: 0.1,
    });
    expect(sl).toBe(9);
  });
});
