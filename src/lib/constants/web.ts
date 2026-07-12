/**
 * Web UI・ルート設定
 */

// 相場局面モニター（米国株版）公開ページの正規 URL。メール・OGP から参照する単一の真実。
// env PUBLIC_SITE_URL で上書き可能（デプロイ時のドメインに合わせる）。
export const PUBLIC_SITE_URL =
  process.env.PUBLIC_SITE_URL ?? "https://us.stock-buddy.net/";

// 公開ホスト（このホストで来たリクエストは公開ページのみを出す）。
// env PUBLIC_HOSTS（カンマ区切り）で上書き可能。
export const PUBLIC_HOSTS: ReadonlySet<string> = new Set(
  (process.env.PUBLIC_HOSTS ?? "us.stock-buddy.net,www.us.stock-buddy.net")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

// チャートSVGパディング
export const CHART_PADDING = {
  TOP: 10,
  RIGHT: 10,
  BOTTOM: 20,
  LEFT: 50,
} as const;

// チャートのx軸ラベル表示閾値
export const CHART_LABEL_THRESHOLD = 15;

// ルートのクエリ制限
export const QUERY_LIMITS = {
  ORDER_HISTORY: 50,
  POSITIONS_CLOSED: 20,
  HISTORY_SUMMARIES: 30,
  WEEKLY_SUMMARIES: 12,
  WATCHLIST_PER_PAGE: 50,
  UNFILLED_FOLLOWUP: 50,
} as const;

// 日経225チャートの期間→インターバルマッピング
export const NIKKEI_CHART_PERIODS: Record<string, { interval: string; label: string }> = {
  "1d": { interval: "5m", label: "1日" },
  "5d": { interval: "15m", label: "1週" },
  "1mo": { interval: "1d", label: "1月" },
  "3mo": { interval: "1d", label: "3月" },
};

// ルートのルックバック日数
export const ROUTE_LOOKBACK_DAYS = {
  POSITIONS_CLOSED: 7,
  HISTORY: 30,
} as const;

