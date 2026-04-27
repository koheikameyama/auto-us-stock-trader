/**
 * PEAD（Post-Earnings Announcement Drift）バックテスト設定
 *
 * 決算翌日にgap + 出来高サージで好決算を確認 → 終値エントリー。
 * 好決算後のドリフト（5-20日）をトレーリングストップで捕捉。
 */

import type { USPeadBacktestConfig } from "./us-types";

/** デフォルト設定 */
export const US_PEAD_DEFAULTS: Omit<USPeadBacktestConfig, "startDate" | "endDate"> = {
  initialBudget: 3300, // $3,300 (≈50万円)
  maxPositions: 3,

  // エントリー
  gapMinPct: 0.03,       // 3% gap
  volSurgeRatio: 1.5,    // 出来高1.5倍

  // ストップロス
  atrMultiplier: 1.0,
  maxLossPct: 0.05,      // 5%（米国はボラ大きめ）

  // トレーリングストップ
  beActivationMultiplier: 0.5,
  trailMultiplier: 0.5,

  // タイムストップ（ドリフトは数日〜数週間）
  maxHoldingDays: 10,
  maxExtendedHoldingDays: 20,

  // ユニバースフィルター
  maxPrice: 500,         // $500（S&P 500の多くをカバー）
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

  verbose: false,
  positionCapEnabled: true,
};

/** 1トレードあたりリスク（%） */
export const US_PEAD_RISK_PER_TRADE_PCT = 2;

/** WFパラメータグリッド（27通り） */
export const US_PEAD_PARAMETER_GRID = {
  atrMultiplier: [0.8, 1.0, 1.5],
  beActivationMultiplier: [0.3, 0.5, 0.8],
  trailMultiplier: [0.5, 0.8, 1.0],
} as const;

/** パラメータグリッドの全組み合わせを生成 */
export function generateUSPeadParameterCombinations(): Array<Partial<USPeadBacktestConfig>> {
  const combos: Array<Partial<USPeadBacktestConfig>> = [];

  for (const atrMultiplier of US_PEAD_PARAMETER_GRID.atrMultiplier) {
    for (const beActivationMultiplier of US_PEAD_PARAMETER_GRID.beActivationMultiplier) {
      for (const trailMultiplier of US_PEAD_PARAMETER_GRID.trailMultiplier) {
        combos.push({ atrMultiplier, beActivationMultiplier, trailMultiplier });
      }
    }
  }

  return combos;
}
