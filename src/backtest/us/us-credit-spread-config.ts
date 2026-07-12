/**
 * SPY Credit Spread バックテスト設定
 */

import type { USCreditSpreadBacktestConfig } from "./us-credit-spread-types";

export const US_CREDIT_SPREAD_DEFAULTS: Omit<USCreditSpreadBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300,
  underlyingSymbol: "SPY",

  // ショート delta 0.20 = OTM、概ね ~80% 勝率帯
  shortPutDelta: 0.20,
  // SPYで$5幅 = max loss $500/contract
  spreadWidth: 5,
  dte: 35,
  profitTarget: 0.50,
  // ストップロス無効（spread の max loss が定義済みなので不要派が多い）
  stopLossMultiplier: 2.0,

  riskFreeRate: 0.045,
  ivScaleFactor: 1.0,

  // $3,300 / max loss $500 = 6 spread 可能だが安全側で 2 (1,000ロック)
  maxPositions: 2,
  contractsPerSpread: 1,

  optionsCommission: 0.65,

  // インデックストレンドフィルター: SMA50上で売り（ベア相場を回避）
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  // VIX 30 以上は不安定相場、新規エントリー停止
  vixCap: 30,

  // DD hard stop（Step #1）
  ddStopEnabled: true,
  ddStopThreshold: 0.15,
  ddStopCooldownDays: 252,

  verbose: false,
};

/**
 * backtest 忠実度パラメータ: 実 fill の skew / slippage を再現する。
 *
 * paper-trading の実 fill credit を diff-report で較正した値（skewSlope≈5.5,
 * slippage≈$0.04 で平均乖離 ≈0%）。**backtest / walk-forward / tail-test の入口だけ**で
 * spread して使い、live（US_CREDIT_SPREAD_DEFAULTS 直使い）には入れないこと。
 */
export const US_CREDIT_SPREAD_BACKTEST_FIDELITY = {
  ivSkewSlope: 5.5,
  entrySlippage: 0.04,
} as const;

/** Walk-Forward パラメータグリッド（27通り） */
export const US_CREDIT_SPREAD_PARAMETER_GRID = {
  shortPutDelta: [0.15, 0.20, 0.30] as const,
  dte: [21, 35, 45] as const,
  profitTarget: [0.50, 0.65, 0.80] as const,
};

export function generateUSCreditSpreadParameterCombinations(): Array<Partial<USCreditSpreadBacktestConfig>> {
  const combos: Array<Partial<USCreditSpreadBacktestConfig>> = [];
  for (const shortPutDelta of US_CREDIT_SPREAD_PARAMETER_GRID.shortPutDelta) {
    for (const dte of US_CREDIT_SPREAD_PARAMETER_GRID.dte) {
      for (const profitTarget of US_CREDIT_SPREAD_PARAMETER_GRID.profitTarget) {
        combos.push({ shortPutDelta, dte, profitTarget });
      }
    }
  }
  return combos;
}
