import { describe, it, expect } from "vitest";
import { calculateMomentumStopLoss } from "../stop-loss-calculator";

describe("calculateMomentumStopLoss", () => {
  it("returns ATR-based stop when ATR-stop is tighter than max-loss cap", () => {
    // entry=100, atr=2, atrMultiplier=1.5 -> rawSL=97
    // maxLossPct=0.08 -> maxSL=92
    // tighter (closer to entry) is 97
    const sl = calculateMomentumStopLoss({
      entryPrice: 100,
      atr14: 2,
      atrMultiplier: 1.5,
      maxLossPct: 0.08,
    });
    expect(sl).toBe(97);
  });

  it("returns max-loss cap when ATR-stop is deeper than the cap", () => {
    // entry=100, atr=10, atrMultiplier=1.5 -> rawSL=85
    // maxLossPct=0.08 -> maxSL=92
    // tighter is 92
    const sl = calculateMomentumStopLoss({
      entryPrice: 100,
      atr14: 10,
      atrMultiplier: 1.5,
      maxLossPct: 0.08,
    });
    expect(sl).toBe(92);
  });

  it("returns null when SL would be at or above entry (degenerate input)", () => {
    // atrMultiplier=0 + maxLossPct=0 -> SL=entry
    const sl = calculateMomentumStopLoss({
      entryPrice: 100,
      atr14: 2,
      atrMultiplier: 0,
      maxLossPct: 0,
    });
    expect(sl).toBeNull();
  });

  it("handles small ATR + tight maxLossPct", () => {
    // entry=50, atr=0.5, atrMultiplier=1 -> rawSL=49.5
    // maxLossPct=0.02 -> maxSL=49
    // tighter is 49.5
    const sl = calculateMomentumStopLoss({
      entryPrice: 50,
      atr14: 0.5,
      atrMultiplier: 1,
      maxLossPct: 0.02,
    });
    expect(sl).toBeCloseTo(49.5, 5);
  });

  it("respects maxLossPct as the floor when ATR is very large", () => {
    // entry=100, atr=200 -> rawSL=-200, maxSL=92
    const sl = calculateMomentumStopLoss({
      entryPrice: 100,
      atr14: 200,
      atrMultiplier: 1.5,
      maxLossPct: 0.08,
    });
    expect(sl).toBe(92);
  });
});
