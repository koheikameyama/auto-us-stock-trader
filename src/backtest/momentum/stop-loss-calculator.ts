/**
 * Cross-Sectional Momentum のストップロス価格計算（純関数）。
 *
 * - ATR ベースの stop（entry - ATR × atrMultiplier）
 * - ハードキャップ（entry × (1 - maxLossPct)）
 * いずれか tighter（entry に近い = 大きい数値）方を採用。
 *
 * 注: pead/stop-loss-calculator.ts と意味的に同一だが、
 *     Phase 2-B 時点では DRY は YAGNI、独立実装で維持する。
 */

export interface MomentumStopLossInputs {
  entryPrice: number;
  atr14: number;
  atrMultiplier: number;
  /** 例: 0.08 = 8%（entry × (1 - maxLossPct) を最深 SL とする） */
  maxLossPct: number;
}

/**
 * Momentum ストップロス価格を返す。
 * SL が entry 以上になる縮退ケースは null を返す（呼び出し側で skip 想定）。
 */
export function calculateMomentumStopLoss(
  inputs: MomentumStopLossInputs,
): number | null {
  const { entryPrice, atr14, atrMultiplier, maxLossPct } = inputs;
  const rawSL = entryPrice - atr14 * atrMultiplier;
  const maxSL = entryPrice * (1 - maxLossPct);
  const stopLossPrice = Math.max(rawSL, maxSL);
  if (stopLossPrice >= entryPrice) return null;
  return stopLossPrice;
}
