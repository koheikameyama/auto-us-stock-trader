/**
 * マーケット・ブレッス（breadth）履歴（米国株）
 *
 * StockDailyBar（US universe = 収集済み S&P500/600 銘柄）から、各銘柄の SMA25 を
 * ウィンドウ関数で算出し「終値 > SMA25」の銘柄比率を日次で返す。相場局面モニターの
 * breadth シグナルの単一ソース。本リポは US 専用 schema なので market フィルタは不要。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";

export interface BreadthHistoryPoint {
  date: Date;
  breadth: number;
}

/**
 * 過去 lookbackDays 営業日分の breadth 時系列を計算する（古い順）。
 * SMA25 のウィンドウ確保のため内部では lookback + バッファ暦日を取得する。
 */
export async function fetchBreadthSeries(opts: {
  lookbackDays: number;
  endDate?: Date;
}): Promise<BreadthHistoryPoint[]> {
  const endDate = opts.endDate ?? new Date();
  // 営業日 → 暦日換算で 1.5 倍 + SMA25 バッファ + 余裕
  const totalCalendarDays = Math.ceil(opts.lookbackDays * 1.5) + 40;
  const fromDate = dayjs(endDate).subtract(totalCalendarDays, "day").toDate();
  const calculationStart = dayjs(endDate)
    .subtract(Math.ceil(opts.lookbackDays * 1.5), "day")
    .toDate();

  const rows = await prisma.$queryRaw<
    { date: Date; above: number; total: number }[]
  >`
    WITH windowed AS (
      SELECT
        "tickerCode",
        date,
        close,
        AVG(close) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as sma25,
        COUNT(*) OVER (
          PARTITION BY "tickerCode"
          ORDER BY date
          ROWS 24 PRECEDING
        ) as window_count
      FROM "auto_us_stock_trader"."StockDailyBar"
      WHERE date >= ${fromDate}
        AND date <= ${endDate}
    )
    SELECT
      date,
      COUNT(*) FILTER (WHERE close > sma25)::int as above,
      COUNT(*)::int as total
    FROM windowed
    WHERE window_count >= 25
      AND date >= ${calculationStart}
    GROUP BY date
    ORDER BY date ASC
  `;

  return rows
    .filter((r) => r.total > 0)
    .map((r) => ({ date: r.date, breadth: r.above / r.total }));
}
