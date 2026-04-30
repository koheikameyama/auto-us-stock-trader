import { describe, it, expect } from "vitest";
import { rankSignalsByReturn } from "../signal-ranker";
import type { PrecomputedMomentumSignal } from "../../us/us-momentum-simulation";

const sig = (
  ticker: string,
  returnPct: number,
): PrecomputedMomentumSignal => ({
  ticker,
  entryPrice: 100,
  returnPct,
  atr14: 2,
  avgVolume25: 1_000_000,
});

describe("rankSignalsByReturn", () => {
  it("sorts signals by returnPct descending and slices to topN", () => {
    const out = rankSignalsByReturn(
      [sig("AAA", 5), sig("BBB", 20), sig("CCC", -3), sig("DDD", 12)],
      2,
    );
    expect(out.map((s) => s.ticker)).toEqual(["BBB", "DDD"]);
  });

  it("returns all signals when topN exceeds list length", () => {
    const out = rankSignalsByReturn(
      [sig("AAA", 5), sig("BBB", 20)],
      10,
    );
    expect(out.map((s) => s.ticker)).toEqual(["BBB", "AAA"]);
  });

  it("returns an empty array when input is empty", () => {
    expect(rankSignalsByReturn([], 5)).toEqual([]);
  });

  it("returns an empty array when topN is 0", () => {
    expect(rankSignalsByReturn([sig("AAA", 5), sig("BBB", 20)], 0)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const input = [sig("AAA", 5), sig("BBB", 20), sig("CCC", -3)];
    const snapshot = input.map((s) => s.ticker);
    rankSignalsByReturn(input, 2);
    expect(input.map((s) => s.ticker)).toEqual(snapshot);
  });

  it("keeps stable order for equal returns (no spec, but test for determinism via slice)", () => {
    const out = rankSignalsByReturn(
      [sig("AAA", 10), sig("BBB", 10), sig("CCC", 5)],
      2,
    );
    // Both AAA and BBB have return 10; either is fine for top-2 inclusion,
    // but CCC must be excluded.
    expect(out.map((s) => s.ticker).sort()).toEqual(["AAA", "BBB"]);
  });
});
