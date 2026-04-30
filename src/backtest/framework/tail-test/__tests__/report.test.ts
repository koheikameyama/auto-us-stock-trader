import { describe, it, expect } from "vitest";
import { generateMarkdownReport } from "../report";

describe("generateMarkdownReport", () => {
  it("includes verdict and key sections", () => {
    const md = generateMarkdownReport({
      configSummary: { underlyingSymbol: "SPY", shortPutDelta: 0.20 },
      startDate: "2007-01-03",
      endDate: "2026-04-28",
      totalTrades: 412,
      baseMetrics: {
        winRate: 0.75,
        profitFactor: 1.42,
        cagr: 0.112,
        maxDrawdown: 0.221,
        netReturnPct: 0.96,
      },
      ddRanking: [],
      stressWindows: [],
      tailMetrics: {
        cvar5: -240,
        cvar1: -480,
        worstTrade: null,
        worstDay: null,
        consecutiveLossCount: 4,
      },
      vixBuckets: [],
      verdict: {
        overallPass: true,
        summary: "PASS: 7/7 checks",
        checks: [
          {
            name: "Win Rate",
            category: "平時",
            actual: 0.75,
            threshold: 0.70,
            pass: true,
          },
        ],
      },
      equityCurve: [],
      trades: [],
    });
    expect(md).toContain("# SPY Credit Spread");
    expect(md).toContain("PASS");
    expect(md).toContain("Win Rate");
  });
});
