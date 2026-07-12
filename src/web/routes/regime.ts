/**
 * 相場局面（レジーム）API
 *
 * - GET /api/regime      : 公開・無料サブセット。レベル + 一言 + 主要指標の生値（breadth / VIX）+
 *                          シグナル本数まで。シグナルの内訳・大強気への距離は返さない（有料予定）。
 * - GET /api/regime/full : 5シグナル内訳・大強気への距離を含む全量（認証内側）。
 *
 * 局面データは引け後に日次更新のため、短時間の in-memory キャッシュで DB 負荷を抑える。
 */

import { Hono } from "hono";
import {
  getLevelEmoji,
  getLevelLabel,
  getLevelSummary,
  SIGNAL_LABELS,
  type BullMarketSignals,
} from "../../core/regime-shift-detector";
import { getRegimeCached } from "../regime-cache";

const app = new Hono();

const SIGNAL_TOTAL = Object.keys(SIGNAL_LABELS).length;

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** GET /api/regime — 公開・無料サブセット */
app.get("/", async (c) => {
  try {
    const r = await getRegimeCached();
    return c.json({
      asOfDate: toDateStr(r.asOfDate),
      level: r.level,
      levelLabel: getLevelLabel(r.level),
      emoji: getLevelEmoji(r.level),
      summary: getLevelSummary(r.level),
      breadth: r.current.breadth,
      vix: Number.isFinite(r.current.vix) ? r.current.vix : null,
      signalCount: r.signalCount,
      signalTotal: SIGNAL_TOTAL,
    });
  } catch (e) {
    console.error("[api/regime] detection failed:", e);
    return c.json({ error: "regime_unavailable" }, 503);
  }
});

/** GET /api/regime/full — 指標値・5シグナル内訳・大強気への距離（認証内側） */
app.get("/full", async (c) => {
  try {
    const r = await getRegimeCached();
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
    });
  } catch (e) {
    console.error("[api/regime/full] detection failed:", e);
    return c.json({ error: "regime_unavailable" }, 503);
  }
});

export default app;
