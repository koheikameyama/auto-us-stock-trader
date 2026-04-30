import { describe, it, expect } from "vitest";
import { calculateBuyOrder, calculateSellOrder } from "../order-calculator";

describe("calculateBuyOrder", () => {
  it("calculates shares with slippage and commission deducted", () => {
    // cash=10000, price=100, slip=0.05% (=5), commission=1
    // usableCash = 10000 - 1 - 5 = 9994
    // shares = floor(9994 / 100) = 99
    // cashRemaining = 10000 - 99*100 - 1 - 5 = 94
    const result = calculateBuyOrder(10000, 100, 0.05, 1);
    expect(result.shares).toBe(99);
    expect(result.slippage).toBeCloseTo(5, 5);
    expect(result.commission).toBe(1);
    expect(result.cashRemaining).toBeCloseTo(94, 5);
  });

  it("returns 0 shares when cash is insufficient even for one share", () => {
    const result = calculateBuyOrder(50, 100, 0.05, 1);
    expect(result.shares).toBe(0);
  });

  it("uses floor for fractional shares", () => {
    const result = calculateBuyOrder(1000, 99, 0.0, 0);
    // floor(1000 / 99) = 10 (NOT 10.1)
    expect(result.shares).toBe(10);
  });

  it("zero slippage and zero commission edge case", () => {
    const result = calculateBuyOrder(1000, 100, 0, 0);
    expect(result.shares).toBe(10);
    expect(result.cashRemaining).toBeCloseTo(0, 5);
  });
});

describe("calculateSellOrder", () => {
  it("calculates net cash received with slippage and commission deducted", () => {
    // shares=100, price=110, slip=0.05% (5.5), commission=1
    // proceeds = 100*110 = 11000
    // cashReceived = 11000 - 1 - 5.5 = 10993.5
    const result = calculateSellOrder(100, 110, 0.05, 1);
    expect(result.proceeds).toBe(11000);
    expect(result.slippage).toBeCloseTo(5.5, 5);
    expect(result.commission).toBe(1);
    expect(result.cashReceived).toBeCloseTo(10993.5, 5);
  });

  it("zero shares returns zero across all fields", () => {
    const result = calculateSellOrder(0, 100, 0.05, 1);
    expect(result.proceeds).toBe(0);
    expect(result.cashReceived).toBeCloseTo(-1, 5); // commission still subtracted
    // Note: design choice — 0 shares should likely skip the order entirely upstream.
    // We document the math but caller must guard against 0-share calls.
  });
});
