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
 * Prisma napi の string size limit を回避するためのティッカーチャンクサイズ。
 * 1000+ tickers を 1 クエリで投げると napi 側の制限に引っかかるため
 * IN 句を分割して順次取得する。
 */
const TICKER_FETCH_CHUNK_SIZE = 200;

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
 *
 * 内部で `TICKER_FETCH_CHUNK_SIZE` ごとに IN 句を分割して取得し、
 * Prisma napi の string size limit を回避する。
 * 呼び出し側は universe-wide のティッカー配列をそのまま渡してよい。
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

  const results = new Map<string, OHLCVData[]>();

  for (let i = 0; i < tickerCodes.length; i += TICKER_FETCH_CHUNK_SIZE) {
    const chunk = tickerCodes.slice(i, i + TICKER_FETCH_CHUNK_SIZE);

    const rows = await prisma.stockDailyBar.findMany({
      where: {
        tickerCode: { in: chunk },
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
 *
 * `fetchUSHistoricalFromDB` と同様に IN 句を `TICKER_FETCH_CHUNK_SIZE` ごとに
 * 分割して取得する（universe-wide 取得時の napi string size limit 回避）。
 */
export async function fetchUSEarningsFromDB(
  tickerCodes: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();

  for (let i = 0; i < tickerCodes.length; i += TICKER_FETCH_CHUNK_SIZE) {
    const chunk = tickerCodes.slice(i, i + TICKER_FETCH_CHUNK_SIZE);
    const partial = await fetchEarningsFromDB(chunk, startDate, endDate);
    for (const [ticker, dates] of partial) {
      const existing = result.get(ticker);
      if (existing) {
        for (const d of dates) existing.add(d);
      } else {
        result.set(ticker, dates);
      }
    }
  }

  return result;
}
