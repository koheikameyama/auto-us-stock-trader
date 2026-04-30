/**
 * PEAD（Post-Earnings Announcement Drift）gap+volume シグナル判定。
 *
 * 決算翌日の OHLC + 出来高から entry signal を算出する純関数。
 * 副作用なし、入力数値のみで判定する（universe filter 等は呼び出し側責務）。
 */

export interface PeadGapSignalInputs {
  /** 前営業日終値 */
  prevClose: number;
  /** 当日寄付値 */
  todayOpen: number;
  /** 当日終値（陽線判定用） */
  todayClose: number;
  /** 当日出来高 */
  todayVolume: number;
  /** 25 日平均出来高 */
  avgVolume25: number;
  /** ギャップ最小値（例 0.03 = 3%） */
  gapMinPct: number;
  /** 出来高サージ倍率（例 1.5 = 1.5倍） */
  volSurgeRatio: number;
}

export interface PeadGapSignal {
  /** 小数 4 桁丸めの gap 比率（例 0.0346） */
  gapPct: number;
  /** 小数 2 桁丸めの出来高倍率（例 1.88） */
  volumeSurgeRatio: number;
}

/**
 * gap + volume + 陽線で PEAD entry signal を生成。
 *
 * 戻り値:
 *   - signal: PEAD 条件を満たすとき gap/volume を丸めた値
 *   - null:   いずれかの条件を満たさないとき
 */
export function detectPeadGapSignal(
  inputs: PeadGapSignalInputs,
): PeadGapSignal | null {
  const {
    prevClose,
    todayOpen,
    todayClose,
    todayVolume,
    avgVolume25,
    gapMinPct,
    volSurgeRatio,
  } = inputs;

  // ギャップ判定
  const gapPct = (todayOpen - prevClose) / prevClose;
  if (gapPct < gapMinPct) return null;

  // 陽線チェック（好決算 = 上昇方向）
  if (todayClose < todayOpen) return null;

  // 出来高サージ
  const ratio = todayVolume / avgVolume25;
  if (ratio < volSurgeRatio) return null;

  return {
    gapPct: Math.round(gapPct * 10000) / 10000,
    volumeSurgeRatio: Math.round(ratio * 100) / 100,
  };
}
