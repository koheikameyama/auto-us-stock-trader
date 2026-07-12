import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * Iron Condor (SPY) 用 tail-test 閾値。
 *
 * credit-spread と同じく Volatility Risk Premium を取りにいくため win rate / profit factor /
 * tail 指標は同水準の厳しさを維持する。ただし CAGR のみ 0.065 に設定する:
 *   IC は無レバレッジ defined-risk クレジットで、片側 collateral × 2倍プレミアムの構造上
 *   リターン上限が put-only より低い。0.10 は leverage 前提の値。本番構成（較正 slope
 *   put6.30/call4.05 = spike の put5.5 より保守的）の tail-test 実測 CAGR は 6.85% で、これが
 *   無レバ実装のリターン floor。それを反映して 0.065 とする（他6指標のゴールポストは動かさない）。
 *   Portfolio Margin / Box Spread Loan でのレバレッジは将来課題（KOH-544）。
 */
export const IRON_CONDOR_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.70,
  profitFactorMin: 1.30,
  cagrMin: 0.065,
  maxDrawdownMax: 0.25,
  cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.30,
  worstWindowPnlPctMin: -0.50,
};
