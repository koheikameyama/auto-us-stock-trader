/**
 * ローソク足パターン設定
 */

// ローソク足の実体比率閾値
export const CANDLE_BODY = {
  LARGE_RATIO: 0.6, // 大陽線/大陰線の実体比率
  SMALL_RATIO: 0.2, // 小陽線/小陰線の実体比率
  DOJI_THRESHOLD: 0.01, // 同事線（値動きなし）判定
} as const;

// ヒゲの比率閾値
export const CANDLE_WICK = {
  LONG_RATIO: 0.3, // 長いヒゲの判定
} as const;

// パターン強度（0-100）
export const CANDLE_STRENGTH = {
  NEUTRAL_CLOSING: 50, // 値動きなし時の中立値
  DOJI: 30,
  LARGE_BODY: 80,
  HAMMER: 75,
  SHOOTING_STAR: 60,
  SMALL_BODY: 50,
  NORMAL: 55,
  BEARISH_HAMMER: 65,
  BEARISH_SHOOTING_STAR: 75,
} as const;

// シグナルフィルタリング
export const CANDLE_SIGNAL = {
  MAX_SIGNALS: 10,
  MIN_STRENGTH: 60, // シグナルとして記録する最小強度
} as const;

// 総合シグナルスコアリング
export const COMBINED_SIGNAL = {
  // RSIスコア
  RSI_STRONG_SCORE: 70, // RSI <= 30 or >= 70
  RSI_MODERATE_SCORE: 30, // RSI 30-40 or 60-70
  RSI_MODERATE_LOW: 40, // RSI下限（やや売られすぎ）
  RSI_MODERATE_HIGH: 60, // RSI上限（やや買われすぎ）
  // MACDスコア
  MACD_BASE_SCORE: 40,
  MACD_STRONG_THRESHOLD: 1, // ヒストグラム > 1 → 上昇トレンド
  MACD_WEAK_THRESHOLD: -1, // ヒストグラム < -1 → 下落トレンド
  // 買い/売り判定の差分閾値
  SIGNAL_BUY_THRESHOLD: 50,
  SIGNAL_SELL_THRESHOLD: -50,
  // 中立時の強度
  NEUTRAL_STRENGTH: 50,
} as const;
