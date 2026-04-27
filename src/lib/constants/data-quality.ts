/**
 * OHLCVデータ品質バリデーション定数
 */

export const DATA_QUALITY = {
  /** ヒストリカルデータの最低有効バー数（これ未満は信頼性不足で除外） */
  MIN_VALID_BARS: 15,

  /** 欠損率の上限（これを超えたらデータ品質不足で除外） */
  MAX_MISSING_RATE: 0.2,

  /** 前日比の異常値閾値（±50%以上の変動は異常値として除外） */
  MAX_DAILY_CHANGE_PCT: 0.5,
} as const;
