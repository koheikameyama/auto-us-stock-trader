import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * Credit Spread (SPY/QQQ) 用 tail-test 閾値。
 * Volatility Risk Premium を取りにいく戦略のため win rate / profit factor を厳しめに、
 * またショートプット最大損失に対する CVaR 比率も評価する。
 */
export const CREDIT_SPREAD_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.70,
  profitFactorMin: 1.30,
  cagrMin: 0.10,
  maxDrawdownMax: 0.25,
  cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.30,
  worstWindowPnlPctMin: -0.50,
};
