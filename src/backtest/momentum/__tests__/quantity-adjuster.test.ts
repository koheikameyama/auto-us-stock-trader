import { describe, it, expect } from "vitest";
import { adjustMomentumQuantityForRegime } from "../quantity-adjuster";

describe("adjustMomentumQuantityForRegime", () => {
  it("returns the original quantity in normal regime", () => {
    expect(adjustMomentumQuantityForRegime(10, "normal")).toBe(10);
  });

  it("halves the quantity in elevated regime via floor()", () => {
    expect(adjustMomentumQuantityForRegime(10, "elevated")).toBe(5);
    expect(adjustMomentumQuantityForRegime(7, "elevated")).toBe(3);
  });

  it("returns at least 1 share in elevated regime even when input is 1", () => {
    expect(adjustMomentumQuantityForRegime(1, "elevated")).toBe(1);
  });

  it("returns the original quantity in crisis regime (entry blocked at caller level)", () => {
    expect(adjustMomentumQuantityForRegime(10, "crisis")).toBe(10);
  });

  it("returns 0 unchanged in normal regime", () => {
    expect(adjustMomentumQuantityForRegime(0, "normal")).toBe(0);
  });
});
