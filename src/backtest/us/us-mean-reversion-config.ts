/**
 * Mean Reversion (平均回帰) バックテスト設定
 *
 * RSI(14) 売られすぎ + ボリンジャーバンド下限割れ + 出来高サージで
 * 反発を狙い、RSI回復 or SMA回帰で利確する短期平均回帰戦略。
 */

import type { USMeanReversionBacktestConfig } from "./us-types";

/** デフォルト設定 */
export const US_MEAN_REVERSION_DEFAULTS: Omit<USMeanReversionBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300, // $3,300 (~50万円)
  maxPositions: 3,

  // エントリー（大型株でもシグナルが出る程度に緩和）
  rsiOversold: 40,
  bbLookback: 20,
  bbStdDev: 1.5,
  volSurgeRatio: 1.0,

  // エグジット（平均回帰ターゲット）
  exitRsi: 50,
  exitSmaPeriod: 20,

  // ストップロス
  atrMultiplier: 1.0,
  maxLossPct: 0.04, // 4%

  // トレーリングストップ
  beActivationMultiplier: 0.3,
  trailMultiplier: 0.5,

  // タイムストップ
  maxHoldingDays: 5,
  maxExtendedHoldingDays: 7,

  // ユニバースフィルター
  maxPrice: 500,
  minPrice: 5,
  minAvgVolume25: 100_000,
  minAtrPct: 1.0,
  minTurnover: 1_000_000, // $1M

  // コスト
  costModelEnabled: true,

  // クールダウン
  cooldownDays: 5,

  // マーケットフィルター（平均回帰は下落トレンドでも機能するため無効）
  indexTrendFilter: false,
  marketTrendFilter: false,

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const US_MEAN_REVERSION_RISK_PER_TRADE_PCT = 2;

/** WFパラメータグリッド（27通り） */
export const US_MEAN_REVERSION_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.5],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateUSMeanReversionParameterCombinations(): Array<Partial<USMeanReversionBacktestConfig>> {
  const combos: Array<Partial<USMeanReversionBacktestConfig>> = [];

  for (const atrMultiplier of US_MEAN_REVERSION_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of US_MEAN_REVERSION_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of US_MEAN_REVERSION_PARAMETER_GRID.trailMultiplier) {
        combos.push({ atrMultiplier, beActivationMultiplier, trailMultiplier });
      }
    }
  }

  return combos;
}
