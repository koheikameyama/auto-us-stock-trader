/**
 * 週足レンジブレイク戦略の定数
 */
export const WEEKLY_BREAK = {
  ENTRY: {
    /** N週高値ルックバック（週数） */
    HIGH_LOOKBACK_WEEKS: 13,
    /** 週足出来高サージ倍率 */
    VOL_SURGE_RATIO: 1.3,
    /** 最低日次平均出来高（25日） */
    MIN_AVG_VOLUME_25: 100_000,
    /** 最低ATR%（日足） */
    MIN_ATR_PCT: 1.5,
  },
  STOP_LOSS: {
    /** SL = entry - ATR × this（WF最適値: atr=1.0が全6ウィンドウで安定） */
    ATR_MULTIPLIER: 1.0,
  },
  MARKET_FILTER: {
    BREADTH_THRESHOLD: 0.6,
  },
  GUARD: {
    /** スキャン実行時刻（JST、15:24）— 東証クロージングオークション（15:25〜）直前に発注 */
    SCAN_HOUR: 15,
    SCAN_MINUTE: 24,
  },
  /** 本番エントリー有効フラグ */
  ENTRY_ENABLED: false,
} as const;
