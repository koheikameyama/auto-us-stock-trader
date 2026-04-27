/**
 * Down-Day Reversal 戦略の定数
 *
 * GU/PSCが停止する下落相場（breadth<0.4 + 日経SMA50下）でのみ稼働する逆張り戦略。
 * 個別銘柄-5%以上急落 + 出来高3倍 + 当日大陽線（引け>始値1.5%以上）で反転を捕捉。
 * 保有2-3日の短期決戦。
 */
export const DOWN_DAY_REVERSAL = {
  ENTRY: {
    /** 前日からの最小下落率（close / prevClose - 1 <= -this） */
    MIN_DROP_PCT: 0.05,
    /** 出来高サージ倍率 */
    VOL_SURGE_RATIO: 3.0,
    /** 当日最小陽線幅（close / open - 1 >= this）— 反転の大陽線 */
    MIN_BODY_PCT: 0.015,
    /** breadth上限（この未満でのみエントリー）— GU/PSCが停止する弱相場 */
    MAX_BREADTH: 0.4,
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    MAX_HOLDING_DAYS: 2,
    MAX_EXTENDED_HOLDING_DAYS: 3,
  },
  ENTRY_ENABLED: false,
} as const;
