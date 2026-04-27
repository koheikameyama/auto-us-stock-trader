/**
 * 銘柄マスタ管理定数
 *
 * JPX CSV同期、廃止予定管理、立花API動的防御、ニュース検知
 */

// JPX CSV同期設定
export const JPX_CSV = {
  /** CSVファイルパス（プロジェクトルートからの相対パス） */
  CSV_FILE_PATH: "data/data_j.csv",

  /** CSVカラム名（JPX標準フォーマット） */
  COLUMNS: {
    DATE: "日付",
    CODE: "コード",
    NAME: "銘柄名",
    MARKET: "市場・商品区分",
    SECTOR_CODE_33: "33業種コード",
    SECTOR_NAME_33: "33業種区分",
    SECTOR_CODE_17: "17業種コード",
    SECTOR_NAME_17: "17業種区分",
    SCALE_CODE: "規模コード",
    SCALE_NAME: "規模区分",
  },

  /** 同期対象の市場（内国株式のみ） */
  TARGET_MARKETS: [
    "プライム（内国株式）",
    "スタンダード（内国株式）",
    "グロース（内国株式）",
  ],

  /** バッチupsertサイズ */
  UPSERT_BATCH_SIZE: 100,
} as const;

// JPX廃止予定スクレイピング設定
export const JPX_DELISTING = {
  /** JPX廃止予定ページURL */
  SCHEDULE_URL: "https://www.jpx.co.jp/listing/stocks/delisted/index.html",
  /** 廃止何日前から取引制限をかけるか */
  RESTRICTION_DAYS_BEFORE: 30,
} as const;

// JPX監理・整理銘柄スクレイピング設定
export const JPX_SUPERVISION = {
  /** JPX監理・整理銘柄一覧ページURL */
  LIST_URL: "https://www.jpx.co.jp/listing/market-alerts/supervision/index.html",
} as const;

// 立花APIステータス定義（将来実装用）
export const TACHIBANA_STATUS = {
  FLAGS: {
    SUPERVISION: "監理",
    REORGANIZATION: "整理",
    TRADING_HALT: "売買停止",
  },
} as const;

// 上場廃止ニュース検知キーワード
export const DELISTING_NEWS_KEYWORDS = [
  "上場廃止",
  "廃止決定",
  "整理銘柄",
  "監理銘柄",
  "売買停止",
  "上場廃止決定",
  "MBO",
  "完全子会社化",
  "スクイーズアウト",
] as const;
