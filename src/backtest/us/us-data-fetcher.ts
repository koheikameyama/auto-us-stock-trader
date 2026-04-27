/**
 * 米国株バックテスト用データ取得
 *
 * 本リポは US 専用なので market カラムでのフィルタリングは不要。
 * auto_us_stock_trader schema (Prisma 生成済み) のモデルを直接使用。
 */

import dayjs from "dayjs";
import { prisma } from "../../lib/prisma";
import type { OHLCVData } from "../../core/technical-analysis";
import { fetchVixFromDB, fetchIndexFromDB, fetchEarningsFromDB } from "../data-fetcher";

/**
 * DB内の米国株ティッカー一覧を取得
 */
export async function getUSTickerCodes(): Promise<string[]> {
  const rows = await prisma.stockDailyBar.findMany({
    select: { tickerCode: true },
    distinct: ["tickerCode"],
    orderBy: { tickerCode: "asc" },
  });

  return rows.map((r) => r.tickerCode);
}

/**
 * 米国株の OHLCV データを一括取得
 */
export async function fetchUSHistoricalFromDB(
  tickerCodes: string[],
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, OHLCVData[]>> {
  const adjustedStart = dayjs(startDate)
    .subtract(lookbackDays, "day")
    .format("YYYY-MM-DD");

  const rows = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      date: {
        gte: new Date(`${adjustedStart}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
    select: {
      tickerCode: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  const results = new Map<string, OHLCVData[]>();
  for (const row of rows) {
    const ticker = row.tickerCode;
    if (!results.has(ticker)) results.set(ticker, []);
    results.get(ticker)!.push({
      date: dayjs(row.date).format("YYYY-MM-DD"),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: Number(row.volume),
    });
  }

  return results;
}

/**
 * S&P 500 インデックスデータを取得
 */
export async function fetchSP500FromDB(
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, number>> {
  return fetchIndexFromDB("^GSPC", startDate, endDate, lookbackDays);
}

/**
 * VIX データを取得（既存関数を再エクスポート）
 */
export { fetchVixFromDB };

/**
 * 米国株の決算日データを取得
 */
export async function fetchUSEarningsFromDB(
  tickerCodes: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Set<string>>> {
  return fetchEarningsFromDB(tickerCodes, startDate, endDate);
}
