import { describe, it, expect } from "vitest";
import { pctReturn } from "../momentum-calculator";

describe("pctReturn", () => {
  it("returns positive percentage when current price is higher than lookback", () => {
    const prices = [100, 101, 102, 103, 110]; // lookback=4: (110-100)/100 * 100 = 10%
    expect(pctReturn(prices, 4)).toBeCloseTo(10, 5);
  });

  it("returns negative percentage when current price is lower than lookback", () => {
    const prices = [100, 99, 95, 92, 90]; // lookback=4: (90-100)/100 * 100 = -10%
    expect(pctReturn(prices, 4)).toBeCloseTo(-10, 5);
  });

  it("returns null when prices array is shorter than lookback+1", () => {
    expect(pctReturn([100, 101, 102], 4)).toBeNull();
  });

  it("returns null when past price is zero or negative", () => {
    expect(pctReturn([0, 100, 110], 2)).toBeNull();
    expect(pctReturn([-1, 100, 110], 2)).toBeNull();
  });

  it("uses the most recent price as numerator", () => {
    const prices = [50, 60, 70, 80, 100, 120];
    // lookback=5: (120-50)/50 * 100 = 140
    expect(pctReturn(prices, 5)).toBeCloseTo(140, 5);
  });
});
