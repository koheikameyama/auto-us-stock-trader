/**
 * PEAD のストップロス価格計算（純関数）。
 *
 * - ATR ベースの stop（entry - ATR × atrMultiplier）
 * - ハードキャップ（entry × (1 - maxLossPct)）
 * いずれか tighter（entry に近い）方を採用。
 */

export interface PeadStopLossInputs {
  entryPrice: number;
  atr14: number;
  atrMultiplier: number;
  /** 例: 0.05 = 5%（entry × (1 - maxLossPct) を最深 SL とする） */
  maxLossPct: number;
}

/**
 * PEAD ストップロス価格を返す。
 * SL が entry 以上になる縮退ケースは null を返す（呼び出し側で skip 想定）。
 */
export function calculatePeadStopLoss(
  inputs: PeadStopLossInputs,
): number | null {
  const { entryPrice, atr14, atrMultiplier, maxLossPct } = inputs;
  const rawSL = entryPrice - atr14 * atrMultiplier;
  const maxSL = entryPrice * (1 - maxLossPct);
  const stopLossPrice = Math.max(rawSL, maxSL);
  if (stopLossPrice >= entryPrice) return null;
  return stopLossPrice;
}
