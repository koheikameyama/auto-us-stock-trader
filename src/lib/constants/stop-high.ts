/**
 * ストップ高フォロースルー戦略の定数
 *
 * 前日ストップ高張付け引け → 当日ギャップアップ + 続伸で当日終値エントリー。
 * 日本小型株特有の需給イベント（制限値幅ロック後の持ち越し買い）を捉える。
 */
export const STOP_HIGH = {
  ENTRY: {
    /** 前日終値がストップ高価格の何倍以上でストップ高とみなすか */
    STOP_HIGH_THRESHOLD_RATIO: 0.97,
    /** 当日最小ギャップ率（寄り/前日終値 - 1） */
    MIN_GAP_PCT: 0.02,
    /** 当日最小陽線幅（終値/始値 - 1） */
    MIN_BODY_PCT: 0.005,
    /** 当日最大陽線幅（ロックアップ再発を除外） */
    MAX_BODY_PCT: 0.15,
    /** 当日出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.0,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 2.0,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    /** 短期モメンタム。含み益なしは2日で切る */
    MAX_HOLDING_DAYS: 2,
    MAX_EXTENDED_HOLDING_DAYS: 4,
  },
  ENTRY_ENABLED: false,
} as const;
