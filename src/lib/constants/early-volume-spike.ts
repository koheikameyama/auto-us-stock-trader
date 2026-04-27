/**
 * Early Volume Spike 戦略の定数
 *
 * 出来高が平均の5倍以上に急増 + 20日高値の80-95%位置（まだブレイクしていない）
 * + 陽線 + ATR拡大 → ブレイクアウトの先取りエントリー。
 * breakout戦略（廃止済み）の空白を埋める「ブレイク前の仕込み」戦略。
 */
export const EARLY_VOLUME_SPIKE = {
  ENTRY: {
    /** 出来高サージ倍率（volume / avgVolume25 >= this） */
    VOL_SURGE_RATIO: 5.0,
    /** 20日高値に対する現在価格の最小比率（close / high20 >= this） */
    MIN_HIGH20_RATIO: 0.80,
    /** 20日高値に対する現在価格の最大比率（close / high20 < this）— 既にブレイク済みを除外 */
    MAX_HIGH20_RATIO: 0.95,
    /** 高値ルックバック日数 */
    HIGH_LOOKBACK_DAYS: 20,
    /** 当日最小陽線幅（close / open - 1） */
    MIN_BODY_PCT: 0.005,
    /** ATR拡大フィルター: 当日レンジ >= ATR14 × this */
    MIN_RANGE_ATR_RATIO: 1.0,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    /** ベース保有日数（3-5日保有想定） */
    MAX_HOLDING_DAYS: 5,
    MAX_EXTENDED_HOLDING_DAYS: 7,
  },
  ENTRY_ENABLED: false,
} as const;
