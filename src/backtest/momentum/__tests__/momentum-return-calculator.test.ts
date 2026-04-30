import { describe, it, expect } from "vitest";
import { calculateMomentumReturn } from "../momentum-return-calculator";

describe("calculateMomentumReturn", () => {
  it("returns positive percentage when today's close is above lookback close", () => {
    const r = calculateMomentumReturn(120, 100);
    expect(r).toBeCloseTo(20, 5);
  });

  it("returns negative percentage when today's close is below lookback close", () => {
    const r = calculateMomentumReturn(90, 100);
    expect(r).toBeCloseTo(-10, 5);
  });

  it("returns 0 when prices are equal", () => {
    const r = calculateMomentumReturn(100, 100);
    expect(r).toBe(0);
  });

  it("returns null when lookback close is 0 (avoids div by zero)", () => {
    expect(calculateMomentumReturn(120, 0)).toBeNull();
  });

  it("returns null when lookback close is negative (data sanity)", () => {
    expect(calculateMomentumReturn(120, -1)).toBeNull();
  });

  it("computes the same result regardless of input scale", () => {
    expect(calculateMomentumReturn(2, 1)).toBeCloseTo(100, 5);
    expect(calculateMomentumReturn(200, 100)).toBeCloseTo(100, 5);
  });
});
