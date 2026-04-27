/**
 * NR7ブレイク戦略（Narrow Range 7 Breakout）の定数
 *
 * 7日間で最も狭いレンジ（ボラ収縮）→ブレイクアウト+出来高サージで拡張を捉える
 */
export const NR7 = {
  ENTRY: {
    /** NR7 ルックバック日数 */
    LOOKBACK_DAYS: 7,
    /** 出来高サージ倍率（avgVolume25比） */
    VOL_SURGE_RATIO: 1.5,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    MAX_HOLDING_DAYS: 5,
    MAX_EXTENDED_HOLDING_DAYS: 7,
  },
  ENTRY_ENABLED: true,
} as const;
