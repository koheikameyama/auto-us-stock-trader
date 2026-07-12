/**
 * SPY/QQQ Iron Condor バックテスト型定義
 *
 * Iron Condor = Bull Put Credit Spread + Bear Call Credit Spread（同一満期）:
 *   put 側: sell short put (OTM, |delta| ~0.20) / buy long put (further OTM)
 *   call 側: sell short call (OTM, delta ~0.20) / buy long call (further OTM)
 *   max loss = spread width - total credit（**片側のみ**が最大損失になり得るため collateral は片側分）
 *
 * put-only credit spread は skew を実 fill どおり織り込むと edge が消滅した（KOH-544）。
 * IC は同じ collateral で put+call の 2 側からプレミアムを取れるため、無レバレッジ defined-risk
 * クレジットとして edge が残る。edge の源泉は「call 側単体の収益」ではなく 2倍プレミアムの構造。
 */

import type { DailyEquity, PerformanceMetrics } from "../types";

export interface USIronCondorBacktestConfig {
  startDate: string;
  endDate: string;
  initialBudget: number;

  /** 原資産シンボル（"SPY" 推奨。^GSPCを÷10で SPY 換算して使用） */
  underlyingSymbol: "SPY" | "QQQ" | "IWM";

  /** ショート側 delta（絶対値、例 0.20）。put は -δ、call は +δ の対称で strike を選ぶ */
  shortDelta: number;
  /** スプレッド幅（ドル、SPYスケール。例: 5 = $5幅、put/call 共通） */
  spreadWidth: number;
  /** 満期日数 */
  dte: number;
  /** 早期クローズ利益目標（totalCredit の%、例 0.50 = 50% 取れたら condor 全体を決済） */
  profitTarget: number;
  /** ストップロス（totalCredit の倍率、例 2.0 = クレジットの2倍損失で撤退。0=無効） */
  stopLossMultiplier: number;

  /** 無リスク金利（年率） */
  riskFreeRate: number;
  /** VIX→IV調整倍率 */
  ivScaleFactor: number;
  /** 受領クレジット倍率（実 fill が BS 理論より薄い分を再現。未指定=1.0、put/call 両側に適用） */
  creditScale?: number;
  /**
   * put 側 IV skew の傾き（0/未指定=無効）。正で低 strike ほど IV↑ となり、実 equity skew
   * どおり put wing が急。skewedIvMonotonic に渡す。実 fill 較正値は ~6.30。
   */
  putSkewSlope?: number;
  /**
   * call 側 IV skew の傾き（0/未指定=無効）。skewedIvMonotonic に渡すと高 strike（call）は
   * IV↓ となる。put より緩い（実 fill 較正値 ~4.05）。単一スナップショット較正のため regime 依存に注意。
   */
  callSkewSlope?: number;
  /** entry 時の固定 slippage（per share, $。実 fill が mid より薄い分。put/call 各脚に適用。未指定=0） */
  entrySlippage?: number;

  /** 同時保有 condor 上限 */
  maxPositions: number;
  /** 1 condor あたりの想定コントラクト数（max loss = spreadWidth × 100 × contracts、片側） */
  contractsPerCondor: number;

  /** 1コントラクトあたり手数料（片道） */
  optionsCommission: number;

  /** インデックストレンドフィルター（SMA上でのみ新規エントリー） */
  indexTrendFilter: boolean;
  indexTrendSmaPeriod: number;
  /** VIX上限（VIXが閾値超なら新規エントリー停止） */
  vixCap: number;

  /** Equity DD ハードストップを有効化 */
  ddStopEnabled: boolean;
  /** DD 閾値（peak からの下落比率、0.15 = 15%）。ddStopEnabled=false 時無視 */
  ddStopThreshold: number;
  /** 再開までの経過日数（cooldown、例 252）。経過後 peak は current equity にリセット */
  ddStopCooldownDays: number;

  verbose: boolean;
}

export type CondorState = "OPEN" | "CLOSED";

export interface SimulatedCondor {
  underlyingSymbol: string;
  entryDate: string;
  expirationDate: string;
  entrySpotPrice: number;
  entryIV: number;

  putShortStrike: number;
  putLongStrike: number;
  callShortStrike: number;
  callLongStrike: number;
  putShortDeltaAtEntry: number;
  callShortDeltaAtEntry: number;

  /** put 側受領クレジット（1コントラクトあたり、per share） */
  putCredit: number;
  /** call 側受領クレジット（1コントラクトあたり、per share） */
  callCredit: number;
  /** 受領クレジット合計（1コントラクトあたり、per share = putCredit + callCredit） */
  creditReceived: number;
  contracts: number;

  state: CondorState;
  closeDate?: string;
  closeReason?:
    | "profit_target"
    | "stop_loss"
    | "expired_worthless"
    | "expired_max_loss"
    | "expired_partial";
  /** 決済時の残 condor 価格（1コントラクトあたり、per share） */
  closeCondorPrice?: number;
  /** 純損益（手数料込、ドル） */
  netPnl?: number;
  /** 全コミッション（ドル） */
  totalCommissions: number;
  /** entry 時の Risk-on/off レジーム（regime filter 有効時のみ） */
  regime?: string | null;
  /** entry 時のイベント近接（event-aware filter 有効時のみ） */
  eventProximity?: { eventType: string; daysAway: number } | null;
}

/**
 * event-aware filter で skip された entry の記録（バックテストレポート用）。
 */
export interface EventSkippedEntry {
  date: string;
  eventType: string;
  daysAway: number;
}

export interface IronCondorPerformanceMetrics extends PerformanceMetrics {
  totalCondors: number;
  /** 最大利益（クレジット全額）まで取れた数 */
  expiredWorthless: number;
  /** 最大損失（spreadWidth）に達した数 */
  maxLossCount: number;
  /** 早期利益決済 */
  profitTargetHits: number;
  /** ストップロス */
  stopLossHits: number;
  /** クレジット合計（受領） */
  totalCreditReceived: number;
  /** 平均クレジット率 = totalCredit / spreadWidth */
  avgCreditRatio: number;
  /** 平均保有日数 */
  avgHoldingDays: number;
}

export interface USIronCondorBacktestResult {
  config: USIronCondorBacktestConfig;
  condors: SimulatedCondor[];
  equityCurve: DailyEquity[];
  metrics: IronCondorPerformanceMetrics;
  /** event-aware filter 有効時に skip された entry の一覧（無効時は空配列） */
  eventSkips: EventSkippedEntry[];
}
