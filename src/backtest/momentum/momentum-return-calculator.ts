/**
 * Cross-Sectional Momentum のルックバックリターン計算（純関数）。
 *
 * lookbackDays 営業日前の close から today close までの
 * パーセントリターン（%, ratio*100）を返す。
 *
 * 注: dual-momentum/momentum-calculator.ts の pctReturn と意味的に同じだが、
 *     こちらは「2 値からの計算」に絞ったシンプル形（呼び出し側で配列 indexing 済み）。
 *     Phase 2-B 時点では DRY は YAGNI、独立実装で維持する。
 */

/**
 * percent-return を返す。
 * lookbackClose が 0 以下の場合は null（div-by-zero / データ不正）。
 *
 * @param todayClose - 当日の close
 * @param lookbackClose - lookback 営業日前の close
 * @returns ((today - past) / past) * 100、または null
 */
export function calculateMomentumReturn(
  todayClose: number,
  lookbackClose: number,
): number | null {
  if (lookbackClose <= 0) return null;
  return ((todayClose - lookbackClose) / lookbackClose) * 100;
}
