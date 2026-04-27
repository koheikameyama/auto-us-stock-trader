/**
 * テクニカル指標パラメータ
 */

// MACD計算パラメータ
export const MACD_CONFIG = {
  FAST_PERIOD: 12,
  SLOW_PERIOD: 26,
  SIGNAL_PERIOD: 9,
} as const;

// ボリンジャーバンドのデフォルト値
export const BOLLINGER_DEFAULTS = {
  PERIOD: 20,
  STD_DEV: 2,
} as const;

// 移動平均線の期間
export const SMA_PERIODS = {
  SHORT: 5,
  MEDIUM: 25,
  LONG: 75,
} as const;

// テクニカルシグナル判定閾値
export const TECHNICAL_SIGNAL = {
  STRONG_BUY: 1.5,
  BUY: 0.5,
  SELL: -0.5,
  STRONG_SELL: -1.5,
  // シグナルの加重値
  MA_WEIGHT: 0.5, // SMA/MACD上下の調整値
  PERFECT_ORDER: 1, // パーフェクトオーダー（全MA整列+同方向）
  PARTIAL_ORDER: 0.3, // 並び順は正しいが方向性が不揃い
} as const;

// 窓（ギャップ）検出パラメータ
export const GAP_DETECTION = {
  LOOKBACK_DAYS: 5,
} as const;

// 支持線・抵抗線検出パラメータ
export const SUPPORT_RESISTANCE = {
  MIN_DATA_POINTS: 20,
  BUCKET_COUNT: 20,
  TOP_LEVELS: 3,
} as const;

// 移動平均線の並び順・方向性判定
export const MA_ALIGNMENT = {
  SLOPE_LOOKBACK: 5,
} as const;

// 出来高分析
export const VOLUME_ANALYSIS = {
  AVERAGE_PERIOD: 20,
} as const;

// テクニカル分析に必要な最小データポイント数
export const TECHNICAL_MIN_DATA = {
  BASIC: 2, // analyzeTechnicals の最低要件
  ATR: 15, // ATR(14)計算に必要
  SCANNER_MIN_BARS: 15, // 市場スキャナーの最低要件
  WEEKLY_MIN_BARS: 14, // 週足トレンド分析に必要な最小バー数
} as const;

// トレンドラインスコアリングの重み
export const TRENDLINE_SCORE = {
  TOUCH_WEIGHT: 10,
  SPAN_WEIGHT: 0.1,
  VIOLATION_PENALTY: 5,
} as const;
