/**
 * Wheel戦略バックテスト型定義
 *
 * USBacktestConfigBase は拡張しない（Wheelにはストップロス/トレーリングストップの概念がない）。
 * オプション売りによるシータ収益のサイクル型戦略。
 */

import type { DailyEquity, PerformanceMetrics } from "../types";

// ──────────────────────────────────────────
// 設定
// ──────────────────────────────────────────

export interface USWheelBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number; // USD

  // オプションパラメータ
  /** CSP目標デルタ（絶対値、例: 0.20 → -0.20 OTM put） */
  putDelta: number;
  /** CC目標デルタ（例: 0.30） */
  callDelta: number;
  /** 満期日数ターゲット */
  dte: number;
  /** 早期クローズ利益閾値（0.50 = プレミアムの50%利益で決済） */
  profitTarget: number;

  // IV / 価格計算
  /** 無リスク金利（年率） */
  riskFreeRate: number;
  /** VIX→個別株IV調整倍率（デフォルト 1.0） */
  ivScaleFactor: number;

  // ポジション制限
  /** 同時Wheelサイクル上限 */
  maxWheelPositions: number;

  // ユニバースフィルター
  maxPrice: number;
  minPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;

  // オプション手数料
  /** 1契約あたりの手数料（ドル） */
  optionsCommission: number;

  // マーケットフィルター
  indexTrendFilter: boolean;
  indexTrendSmaPeriod: number;
  marketTrendFilter: boolean;
  marketTrendThreshold: number;

  // 株保有フェーズのリスク管理
  /** 株保有中のストップロス（コストベースからの下落率、例: 0.10 = -10%で損切り）。0=無効 */
  stockStopLossPct: number;
  /** 株保有の最大日数（0=無制限） */
  stockMaxHoldingDays: number;

  // 候補ソート
  selectionSort: "premiumYield" | "delta" | "volume";

  verbose: boolean;
}

// ──────────────────────────────────────────
// Wheelステートマシン
// ──────────────────────────────────────────

/** Wheelサイクルの状態 */
export type WheelState = "CSP_OPEN" | "STOCK_HELD" | "CC_OPEN";

/** シミュレートされたオプション契約 */
export interface SimulatedOption {
  ticker: string;
  optionType: "put" | "call";
  strike: number;
  /** 1株あたりのプレミアム */
  premium: number;
  entryDate: string;
  expirationDate: string;
  entrySpotPrice: number;
  entryIV: number;
  entryDelta: number;
  closeDate?: string;
  closePremium?: number;
  closeReason?: "expired_worthless" | "assigned" | "called_away" | "early_close";
}

/** 1つのWheelサイクル（CSP→株保有→CC→完了） */
export interface WheelPosition {
  ticker: string;
  state: WheelState;
  cycleStartDate: string;

  // CSPフェーズ
  csp: SimulatedOption | null;
  /** ストライク×100（CSPの担保ロック額） */
  collateralLocked: number;

  // 株保有フェーズ
  stockCostBasis: number | null;
  stockQuantity: number;
  stockAssignmentDate: string | null;

  // CCフェーズ（現在のCC。1サイクル内で複数回CCを売る場合がある）
  cc: SimulatedOption | null;
  /** このサイクル内で売ったCC一覧（履歴用） */
  ccHistory: SimulatedOption[];

  // 損益追跡
  totalPremiumCollected: number;
  totalCommissions: number;
  cycleEndDate: string | null;
  cyclePnl: number | null;
}

// ──────────────────────────────────────────
// 結果
// ──────────────────────────────────────────

export interface WheelPerformanceMetrics extends PerformanceMetrics {
  /** 全サイクルで得たプレミアム合計 */
  totalPremiumCollected: number;
  /** CSPがアサインされた割合 */
  assignmentRate: number;
  /** CCがコールされた割合 */
  calledAwayRate: number;
  /** 年率プレミアム利回り（加重平均） */
  avgPremiumYieldAnnualized: number;
  /** 完了サイクル数 */
  completedCycles: number;
  /** 平均サイクル日数 */
  avgCycleDays: number;
  /** CSP売り回数 */
  cspCount: number;
  /** CC売り回数 */
  ccCount: number;
  /** 早期クローズ率 */
  earlyCloseRate: number;
}

export interface USWheelBacktestResult {
  config: USWheelBacktestConfig;
  cycles: WheelPosition[];
  equityCurve: DailyEquity[];
  metrics: WheelPerformanceMetrics;
}
