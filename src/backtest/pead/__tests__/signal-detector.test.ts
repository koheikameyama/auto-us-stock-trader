import { describe, it, expect } from "vitest";
import { detectPeadGapSignal } from "../signal-detector";

describe("detectPeadGapSignal", () => {
  it("returns signal when gap and volume both meet thresholds and bar is bullish", () => {
    const sig = detectPeadGapSignal({
      prevClose: 100,
      todayOpen: 104,
      todayClose: 105,
      todayVolume: 200_000,
      avgVolume25: 100_000,
      gapMinPct: 0.03,
      volSurgeRatio: 1.5,
    });
    expect(sig).not.toBeNull();
    expect(sig!.gapPct).toBeCloseTo(0.04, 5);
    expect(sig!.volumeSurgeRatio).toBeCloseTo(2.0, 5);
  });

  it("returns null when gap below threshold", () => {
    const sig = detectPeadGapSignal({
      prevClose: 100,
      todayOpen: 102,
      todayClose: 103,
      todayVolume: 200_000,
      avgVolume25: 100_000,
      gapMinPct: 0.03,
      volSurgeRatio: 1.5,
    });
    expect(sig).toBeNull();
  });

  it("returns null when volume surge below threshold", () => {
    const sig = detectPeadGapSignal({
      prevClose: 100,
      todayOpen: 105,
      todayClose: 106,
      todayVolume: 100_000,
      avgVolume25: 100_000,
      gapMinPct: 0.03,
      volSurgeRatio: 1.5,
    });
    expect(sig).toBeNull();
  });

  it("returns null when bar is bearish (close < open) — likely bad earnings reaction", () => {
    const sig = detectPeadGapSignal({
      prevClose: 100,
      todayOpen: 105,
      todayClose: 104,
      todayVolume: 200_000,
      avgVolume25: 100_000,
      gapMinPct: 0.03,
      volSurgeRatio: 1.5,
    });
    expect(sig).toBeNull();
  });

  it("rounds gapPct to 4 decimals and volumeSurgeRatio to 2 decimals", () => {
    const sig = detectPeadGapSignal({
      prevClose: 100,
      todayOpen: 103.456789,
      todayClose: 105,
      todayVolume: 187_654,
      avgVolume25: 100_000,
      gapMinPct: 0.03,
      volSurgeRatio: 1.5,
    });
    expect(sig).not.toBeNull();
    // (103.456789 - 100) / 100 = 0.03456789 -> 0.0346 (4 decimals)
    expect(sig!.gapPct).toBe(0.0346);
    // 187654 / 100000 = 1.87654 -> 1.88 (2 decimals)
    expect(sig!.volumeSurgeRatio).toBe(1.88);
  });

  it("accepts boundary case where gap equals threshold exactly", () => {
    const sig = detectPeadGapSignal({
      prevClose: 100,
      todayOpen: 103,
      todayClose: 104,
      todayVolume: 150_000,
      avgVolume25: 100_000,
      gapMinPct: 0.03,
      volSurgeRatio: 1.5,
    });
    expect(sig).not.toBeNull();
  });
});
