/**
 * ギャップダウンリバーサル戦略の定数
 */
export const GAPDOWN_REVERSAL = {
  ENTRY: {
    GAP_MIN_PCT: 0.03,        // ギャップダウン最小幅（-3%）
    VOL_SURGE_RATIO: 1.5,     // 出来高サージ倍率
    MIN_AVG_VOLUME_25: 100_000,
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    ATR_MULTIPLIER: 1.0,
  },
  TIME_STOP: {
    MAX_HOLDING_DAYS: 2,          // ベース保有日数
    MAX_EXTENDED_HOLDING_DAYS: 3, // 延長上限
  },
} as const;
