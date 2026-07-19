/**
 * breadth ダイバージェンス判定（KOH-560）
 *
 * S&P 500 が lookback 日高値圏にあるにもかかわらず breadth が未追随の状態を検出する。
 * BT / API / SNS 共用の純関数として実装（DB アクセスなし・テスト可能）。
 *
 * 法務ガード: state 名・コメントは客観記述に限定。
 * 「天井サイン」「売り時」等の売買推奨は含めない。
 */

import type { BreadthHistoryPoint } from "./breadth-history";

// ────────────────────────────────────────────────────────────────────────────
// 定数（後から調整可能にするため切り出し）
// ────────────────────────────────────────────────────────────────────────────

export const BREADTH_DIVERGENCE_PARAMS = {
  /** S&P 500 高値判定の参照期間（営業日） */
  LOOKBACK_DAYS: 20,
  /**
   * 「S&P 500 が高値圏」の判定幅。
   * 最高値に対して最終終値がこの比率以内なら高値圏とみなす（例: 0.015 = 1.5% 以内）
   */
  SPX_HIGH_MARGIN: 0.015,
  /**
   * 「breadth が未追随」の判定幅。
   * lookback 期間の breadth 変化（pp）がこれ以下なら未追随とみなす（例: 0 = 下落 or 横ばい）
   */
  BREADTH_LAG_THRESHOLD_PP: 0,
} as const;

// ────────────────────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────────────────────

export type BreadthDivergenceState = "DIVERGING" | "CONFIRMING" | "NONE";

export interface BreadthDivergenceResult {
  /**
   * DIVERGING  : 指数が lookback 日高値圏にあるが、breadth は同期間で未追随
   * CONFIRMING : 指数の高値に breadth も追随している（健全な上昇）
   * NONE       : 指数が高値圏にない
   */
  state: BreadthDivergenceState;
  /** lookback 期間での S&P 500 の高値 */
  spxHigh: number;
  /** 最新の S&P 500 終値 */
  spxLatest: number;
  /** lookback 期間での breadth 変化（pp）。例: -0.05 = -5pp */
  breadthTrendPP: number;
  /** 最新の breadth 値 (0-1) */
  breadthLatest: number;
  /** DIVERGING 継続が確認できる場合の起点日（指数が lookback 高値を記録した日）。それ以外は null */
  sinceDate: Date | null;
}

// ────────────────────────────────────────────────────────────────────────────
// 純関数
// ────────────────────────────────────────────────────────────────────────────

/**
 * breadth ダイバージェンスを判定する純関数。
 *
 * @param breadthSeries - 日次 breadth 系列（古い順）。最低 lookback+1 件推奨。
 * @param spxSeries     - 日次 S&P 500 終値系列（古い順）。最低 lookback+1 件推奨。
 * @param lookback      - 参照期間（営業日）。既定は LOOKBACK_DAYS。
 */
export function detectBreadthDivergence(
  breadthSeries: BreadthHistoryPoint[],
  spxSeries: { date: Date; close: number }[],
  lookback: number = BREADTH_DIVERGENCE_PARAMS.LOOKBACK_DAYS,
): BreadthDivergenceResult {
  const FALLBACK: BreadthDivergenceResult = {
    state: "NONE",
    spxHigh: 0,
    spxLatest: 0,
    breadthTrendPP: 0,
    breadthLatest: 0,
    sinceDate: null,
  };

  if (breadthSeries.length < 2 || spxSeries.length < 2) return FALLBACK;

  // lookback 期間のウィンドウを取り出す
  const recentSpx = spxSeries.slice(-lookback);
  const recentBreadth = breadthSeries.slice(-lookback);

  if (recentSpx.length < 2 || recentBreadth.length < 2) return FALLBACK;

  const spxLatest = recentSpx[recentSpx.length - 1].close;
  const spxHigh = Math.max(...recentSpx.map((p) => p.close));

  const breadthLatest = recentBreadth[recentBreadth.length - 1].breadth;
  const breadthFirst = recentBreadth[0].breadth;
  const breadthTrendPP = breadthLatest - breadthFirst;

  // 「指数が高値圏」= 最高値から SPX_HIGH_MARGIN 以内
  const spxMarginRatio =
    (spxHigh - spxLatest) / spxHigh;
  const spxInHighZone =
    spxMarginRatio <= BREADTH_DIVERGENCE_PARAMS.SPX_HIGH_MARGIN;

  if (!spxInHighZone) {
    return {
      state: "NONE",
      spxHigh,
      spxLatest,
      breadthTrendPP,
      breadthLatest,
      sinceDate: null,
    };
  }

  // 高値圏にいる場合: breadth が未追随かどうかで DIVERGING / CONFIRMING を判定
  const isDiverging =
    breadthTrendPP <= BREADTH_DIVERGENCE_PARAMS.BREADTH_LAG_THRESHOLD_PP;

  // 高値記録日を sinceDate として返す
  const highIdx = recentSpx.reduce(
    (maxIdx, p, i) => (p.close >= recentSpx[maxIdx].close ? i : maxIdx),
    0,
  );
  const sinceDate = recentSpx[highIdx].date;

  return {
    state: isDiverging ? "DIVERGING" : "CONFIRMING",
    spxHigh,
    spxLatest,
    breadthTrendPP,
    breadthLatest,
    sinceDate,
  };
}
