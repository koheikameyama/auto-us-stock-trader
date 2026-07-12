/**
 * 相場局面モニター（米国株 / S&P 500）
 *
 * リアルタイムでは「強気局面か否か」を 5 シグナルの点灯本数で毎日報告する。
 *
 * シグナル一覧:
 *   1. breadth が5営業日連続 54% 以上（過熱も「強気の証」として上限撤廃）
 *   2. breadth が直近30日で +10pp 以上回復
 *   3. S&P 500 (^GSPC) close > SMA50
 *   4. S&P 500 SMA50 が上向き（10日傾き > 0）
 *   5. VIX < 25
 *
 * 段階レベル:
 *   🔥 STRONG_BULL (5/5)  🟢 MODERATE_BULL (4/5)  🟡 EARLY_SIGNAL (3/5)  ⚪ NEUTRAL (0-2/5)
 */

import dayjs from "dayjs";
import { fetchBreadthSeries } from "./breadth-history";
import { fetchIndexFromDB, fetchVixFromDB } from "../backtest/data-fetcher";

export type SignalLevel =
  | "STRONG_BULL"
  | "MODERATE_BULL"
  | "EARLY_SIGNAL"
  | "NEUTRAL";

export const SIGNAL_LEVEL_ORDER: SignalLevel[] = [
  "NEUTRAL",
  "EARLY_SIGNAL",
  "MODERATE_BULL",
  "STRONG_BULL",
];

export interface BullMarketCurrent {
  breadth: number;
  breadthChange30d: number;
  sp500: number;
  sp500Sma50: number;
  sp500Sma50Slope10d: number;
  vix: number;
}

export interface BullMarketSignals {
  /** breadth が 5営業日連続 54% 以上 */
  breadthAboveThreshold5Days: boolean;
  /** breadth が直近30日で +10pp 以上回復 */
  breadthRecovery10pp: boolean;
  /** S&P 500 close > SMA50 */
  sp500AboveSma50: boolean;
  /** S&P 500 SMA50 が上向き */
  sp500Sma50Rising: boolean;
  /** VIX < 25 */
  vixLow: boolean;
}

export interface BullMarketResult {
  asOfDate: Date;
  level: SignalLevel;
  signalCount: number;
  signals: BullMarketSignals;
  current: BullMarketCurrent;
}

export const REGIME_SHIFT_PARAMS = {
  BAND_DAYS: 5,
  BREADTH_THRESHOLD: 0.54,
  BREADTH_RECOVERY_PP: 0.1,
  VIX_THRESHOLD: 25,
  SP500_SMA_PERIOD: 50,
  SMA_SLOPE_PERIOD: 10,
};

function computeSMASeries(values: number[], period: number): (number | null)[] {
  const series: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      series.push(null);
      continue;
    }
    const window = values.slice(i - period + 1, i + 1);
    series.push(window.reduce((a, b) => a + b, 0) / period);
  }
  return series;
}

export function determineLevel(signalCount: number): SignalLevel {
  if (signalCount >= 5) return "STRONG_BULL";
  if (signalCount >= 4) return "MODERATE_BULL";
  if (signalCount >= 3) return "EARLY_SIGNAL";
  return "NEUTRAL";
}

export async function detectRegimeShift(
  opts: { asOfDate?: Date } = {},
): Promise<BullMarketResult> {
  const today = opts.asOfDate ?? new Date();
  const endDate = dayjs(today).format("YYYY-MM-DD");

  const breadthSeries = await fetchBreadthSeries({
    lookbackDays: 90,
    endDate: today,
  });

  const indexStart = dayjs(endDate).subtract(180, "day").format("YYYY-MM-DD");
  const sp500Map = await fetchIndexFromDB("^GSPC", indexStart, endDate, 0);
  const vixMap = await fetchVixFromDB(indexStart, endDate);

  const sp500Closes = [...sp500Map.entries()]
    .map(([d, c]) => ({ date: d, close: c }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sp500Values = sp500Closes.map((r) => r.close);
  const sma50Series = computeSMASeries(
    sp500Values,
    REGIME_SHIFT_PARAMS.SP500_SMA_PERIOD,
  );

  const latestSp500 = sp500Closes[sp500Closes.length - 1];
  const latestSma50 = sma50Series[sma50Series.length - 1];
  const sma50_10dAgo =
    sma50Series[sma50Series.length - 1 - REGIME_SHIFT_PARAMS.SMA_SLOPE_PERIOD];

  const sma50Slope =
    latestSma50 != null && sma50_10dAgo != null
      ? (latestSma50 - sma50_10dAgo) / sma50_10dAgo
      : 0;

  const vixEntries = [...vixMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const latestVix =
    vixEntries.length > 0
      ? vixEntries[vixEntries.length - 1][1]
      : Number.POSITIVE_INFINITY;

  const latestBreadthPoint = breadthSeries[breadthSeries.length - 1];
  const lastN = breadthSeries.slice(-REGIME_SHIFT_PARAMS.BAND_DAYS);
  const breadthAboveThreshold5Days =
    lastN.length === REGIME_SHIFT_PARAMS.BAND_DAYS &&
    lastN.every((p) => p.breadth >= REGIME_SHIFT_PARAMS.BREADTH_THRESHOLD);

  const breadth30dAgo = breadthSeries[Math.max(0, breadthSeries.length - 31)];
  const breadthChange30d =
    latestBreadthPoint && breadth30dAgo
      ? latestBreadthPoint.breadth - breadth30dAgo.breadth
      : 0;

  const signals: BullMarketSignals = {
    breadthAboveThreshold5Days,
    breadthRecovery10pp:
      breadthChange30d >= REGIME_SHIFT_PARAMS.BREADTH_RECOVERY_PP,
    sp500AboveSma50: latestSma50 != null && latestSp500.close > latestSma50,
    sp500Sma50Rising: sma50Slope > 0,
    vixLow: latestVix < REGIME_SHIFT_PARAMS.VIX_THRESHOLD,
  };

  const signalCount = Object.values(signals).filter(Boolean).length;
  const level = determineLevel(signalCount);

  return {
    asOfDate: latestBreadthPoint?.date ?? today,
    level,
    signalCount,
    signals,
    current: {
      breadth: latestBreadthPoint?.breadth ?? 0,
      breadthChange30d,
      sp500: latestSp500?.close ?? 0,
      sp500Sma50: latestSma50 ?? 0,
      sp500Sma50Slope10d: sma50Slope,
      vix: latestVix,
    },
  };
}

const LEVEL_EMOJI: Record<SignalLevel, string> = {
  STRONG_BULL: "🔥",
  MODERATE_BULL: "🟢",
  EARLY_SIGNAL: "🟡",
  NEUTRAL: "⚪",
};

const LEVEL_LABEL: Record<SignalLevel, string> = {
  STRONG_BULL: "大強気相場",
  MODERATE_BULL: "強気優勢",
  EARLY_SIGNAL: "強気の初期サイン",
  NEUTRAL: "中立",
};

export function getLevelEmoji(level: SignalLevel): string {
  return LEVEL_EMOJI[level];
}

export function getLevelLabel(level: SignalLevel): string {
  return LEVEL_LABEL[level];
}

/**
 * 局面レベルの一言サマリー（無料サブセット / API・UI 共通）。
 * 客観的な「相場の状態」の記述に留め、売買推奨（「買い時」等）は含めない。
 */
const LEVEL_SUMMARY: Record<SignalLevel, string> = {
  STRONG_BULL: "大強気相場。5つのシグナルが全点灯し、トレンドが最も強い局面。",
  MODERATE_BULL: "強気優勢。多くのシグナルが点灯し、上昇基調が続いている局面。",
  EARLY_SIGNAL: "強気の初期サイン。点灯し始めているが、確度はまだ途上の局面。",
  NEUTRAL: "中立。強気シグナルは乏しく、方向感に欠ける局面。",
};

export function getLevelSummary(level: SignalLevel): string {
  return LEVEL_SUMMARY[level];
}

/** 各シグナルの表示ラベル（API・UI 共通） */
export const SIGNAL_LABELS: Record<keyof BullMarketSignals, string> = {
  breadthAboveThreshold5Days: "breadth が5営業日連続 54%以上",
  breadthRecovery10pp: "breadth が直近30日で +10pp 以上回復",
  sp500AboveSma50: "S&P 500 > SMA50",
  sp500Sma50Rising: "S&P 500 SMA50 が上向き",
  vixLow: "VIX < 25",
};
