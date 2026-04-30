import type { ThresholdCheck, PassFailVerdict } from "./types";

export interface DefaultThresholds {
  winRateMin: number | null;
  profitFactorMin: number | null;
  cagrMin: number | null;
  maxDrawdownMax: number | null;
  cvar5MinRatio: number | null;        // -(maxLoss * cvar5MinRatio)
  worstWindowDDMax: number | null;
  worstWindowPnlPctMin: number | null;
}

export interface ThresholdInputs {
  winRate: number;
  profitFactor: number;
  cagr: number;
  maxDrawdown: number;
  cvar5: number | null;
  worstWindowDD: number | null;       // 全 window 中の最大 DD
  worstWindowPnlPct: number | null;   // 全 window 中の最悪 PnL%
  maxLossDollar: number;              // 1 trade の最大損失（戦略により定義: credit-spread は spreadWidth×100×contracts、dual-momentum は initialBudget 等）
  thresholds: DefaultThresholds;
}

export function evaluateThresholds(inputs: ThresholdInputs): PassFailVerdict {
  const t = inputs.thresholds;
  const cvar5Threshold =
    t.cvar5MinRatio == null ? null : -(inputs.maxLossDollar * t.cvar5MinRatio);
  const checks: ThresholdCheck[] = [
    check(
      "Win Rate",
      "平時",
      inputs.winRate,
      t.winRateMin,
      "≥",
      t.winRateMin == null ? null : inputs.winRate >= t.winRateMin,
    ),
    check(
      "Profit Factor",
      "平時",
      inputs.profitFactor,
      t.profitFactorMin,
      "≥",
      t.profitFactorMin == null ? null : inputs.profitFactor >= t.profitFactorMin,
    ),
    check(
      "CAGR",
      "平時",
      inputs.cagr,
      t.cagrMin,
      "≥",
      t.cagrMin == null ? null : inputs.cagr >= t.cagrMin,
    ),
    check(
      "Max DD",
      "平時",
      inputs.maxDrawdown,
      t.maxDrawdownMax,
      "≤",
      t.maxDrawdownMax == null ? null : inputs.maxDrawdown <= t.maxDrawdownMax,
    ),
    check(
      "CVaR 5%",
      "テール",
      inputs.cvar5,
      cvar5Threshold,
      "≥",
      inputs.cvar5 == null || cvar5Threshold == null
        ? null
        : inputs.cvar5 >= cvar5Threshold,
    ),
    check(
      "テール期間 DD（最悪）",
      "テール",
      inputs.worstWindowDD,
      t.worstWindowDDMax,
      "≤",
      inputs.worstWindowDD == null || t.worstWindowDDMax == null
        ? null
        : inputs.worstWindowDD <= t.worstWindowDDMax,
    ),
    check(
      "テール期間 PnL%（最悪）",
      "テール",
      inputs.worstWindowPnlPct,
      t.worstWindowPnlPctMin,
      "≥",
      inputs.worstWindowPnlPct == null || t.worstWindowPnlPctMin == null
        ? null
        : inputs.worstWindowPnlPct >= t.worstWindowPnlPctMin,
    ),
  ];

  const evaluated = checks.filter((c) => c.pass !== null);
  const passed = evaluated.filter((c) => c.pass).length;
  const failed = evaluated.filter((c) => !c.pass).length;
  const overallPass = failed === 0;

  return {
    overallPass,
    checks,
    summary: overallPass
      ? `PASS: ${passed}/${evaluated.length} checks (skipped ${checks.length - evaluated.length})`
      : `FAIL: ${passed}/${evaluated.length} checks (skipped ${checks.length - evaluated.length})`,
  };
}

function check(
  name: string,
  category: "平時" | "テール",
  actual: number | null,
  threshold: number | null,
  _op: "≥" | "≤",
  pass: boolean | null,
): ThresholdCheck {
  return { name, category, actual, threshold, pass };
}
