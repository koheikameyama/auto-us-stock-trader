import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * Cross-Sectional Momentum 用 tail-test 閾値（Tier 1）。
 * 上下両トレンドで稼げる戦略想定だが、急変局面では losing streak が長引く可能性あり。
 * credit-spread と異なり個別株 universe で vol exposure が低いため低相関期待。
 */
export const MOMENTUM_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.50,
  profitFactorMin: 1.3,
  cagrMin: 0.08,
  maxDrawdownMax: 0.30,
  cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.35,
  worstWindowPnlPctMin: -0.45,
};
