/**
 * lookback 営業日前 → 直近のパーセントリターン（%）
 * データ不足や past price ≤ 0 の場合は null
 */
export function pctReturn(prices: number[], lookback: number): number | null {
  if (prices.length < lookback + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - lookback];
  if (past <= 0) return null;
  return ((recent - past) / past) * 100;
}
