/**
 * Cross-Sectional Momentum バックテスト設定
 *
 * lookbackDays のリターンで全銘柄をランキングし、
 * 上位 topN 銘柄を rebalanceDays ごとにリバランス。
 * トレーリングストップ + タイムストップで出口管理。
 */

import type { USMomentumBacktestConfig } from "./us-types";

/** デフォルト設定 */
export const US_MOMENTUM_DEFAULTS: Omit<USMomentumBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300, // $3,300 (approx 50万円)
  maxPositions: 5,

  // モメンタム（チューニング済み）
  lookbackDays: 42,    // 2ヶ月（より短いモメンタム窓）
  topN: 10,            // 上位10銘柄
  rebalanceDays: 15,   // 隔週リバランス
  minReturnPct: 0,     // リターン下限なし（ランキング上位ならOK）

  // ストップロス
  atrMultiplier: 1.5,
  maxLossPct: 0.08,    // 8%

  // トレーリングストップ
  beActivationMultiplier: 0.8,
  trailMultiplier: 1.0,

  // タイムストップ
  maxHoldingDays: 25,
  maxExtendedHoldingDays: 30,

  // ユニバースフィルター
  maxPrice: 500,
  minPrice: 5,
  minAvgVolume25: 100_000,
  minAtrPct: 0.5,
  minTurnover: 1_000_000,

  // コスト
  costModelEnabled: true,

  // クールダウン
  cooldownDays: 5,

  // マーケットフィルター（モメンタムは全相場で機能する前提で無効化）
  indexTrendFilter: false,
  indexTrendSmaPeriod: 50,
  marketTrendFilter: false,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const US_MOMENTUM_RISK_PER_TRADE_PCT = 1.5;

/** WFパラメータグリッド（27通り） */
export const US_MOMENTUM_PARAMETER_GRID = {
  atrMultiplier: [1.0, 1.5, 2.0],
  beActivationMultiplier: [0.5, 0.8, 1.2],
  trailMultiplier: [0.8, 1.0, 1.5],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateUSMomentumParameterCombinations(): Array<Partial<USMomentumBacktestConfig>> {
  const combos: Array<Partial<USMomentumBacktestConfig>> = [];

  for (const atrMultiplier of US_MOMENTUM_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of US_MOMENTUM_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of US_MOMENTUM_PARAMETER_GRID.trailMultiplier) {
        combos.push({ atrMultiplier, beActivationMultiplier, trailMultiplier });
      }
    }
  }

  return combos;
}
