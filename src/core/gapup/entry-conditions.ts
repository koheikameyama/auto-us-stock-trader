/**
 * ギャップアップエントリー条件の共通モジュール
 */

export function isGapUpSignal(params: {
  open: number;
  close: number;
  prevClose: number;
  volume: number;
  avgVolume25: number;
  gapMinPct: number;
  volSurgeRatio: number;
  /** vol >= この倍率のとき gap 条件を gapMinPctRelaxed に緩和。省略時=無効 */
  gapRelaxVolThreshold?: number;
  /** gapRelaxVolThreshold 超時の緩和 gap 閾値。省略時=gapMinPct と同値 */
  gapMinPctRelaxed?: number;
}): boolean {
  const {
    open, close, prevClose, volume, avgVolume25,
    gapMinPct, volSurgeRatio,
    gapRelaxVolThreshold, gapMinPctRelaxed,
  } = params;

  if (prevClose <= 0) return false;
  if (close < open) return false;
  if (avgVolume25 > 0 && volume < avgVolume25 * volSurgeRatio) return false;

  // vol が gapRelaxVolThreshold 以上なら緩和 gap を適用
  const volSurge = avgVolume25 > 0 ? volume / avgVolume25 : 0;
  const effectiveGapMin =
    gapRelaxVolThreshold != null &&
    gapMinPctRelaxed != null &&
    volSurge >= gapRelaxVolThreshold
      ? gapMinPctRelaxed
      : gapMinPct;

  if (open <= prevClose * (1 + effectiveGapMin)) return false;
  if (close <= prevClose * (1 + effectiveGapMin)) return false;

  return true;
}
