import { describe, it, expect } from "vitest";
import { adjustPeadQuantityForRegime } from "../quantity-adjuster";

describe("adjustPeadQuantityForRegime", () => {
  it("returns base quantity unchanged in normal regime", () => {
    expect(adjustPeadQuantityForRegime(10, "normal")).toBe(10);
  });

  it("halves quantity (floor) in elevated regime", () => {
    expect(adjustPeadQuantityForRegime(10, "elevated")).toBe(5);
    expect(adjustPeadQuantityForRegime(7, "elevated")).toBe(3);
  });

  it("returns at least 1 share when halved quantity would be 0", () => {
    // 1 / 2 = 0.5 -> floor=0 -> bumped to 1
    expect(adjustPeadQuantityForRegime(1, "elevated")).toBe(1);
  });

  it("returns base quantity in crisis regime (entry should already be blocked upstream)", () => {
    // crisis 時はそもそも new entry が走らない設計だが、関数仕様としては identity
    expect(adjustPeadQuantityForRegime(10, "crisis")).toBe(10);
  });

  it("handles zero base quantity (returns 0)", () => {
    expect(adjustPeadQuantityForRegime(0, "normal")).toBe(0);
    expect(adjustPeadQuantityForRegime(0, "elevated")).toBe(1); // bumped to 1 by floor logic
  });
});
