/**
 * Cross-Sectional Momentum シグナルランキング（純関数）。
 *
 * 1 日分の momentum signals を returnPct 降順にソートし、上位 topN 件を返す。
 * 入力配列は変更しない（コピーをソート）。
 */

import type { PrecomputedMomentumSignal } from "../us/us-momentum-simulation";

/**
 * returnPct 降順でソートして topN 件を返す。
 *
 * - 入力長が topN 未満なら全件返す
 * - topN ≤ 0 なら空配列
 * - 入力配列は mutate しない
 */
export function rankSignalsByReturn(
  signals: PrecomputedMomentumSignal[],
  topN: number,
): PrecomputedMomentumSignal[] {
  if (topN <= 0) return [];
  const sorted = [...signals].sort((a, b) => b.returnPct - a.returnPct);
  return sorted.slice(0, topN);
}
