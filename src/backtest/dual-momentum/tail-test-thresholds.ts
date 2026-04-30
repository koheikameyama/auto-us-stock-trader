import type { DefaultThresholds } from "../tail-test/pass-fail";

/**
 * Dual Momentum 用 tail-test 閾値（暫定値）。
 * - winRate / cvar5MinRatio は月次 rotation 戦略では概念が薄いため null（スキップ）
 * - drawdown は credit-spread より緩めに設定（rotation 性質上 GFC 等で大きな DD を許容）
 */
export const DUAL_MOMENTUM_THRESHOLDS: DefaultThresholds = {
  winRateMin: null,           // 月次 rotation で win rate 概念が薄い → スキップ
  profitFactorMin: 1.0,
  cagrMin: 0.07,
  maxDrawdownMax: 0.30,
  cvar5MinRatio: null,
  worstWindowDDMax: 0.35,
  worstWindowPnlPctMin: -0.40,
};
