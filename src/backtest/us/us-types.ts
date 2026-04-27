/**
 * 米国株バックテスト型定義
 */

import type { SimulatedPosition, DailyEquity, PerformanceMetrics } from "../types";

// ──────────────────────────────────────────
// 共通ベース設定
// ──────────────────────────────────────────

export interface USBacktestConfigBase {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  initialBudget: number; // USD

  maxPositions: number;

  // ストップロス
  /** SL = entry - ATR × this */
  atrMultiplier: number;
  /** SLハードキャップ（%）— 0.05 = 5% */
  maxLossPct: number;

  // トレーリングストップ
  beActivationMultiplier: number;
  trailMultiplier: number;

  // タイムストップ
  maxHoldingDays: number;
  maxExtendedHoldingDays: number;

  // ユニバースフィルター（USD）
  maxPrice: number;
  minPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  /** 最低売買代金（USD）。price × avgVolume25 >= this */
  minTurnover: number;

  // コスト
  costModelEnabled: boolean;

  // クールダウン
  cooldownDays: number;

  // マーケットフィルター
  /** S&P 500 SMA フィルター */
  indexTrendFilter?: boolean;
  indexTrendSmaPeriod?: number;
  /** ブレッドスフィルター（ユニバース内のSMA25上%） */
  marketTrendFilter?: boolean;
  marketTrendThreshold?: number;

  verbose: boolean;
  positionCapEnabled?: boolean;
  maxDailyEntries?: number;
}

// ──────────────────────────────────────────
// PEAD（決算後ドリフト）
// ──────────────────────────────────────────

export interface USPeadBacktestConfig extends USBacktestConfigBase {
  /** 決算翌日のギャップ閾値 */
  gapMinPct: number;
  /** 出来高サージ倍率 */
  volSurgeRatio: number;
}

export interface USPeadBacktestResult {
  config: USPeadBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// GapUp US
// ──────────────────────────────────────────

export interface USGapUpBacktestConfig extends USBacktestConfigBase {
  gapMinPct: number;
  volSurgeRatio: number;
  signalSortMethod?: "gapvol" | "rr" | "volume";
  /** vol >= この倍率のとき gap 条件を gapMinPctRelaxed に緩和。省略時=無効 */
  gapRelaxVolThreshold?: number;
  /** gapRelaxVolThreshold 超時の緩和 gap 閾値。省略時=gapMinPct と同値 */
  gapMinPctRelaxed?: number;
}

export interface USGapUpBacktestResult {
  config: USGapUpBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// Momentum（クロスセクショナル）
// ──────────────────────────────────────────

export interface USMomentumBacktestConfig extends USBacktestConfigBase {
  /** リターン計測ルックバック（営業日） */
  lookbackDays: number;
  /** 保有する上位銘柄数 */
  topN: number;
  /** リバランス頻度（営業日） */
  rebalanceDays: number;
  /** 最低リターン閾値（%） */
  minReturnPct: number;
}

export interface USMomentumBacktestResult {
  config: USMomentumBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}

// ──────────────────────────────────────────
// Mean Reversion（平均回帰）
// ──────────────────────────────────────────

export interface USMeanReversionBacktestConfig extends USBacktestConfigBase {
  /** エントリーRSI閾値 */
  rsiOversold: number;
  /** ボリンジャーバンド期間 */
  bbLookback: number;
  /** BB標準偏差倍率 */
  bbStdDev: number;
  /** 出来高サージ倍率 */
  volSurgeRatio: number;
  /** エグジットRSI閾値 */
  exitRsi: number;
  /** エグジットSMA期間 */
  exitSmaPeriod: number;
}

export interface USMeanReversionBacktestResult {
  config: USMeanReversionBacktestConfig;
  trades: SimulatedPosition[];
  equityCurve: DailyEquity[];
  metrics: PerformanceMetrics;
}
