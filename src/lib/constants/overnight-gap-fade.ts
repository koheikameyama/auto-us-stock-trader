/**
 * Overnight Gap-Fade 戦略の定数
 *
 * 前日大陽線(+5%以上) → 当日寄り付きでgapdown(-1〜-3%) → 引けで戻る（陽線転換）。
 * 短期過熱後の寄り付き調整→反発を捉える。1日保有の超短期。
 */
export const OVERNIGHT_GAP_FADE = {
  ENTRY: {
    /** 前日の最小陽線幅（prevClose / prevOpen - 1 >= this） */
    PREV_MIN_BODY_PCT: 0.05,
    /** 当日gapdown最小（open / prevClose - 1 <= -this） */
    MIN_GAP_DOWN_PCT: 0.01,
    /** 当日gapdown最大（open / prevClose - 1 >= -this）— 暴落ではなく調整 */
    MAX_GAP_DOWN_PCT: 0.05,
    /** 当日最小陽線幅（close / open - 1 >= this）— 引けで戻る */
    MIN_BODY_PCT: 0.005,
    /** 出来高サージ倍率（前日の出来高が平均の何倍以上か） */
    PREV_VOL_SURGE_RATIO: 2.0,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    /** 1日保有（翌日クローズ） */
    MAX_HOLDING_DAYS: 1,
    MAX_EXTENDED_HOLDING_DAYS: 2,
  },
  ENTRY_ENABLED: false,
} as const;
