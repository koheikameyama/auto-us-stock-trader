/**
 * 相場局面の取得を短時間キャッシュする共有ヘルパー。
 * 局面は引け後に日次更新のため、API・公開ページの両方から同じキャッシュを使う。
 */

import {
  detectRegimeShift,
  type BullMarketResult,
} from "../core/regime-shift-detector";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; result: BullMarketResult } | null = null;

export async function getRegimeCached(): Promise<BullMarketResult> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.result;
  // asOfDate は最新の DB データ日で駆動される（lookback が広いので当日厳密でなくてよい）
  const result = await detectRegimeShift({ asOfDate: new Date() });
  cache = { at: now, result };
  return result;
}
