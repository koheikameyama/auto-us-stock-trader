/**
 * US GapUp バックテスト設定
 *
 * 日本版 gapup 戦略の米国市場向けアダプテーション。
 * ギャップアップ + 出来高サージ + 陽線 → 終値エントリー。
 */

import type { USGapUpBacktestConfig } from "./us-types";

/** デフォルト設定 */
export const US_GAPUP_DEFAULTS: Omit<USGapUpBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300, // $3,300 (~50万円)
  maxPositions: 3,

  // エントリー
  gapMinPct: 0.03,       // 3% gap
  volSurgeRatio: 1.5,    // 出来高1.5倍

  // ストップロス
  atrMultiplier: 0.8,
  maxLossPct: 0.05,      // 5%（米国はボラ大きめ）

  // トレーリングストップ
  beActivationMultiplier: 0.3,
  trailMultiplier: 0.3,

  // タイムストップ（短期決戦）
  maxHoldingDays: 3,
  maxExtendedHoldingDays: 5,

  // ユニバースフィルター
  maxPrice: 500,         // $500
  minPrice: 5,           // $5（ペニー株除外）
  minAvgVolume25: 100_000,
  minAtrPct: 1.0,
  minTurnover: 500_000,  // $500K

  // コスト
  costModelEnabled: true,

  // クールダウン
  cooldownDays: 5,

  // マーケットフィルター
  indexTrendFilter: true,
  indexTrendSmaPeriod: 50,
  marketTrendFilter: true,
  marketTrendThreshold: 0.5,

  // ソート
  signalSortMethod: "gapvol",

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const US_GAPUP_RISK_PER_TRADE_PCT = 2;

/** 緩和時の gap 下限 */
export const US_GAPUP_RELAXED_GAP_MIN_PCT = 0.01;

/**
 * walk-forward パラメータグリッド（81通り）
 *
 * gapMinPct=3% 固定。vol が gapRelaxVolThreshold 以上のとき gapMinPctRelaxed=1% に緩和。
 * gapRelaxVolThreshold=undefined は緩和無効（従来の gap=3% 単純フィルター）。
 */
export const US_GAPUP_PARAMETER_GRID = {
  /** undefined = 緩和無効 */
  gapRelaxVolThreshold: [undefined, 3.0, 4.0] as (number | undefined)[],
  atrMultiplier: [0.8, 1.0, 1.2],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.3, 0.5, 0.8],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateUSGapUpParameterCombinations(): Array<Partial<USGapUpBacktestConfig>> {
  const combos: Array<Partial<USGapUpBacktestConfig>> = [];

  for (const gapRelaxVolThreshold of US_GAPUP_PARAMETER_GRID.gapRelaxVolThreshold) {
    for (const atrMultiplier of US_GAPUP_PARAMETER_GRID.atrMultiplier) {
      for (const beActivationMultiplier of US_GAPUP_PARAMETER_GRID.beActivationMultiplier) {
        for (const trailMultiplier of US_GAPUP_PARAMETER_GRID.trailMultiplier) {
          combos.push({
            gapRelaxVolThreshold,
            gapMinPctRelaxed: gapRelaxVolThreshold != null ? US_GAPUP_RELAXED_GAP_MIN_PCT : undefined,
            atrMultiplier,
            beActivationMultiplier,
            trailMultiplier,
          });
        }
      }
    }
  }

  return combos;
}
