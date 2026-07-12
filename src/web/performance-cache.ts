/**
 * 公開ページ用の成績スナップショット短時間キャッシュ。
 *
 * 成績は引け後の決済で日次更新のため、regime-cache と同じ 5分 TTL で DB 負荷
 * （仕込み日ごとの detectRegimeShift 再計算を含む）を抑える。取得失敗時は古い
 * キャッシュ、無ければ null を返し、公開ページ側で成績セクションごと非表示にする。
 */

import {
  buildPerformanceSnapshot,
  type PerformanceSnapshot,
} from "../core/public-performance";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; snapshot: PerformanceSnapshot } | null = null;

export async function getPerformanceCached(): Promise<PerformanceSnapshot | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.snapshot;
  try {
    const snapshot = await buildPerformanceSnapshot();
    cache = { at: now, snapshot };
    return snapshot;
  } catch (e) {
    console.error("[performance-cache] snapshot failed:", e);
    return cache?.snapshot ?? null;
  }
}
