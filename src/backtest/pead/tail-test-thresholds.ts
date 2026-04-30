import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * PEAD 用 tail-test 閾値（Tier 1）。
 * 個別株 idiosyncratic で vol regime 非依存、credit-spread と低相関期待。
 * 平均勝率は moderate, profit factor で稼ぐタイプの戦略想定。
 */
export const PEAD_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.55,        // 個別株 momentum で過半勝つ程度を期待
  profitFactorMin: 1.5,    // win/loss が偏るため PF で目標
  cagrMin: 0.08,           // 8% / 年（credit-spread より低めで OK）
  maxDrawdownMax: 0.35,    // 個別株 universe で 35% は許容
  cvar5MinRatio: 0.5,      // credit-spread と同じ尺度
  worstWindowDDMax: 0.40,
  worstWindowPnlPctMin: -0.45,
};
