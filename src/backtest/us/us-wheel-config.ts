/**
 * Wheel戦略バックテスト設定
 *
 * デフォルト設定 + Walk-Forward パラメータグリッド
 */

import type { USWheelBacktestConfig } from "./us-wheel-types";

export const US_WHEEL_DEFAULTS: Omit<USWheelBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300,

  // オプションパラメータ
  putDelta: 0.20,
  callDelta: 0.30,
  dte: 30,
  profitTarget: 0.50,

  // IV / 価格計算
  riskFreeRate: 0.045,
  ivScaleFactor: 1.0,

  // ポジション制限（$3,300で$15-16の株2銘柄分）
  maxWheelPositions: 2,

  // ユニバースフィルター（strike×100 <= budget なので maxPrice=$33）
  maxPrice: 33,
  minPrice: 5,
  minAvgVolume25: 100_000,
  minAtrPct: 1.0,
  minTurnover: 500_000,

  // 株保有フェーズのリスク管理
  stockStopLossPct: 0, // 0=無効
  stockMaxHoldingDays: 0, // 0=無制限

  // オプション手数料
  optionsCommission: 0.65,

  // マーケットフィルター
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  marketTrendFilter: true,
  marketTrendThreshold: 0.50,

  selectionSort: "premiumYield",
  verbose: false,
};

/** Walk-Forward パラメータグリッド（27通り） */
export const US_WHEEL_PARAMETER_GRID = {
  putDelta: [0.15, 0.20, 0.30] as const,
  dte: [21, 30, 45] as const,
  profitTarget: [0.50, 0.65, 0.80] as const,
};

export function generateUSWheelParameterCombinations(): Array<Partial<USWheelBacktestConfig>> {
  const combos: Array<Partial<USWheelBacktestConfig>> = [];
  for (const putDelta of US_WHEEL_PARAMETER_GRID.putDelta) {
    for (const dte of US_WHEEL_PARAMETER_GRID.dte) {
      for (const profitTarget of US_WHEEL_PARAMETER_GRID.profitTarget) {
        combos.push({ putDelta, dte, profitTarget });
      }
    }
  }
  return combos;
}
