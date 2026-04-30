import type { DailyEquity } from "../../types";
import type { Trade } from "../strategy-result";
import type { TailMetrics, VixBucket } from "./types";

export function calculateTailMetrics(
  trades: Trade[],
  equityCurve: DailyEquity[],
): TailMetrics {
  const closed = trades.filter((t) => t.closeDate != null && t.netPnl != null);
  if (closed.length === 0) {
    return { cvar5: 0, cvar1: 0, worstTrade: null, worstDay: null, consecutiveLossCount: 0 };
  }
  const sorted = [...closed].sort((a, b) => (a.netPnl ?? 0) - (b.netPnl ?? 0));
  const cvar5Count = Math.max(1, Math.floor(closed.length * 0.05));
  const cvar1Count = Math.max(1, Math.floor(closed.length * 0.01));
  const cvar5 = avg(sorted.slice(0, cvar5Count).map((t) => t.netPnl!));
  const cvar1 = avg(sorted.slice(0, cvar1Count).map((t) => t.netPnl!));

  // 連敗
  const byCloseDate = closed
    .filter((t) => t.closeDate != null)
    .sort((a, b) => (a.closeDate! < b.closeDate! ? -1 : 1));
  let cur = 0, max = 0;
  for (const t of byCloseDate) {
    if ((t.netPnl ?? 0) < 0) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }

  // worstDay
  let worstDay: TailMetrics["worstDay"] = null;
  let prev = equityCurve[0]?.totalEquity ?? 0;
  for (let i = 1; i < equityCurve.length; i++) {
    const dailyPnl = equityCurve[i].totalEquity - prev;
    if (worstDay == null || dailyPnl < worstDay.dailyPnl) {
      worstDay = { date: equityCurve[i].date, dailyPnl };
    }
    prev = equityCurve[i].totalEquity;
  }

  return { cvar5, cvar1, worstTrade: sorted[0], worstDay, consecutiveLossCount: max };
}

export function calculateVixBuckets(
  tradingDays: string[],
  vixMap: Map<string, number>,
  trades: Trade[],
): VixBucket[] {
  const buckets: VixBucket[] = [
    { label: ">30",   tradingDays: 0, tradeCount: 0, winRate: 0, pnlPerTrade: 0 },
    { label: "20-30", tradingDays: 0, tradeCount: 0, winRate: 0, pnlPerTrade: 0 },
    { label: "≤20",   tradingDays: 0, tradeCount: 0, winRate: 0, pnlPerTrade: 0 },
  ];
  const counters = buckets.map(() => ({ wins: 0, count: 0, totalPnl: 0 }));

  for (const day of tradingDays) {
    const v = vixMap.get(day);
    if (v == null) continue;
    const idx = v > 30 ? 0 : v > 20 ? 1 : 2;
    buckets[idx].tradingDays += 1;
  }
  for (const t of trades) {
    const v = vixMap.get(t.entryDate);
    if (v == null) continue;
    const idx = v > 30 ? 0 : v > 20 ? 1 : 2;
    counters[idx].count += 1;
    if ((t.netPnl ?? 0) > 0) counters[idx].wins += 1;
    counters[idx].totalPnl += t.netPnl ?? 0;
  }
  for (let i = 0; i < buckets.length; i++) {
    buckets[i].tradeCount = counters[i].count;
    buckets[i].winRate = counters[i].count === 0 ? 0 : counters[i].wins / counters[i].count;
    buckets[i].pnlPerTrade = counters[i].count === 0 ? 0 : counters[i].totalPnl / counters[i].count;
  }
  return buckets;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
