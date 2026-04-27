/**
 * バックテスト用データ取得（auto_us_stock_trader schema）
 *
 * - 個別株 OHLCV: prisma.stockDailyBar
 * - 指数 (^GSPC, ^VIX): prisma.indexDailyBar
 * - 決算日: prisma.earningsDate
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma";
import type { OHLCVData } from "../core/technical-analysis";

/**
 * StockDailyBar テーブルから OHLCV データを一括取得
 */
export async function fetchHistoricalFromDB(
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
 * VIX データ取得（IndexDailyBar から）
 */
export async function fetchVixFromDB(
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const rows = await prisma.indexDailyBar.findMany({
    where: {
      tickerCode: "^VIX",
      date: {
        gte: new Date(`${startDate}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });

  const vixMap = new Map<string, number>();
  for (const row of rows) {
    vixMap.set(dayjs(row.date).format("YYYY-MM-DD"), row.close);
  }
  return vixMap;
}

/**
 * 市場指数データ取得（SMA計算用にlookbackDays分を含めて取得）
 *
 * @param tickerCode 指数コード（例: "^GSPC"）
 */
export async function fetchIndexFromDB(
  tickerCode: string,
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, number>> {
  const adjustedStart = dayjs(startDate)
    .subtract(lookbackDays, "day")
    .format("YYYY-MM-DD");

  const rows = await prisma.indexDailyBar.findMany({
    where: {
      tickerCode,
      date: {
        gte: new Date(`${adjustedStart}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });

  const indexMap = new Map<string, number>();
  for (const row of rows) {
    indexMap.set(dayjs(row.date).format("YYYY-MM-DD"), row.close);
  }
  return indexMap;
}

/**
 * 決算日データ取得
 */
export async function fetchEarningsFromDB(
  tickerCodes: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Set<string>>> {
  const rows = await prisma.earningsDate.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      date: {
        gte: new Date(`${startDate}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    select: { tickerCode: true, date: true },
  });

  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const ticker = row.tickerCode;
    if (!result.has(ticker)) result.set(ticker, new Set());
    result.get(ticker)!.add(dayjs(row.date).format("YYYY-MM-DD"));
  }
  return result;
}
