import { describe, it, expect } from "vitest";
import { evaluateThresholds, DEFAULT_THRESHOLDS } from "../pass-fail";

describe("evaluateThresholds", () => {
  it("PASS when all metrics meet thresholds", () => {
    const verdict = evaluateThresholds({
      winRate: 0.75,
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: 0.25,
      worstWindowPnlPct: -0.30,
      maxLossDollar: 500,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(verdict.overallPass).toBe(true);
    expect(verdict.checks.every((c) => c.pass !== false)).toBe(true);
  });

  it("FAIL when winRate < 70%", () => {
    const verdict = evaluateThresholds({
      winRate: 0.65,
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: 0.25,
      worstWindowPnlPct: -0.30,
      maxLossDollar: 500,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(verdict.overallPass).toBe(false);
    const winRateCheck = verdict.checks.find((c) => c.name === "Win Rate");
    expect(winRateCheck?.pass).toBe(false);
  });

  it("skips check when actual is null (data unavailable)", () => {
    const verdict = evaluateThresholds({
      winRate: 0.75,
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: null,
      worstWindowPnlPct: null,
      maxLossDollar: 500,
      thresholds: DEFAULT_THRESHOLDS,
    });
    const tailDDCheck = verdict.checks.find((c) => c.name.includes("テール期間 DD"));
    expect(tailDDCheck?.pass).toBeNull();
    expect(verdict.overallPass).toBe(true);
  });

  it("skips check when threshold is null (strategy not applicable)", () => {
    const verdict = evaluateThresholds({
      winRate: 0.5,        // would FAIL with default 0.7
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: 0.25,
      worstWindowPnlPct: -0.30,
      maxLossDollar: 500,
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        winRateMin: null,    // skipped
        cvar5MinRatio: null, // skipped
      },
    });
    const winRateCheck = verdict.checks.find((c) => c.name === "Win Rate");
    expect(winRateCheck?.pass).toBeNull();
    const cvarCheck = verdict.checks.find((c) => c.name.includes("CVaR"));
    expect(cvarCheck?.pass).toBeNull();
    expect(verdict.overallPass).toBe(true);  // skipped checks don't fail
  });
});
