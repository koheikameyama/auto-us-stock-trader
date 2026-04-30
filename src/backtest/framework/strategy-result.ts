import type { DailyEquity } from "../types";

/**
 * 戦略横断で tail-test framework が消費する trade レコード。
 * spread 固有 (shortStrike, creditReceived 等) や rotation 固有 (ticker, shares 等)
 * のフィールドは含めず、tail-test に必要な最小情報だけを持つ。
 */
export interface Trade {
  /** 識別子（任意、レポート用） */
  symbol: string;
  /** エントリー日 YYYY-MM-DD */
  entryDate: string;
  /** クローズ日 YYYY-MM-DD（オープンの場合 null） */
  closeDate: string | null;
  /** 純損益（手数料込み、ドル） */
  netPnl: number | null;
  /** PnL 率（%、initialBudget もしくは position size 比、戦略により定義が変わる） */
  pnlPct: number | null;
  /** 保有日数 */
  holdingDays: number | null;
  /** 戦略固有カテゴリ（"win" | "loss" | "stopOut" | "rotation_exit" 等、optional） */
  category?: string;
}

/**
 * 戦略実行結果（tail-test framework が消費する標準形）。
 */
export interface StrategyResult {
  /** "credit-spread" | "dual-momentum" 等 */
  strategyName: string;
  /** 戦略固有 config（レポート 設定 セクション用、shape 任意） */
  config: Record<string, unknown>;
  /** 評価期間 */
  period: { start: string; end: string };
  /** 開始資金 */
  initialBudget: number;
  /** 日次 equity curve */
  equityCurve: DailyEquity[];
  /** クローズ済 trade（tail-metrics / window-analyzer の入力） */
  trades: Trade[];
  /** 戦略全体メトリクス（base metrics 計算済） */
  metrics: {
    winRate: number;        // 0..1
    profitFactor: number;
    maxDrawdown: number;    // 0..1
    netReturnPct: number;   // 累積リターン
  };
}
