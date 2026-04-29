import type { DailyEquity } from "../types";
import type { DDPeriod } from "./types";

/**
 * equity curve から running max を追跡して連続 DD 期間を識別、
 * ddPct 降順で上位 topN を返却。matchedEvent は別途タグ付け（window-analyzer）。
 *
 * 各 DD 期間は: peak (running max が更新された日) → trough (running max からの最大乖離日)
 *               → recovery (totalEquity が peakEquity に戻った最初の日、または null)
 */
export function extractDDPeriods(
  equityCurve: DailyEquity[],
  topN: number,
): DDPeriod[] {
  if (equityCurve.length === 0) return [];

  const periods: DDPeriod[] = [];
  let peakEquity = equityCurve[0].totalEquity;
  let peakDate = equityCurve[0].date;
  let inDD = false;
  let troughEquity = peakEquity;
  let troughDate = peakDate;

  for (let i = 1; i < equityCurve.length; i++) {
    const { date, totalEquity } = equityCurve[i];

    if (totalEquity >= peakEquity) {
      // 新ピーク or 復元
      if (inDD) {
        // recovery
        periods.push({
          peakDate,
          troughDate,
          recoveryDate: date,
          peakEquity,
          troughEquity,
          ddPct: (peakEquity - troughEquity) / peakEquity,
          ddDollar: peakEquity - troughEquity,
          durationDays: dateDiff(peakDate, troughDate),
          matchedEvent: null,
          tradesInPeriod: [],
        });
        inDD = false;
      }
      peakEquity = totalEquity;
      peakDate = date;
      troughEquity = totalEquity;
      troughDate = date;
    } else {
      // DD 中
      inDD = true;
      if (totalEquity < troughEquity) {
        troughEquity = totalEquity;
        troughDate = date;
      }
    }
  }

  // ループ終了時に DD 中なら未復元として push
  if (inDD) {
    periods.push({
      peakDate,
      troughDate,
      recoveryDate: null,
      peakEquity,
      troughEquity,
      ddPct: (peakEquity - troughEquity) / peakEquity,
      ddDollar: peakEquity - troughEquity,
      durationDays: dateDiff(peakDate, troughDate),
      matchedEvent: null,
      tradesInPeriod: [],
    });
  }

  return periods.sort((a, b) => b.ddPct - a.ddPct).slice(0, topN);
}

function dateDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
