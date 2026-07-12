/**
 * SPY Iron Condor バックテスト設定
 */

import type { USIronCondorBacktestConfig } from "./us-iron-condor-types";

export const US_IRON_CONDOR_DEFAULTS: Omit<USIronCondorBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300,
  underlyingSymbol: "SPY",

  // ショート delta 0.20 = OTM、put -0.20 / call +0.20 の対称 condor
  shortDelta: 0.20,
  // SPYで$5幅 = 片側 max loss $500/contract
  spreadWidth: 5,
  dte: 35,
  profitTarget: 0.50,
  // ストップロス: evaluator は buyback ≥ credit×(1+mult) で撤退するため mult=1.0 = **2×credit で stop**。
  // spike（Go 判定の検証構成）と同じ 2×credit stop を再現する。3×credit（mult=2.0）では
  // 損失が2倍走り MaxDD が閾値 25% を大きく超える（実測 ~46%）。
  stopLossMultiplier: 1.0,

  riskFreeRate: 0.045,
  ivScaleFactor: 1.0,

  // 片側 collateral $500 × 2 position = $1,000 ロック（$3,300 予算に対し安全側）
  maxPositions: 2,
  contractsPerCondor: 1,

  optionsCommission: 0.65,

  // インデックストレンドフィルター: SMA50上で売り（credit-spread 踏襲）
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  // VIX 30 以上は不安定相場、新規エントリー停止
  vixCap: 30,

  // DD hard stop（credit-spread 踏襲）
  ddStopEnabled: true,
  ddStopThreshold: 0.15,
  ddStopCooldownDays: 252,

  verbose: false,
};

/**
 * backtest 忠実度パラメータ: 実 fill の skew / slippage を再現する。
 *
 * paper-trading の実 fill と Alpaca 市場クォート（calibrate-skew.ts, 取引帯 0.20δ）で較正した値。
 * put 側 skew は call 側より急（実 equity skew どおり）。**backtest / walk-forward / tail-test の
 * 入口だけ**で spread して使い、live には入れないこと。
 *
 * caveat: call skew は単一スナップショット（低 VIX ~13%）較正のため regime 依存。複数 VIX 環境で
 *   calibrate-skew.ts を回して再測すること（KOH-544）。--put-slope / --call-slope で上書き可能。
 */
export const US_IRON_CONDOR_BACKTEST_FIDELITY = {
  putSkewSlope: 6.30,
  callSkewSlope: 4.05,
  entrySlippage: 0.04,
} as const;

/** Walk-Forward パラメータグリッド（27通り） */
export const US_IRON_CONDOR_PARAMETER_GRID = {
  shortDelta: [0.15, 0.20, 0.30] as const,
  dte: [21, 35, 45] as const,
  profitTarget: [0.50, 0.65, 0.80] as const,
};

export function generateUSIronCondorParameterCombinations(): Array<Partial<USIronCondorBacktestConfig>> {
  const combos: Array<Partial<USIronCondorBacktestConfig>> = [];
  for (const shortDelta of US_IRON_CONDOR_PARAMETER_GRID.shortDelta) {
    for (const dte of US_IRON_CONDOR_PARAMETER_GRID.dte) {
      for (const profitTarget of US_IRON_CONDOR_PARAMETER_GRID.profitTarget) {
        combos.push({ shortDelta, dte, profitTarget });
      }
    }
  }
  return combos;
}
