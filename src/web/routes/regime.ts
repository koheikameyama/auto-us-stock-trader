/**
 * 相場局面（レジーム）API
 *
 * - GET /api/regime      : 公開・無料サブセット。レベル + 一言 + 主要指標の生値（breadth / VIX）+
 *                          シグナル本数 + divergence の有無（フラグのみ）まで。
 *                          シグナルの内訳・divergence の中身・大強気への距離は返さない（有料予定）。
 * - GET /api/regime/full : 5シグナル内訳・大強気への距離・divergence 詳細を含む全量（認証内側）。
 *
 * 局面データは引け後に日次更新のため、短時間の in-memory キャッシュで DB 負荷を抑える。
 * KOH-560: breadth divergence 開示 Phase 0
 */

import { Hono } from "hono";
import {
  getLevelEmoji,
  getLevelLabel,
  getLevelSummary,
  SIGNAL_LABELS,
  type BullMarketSignals,
} from "../../core/regime-shift-detector";
import { getRegimeCached, getDivergenceCached } from "../regime-cache";

const app = new Hono();

const SIGNAL_TOTAL = Object.keys(SIGNAL_LABELS).length;

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** GET /api/regime — 公開・無料サブセット */
app.get("/", async (c) => {
  try {
    const [r, div] = await Promise.all([
      getRegimeCached(),
      getDivergenceCached(),
    ]);
    return c.json({
      asOfDate: toDateStr(r.asOfDate),
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
      /** S&P 500 に対して breadth が追随していない状態かどうか（フラグのみ、詳細は有料） */
      breadthDivergence: div.state === "DIVERGING",
      breadth: r.current.breadth,
      /** breadth の強気閾値（54%）。無料でも文脈として開示 */
      breadthThreshold: 0.54,
      vix: Number.isFinite(r.current.vix) ? r.current.vix : null,
      signalCount: r.signalCount,
      signalTotal: SIGNAL_TOTAL,
    });
  } catch (e) {
    console.error("[api/regime] detection failed:", e);
    return c.json({ error: "regime_unavailable" }, 503);
  }
});

/** GET /api/regime/full — 指標値・5シグナル内訳・大強気への距離・divergence 詳細（認証内側） */
app.get("/full", async (c) => {
  try {
    const [r, div] = await Promise.all([
      getRegimeCached(),
      getDivergenceCached(),
    ]);
    const missing = (Object.keys(r.signals) as (keyof BullMarketSignals)[])
      .filter((k) => !r.signals[k])
      .map((k) => SIGNAL_LABELS[k]);

    return c.json({
      asOfDate: toDateStr(r.asOfDate),
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
      signalCount: r.signalCount,
      signalTotal: SIGNAL_TOTAL,
      indicators: {
        breadth: r.current.breadth,
        breadthChange30d: r.current.breadthChange30d,
        sp500: r.current.sp500,
        sp500Sma50: r.current.sp500Sma50,
        sp500Sma50Slope10d: r.current.sp500Sma50Slope10d,
        vix: Number.isFinite(r.current.vix) ? r.current.vix : null,
      },
      signals: r.signals,
      distanceToStrong: {
        needed: SIGNAL_TOTAL - r.signalCount,
        missing,
      },
      /** KOH-560: breadth divergence 詳細（有料枠） */
      breadthDivergence: {
        state: div.state,
        isDiverging: div.state === "DIVERGING",
        spxHigh: div.spxHigh,
        spxLatest: div.spxLatest,
        /** lookback 期間での breadth 変化（pp）。負値 = 下落 */
        breadthTrendPP: Math.round(div.breadthTrendPP * 1000) / 1000,
        breadthLatest: div.breadthLatest,
        sinceDate: div.sinceDate ? toDateStr(div.sinceDate) : null,
      },
    });
  } catch (e) {
    console.error("[api/regime/full] detection failed:", e);
    return c.json({ error: "regime_unavailable" }, 503);
  }
});

export default app;
