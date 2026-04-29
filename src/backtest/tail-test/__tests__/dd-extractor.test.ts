import { describe, it, expect } from "vitest";
import { extractDDPeriods } from "../dd-extractor";
import type { DailyEquity } from "../../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: totalEquity, positionsValue: 0, totalEquity, openPositionCount: 0 };
}

describe("extractDDPeriods", () => {
  it("returns empty array for monotonically increasing equity", () => {
    const curve = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    expect(extractDDPeriods(curve, 5)).toEqual([]);
  });

  it("identifies a single DD period: peak -> trough -> recovery", () => {
    const curve = [
      eq("2024-01-01", 100),
      eq("2024-01-02", 120), // peak
      eq("2024-01-03", 110),
      eq("2024-01-04", 90),  // trough
      eq("2024-01-05", 100),
      eq("2024-01-06", 120), // recovery (back to peak)
    ];
    const result = extractDDPeriods(curve, 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      peakDate: "2024-01-02",
      troughDate: "2024-01-04",
      recoveryDate: "2024-01-06",
      ddPct: 0.25,           // (120-90)/120
      ddDollar: 30,
    });
  });

  it("returns null recoveryDate if not recovered by end", () => {
    const curve = [
      eq("2024-01-01", 100),
      eq("2024-01-02", 120), // peak
      eq("2024-01-03", 80),  // trough
      eq("2024-01-04", 90),  // not recovered
    ];
    const result = extractDDPeriods(curve, 5);
    expect(result).toHaveLength(1);
    expect(result[0].recoveryDate).toBeNull();
  });

  it("ranks multiple DDs by ddPct descending and limits to topN", () => {
    const curve = [
      eq("2024-01-01", 100),
      eq("2024-01-02", 90),  // small dd 10%
      eq("2024-01-03", 100), // recover
      eq("2024-01-04", 110), // peak
      eq("2024-01-05", 80),  // big dd ~27%
      eq("2024-01-06", 110), // recover
      eq("2024-01-07", 120), // peak
      eq("2024-01-08", 100), // medium dd ~17%
      eq("2024-01-09", 120), // recover
    ];
    const top2 = extractDDPeriods(curve, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0].ddPct).toBeGreaterThan(top2[1].ddPct); // sorted desc
    expect(top2[0].ddPct).toBeCloseTo(0.2727, 3);
  });
});
