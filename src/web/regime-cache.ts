/**
 * 相場局面の取得を短時間キャッシュする共有ヘルパー。
 * 局面は引け後に日次更新のため、API・公開ページの両方から同じキャッシュを使う。
 *
 * KOH-560: breadth divergence 結果も同一 TTL でキャッシュする。
 */

import dayjs from "dayjs";
import {
  detectRegimeShift,
  type BullMarketResult,
} from "../core/regime-shift-detector";
import {
  detectBreadthDivergence,
  type BreadthDivergenceResult,
} from "../core/breadth-divergence";
import { fetchBreadthSeries } from "../core/breadth-history";
import { fetchIndexFromDB } from "../backtest/data-fetcher";

const CACHE_TTL_MS = 5 * 60 * 1000;

interface RegimeCache {
  at: number;
  result: BullMarketResult;
  divergence: BreadthDivergenceResult;
}

let cache: RegimeCache | null = null;

export async function getRegimeCached(): Promise<BullMarketResult> {
  await refreshCacheIfNeeded();
  return cache!.result;
}

export async function getDivergenceCached(): Promise<BreadthDivergenceResult> {
  await refreshCacheIfNeeded();
  return cache!.divergence;
}

async function refreshCacheIfNeeded(): Promise<void> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return;

  const today = new Date();
  const endDate = dayjs(today).format("YYYY-MM-DD");
  const lookbackStart = dayjs(today).subtract(60, "day").format("YYYY-MM-DD");

  // 局面検出と divergence 用データを並列取得
  const [result, breadthSeries, sp500Map] = await Promise.all([
    detectRegimeShift({ asOfDate: today }),
    fetchBreadthSeries({ lookbackDays: 30, endDate: today }),
    fetchIndexFromDB("^GSPC", lookbackStart, endDate, 0),
  ]);

  const spxSeries = [...sp500Map.entries()]
    .map(([d, close]) => ({ date: new Date(d), close }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const divergence = detectBreadthDivergence(breadthSeries, spxSeries);

  cache = { at: now, result, divergence };
}
