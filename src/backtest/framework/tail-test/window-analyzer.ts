import type { DailyEquity } from "../../types";
import type { Trade } from "../strategy-result";
import type { DDPeriod, StressWindow, WindowAnalysis } from "./types";

export function analyzeWindow(
  window: StressWindow,
  equityCurve: DailyEquity[],
  trades: Trade[],
): WindowAnalysis {
  const inWindow = equityCurve.filter((e) => e.date >= window.start && e.date <= window.end);
  if (inWindow.length === 0) {
    return {
      window, dataAvailable: false,
      startEquity: 0, endEquity: 0, pnl: 0, pnlPct: 0, ddPct: 0,
      tradeCount: 0, winRate: 0, totalPnl: 0,
    };
  }
  const startEquity = inWindow[0].totalEquity;
  const endEquity = inWindow[inWindow.length - 1].totalEquity;
  let runningMax = startEquity;
  let maxDD = 0;
  for (const e of inWindow) {
    if (e.totalEquity > runningMax) runningMax = e.totalEquity;
    const dd = (runningMax - e.totalEquity) / runningMax;
    if (dd > maxDD) maxDD = dd;
  }

  const inWindowTrades = trades.filter((t) => {
    const enterIn = t.entryDate >= window.start && t.entryDate <= window.end;
    const closeIn = t.closeDate ? t.closeDate >= window.start && t.closeDate <= window.end : false;
    return enterIn || closeIn;
  });
  const wins = inWindowTrades.filter((t) => (t.netPnl ?? 0) > 0).length;
  const totalPnl = inWindowTrades.reduce((acc, t) => acc + (t.netPnl ?? 0), 0);

  return {
    window, dataAvailable: true,
    startEquity, endEquity,
    pnl: endEquity - startEquity,
    pnlPct: (endEquity - startEquity) / startEquity,
    ddPct: maxDD,
    tradeCount: inWindowTrades.length,
    winRate: inWindowTrades.length === 0 ? 0 : wins / inWindowTrades.length,
    totalPnl,
  };
}

export function tagDDsWithEvents(
  dds: DDPeriod[],
  windows: readonly StressWindow[],
): DDPeriod[] {
  return dds.map((dd) => {
    const matched = windows.find((w) => {
      // peak または trough が window 内に入れば一致とする
      return (dd.peakDate >= w.start && dd.peakDate <= w.end)
        || (dd.troughDate >= w.start && dd.troughDate <= w.end);
    });
    return { ...dd, matchedEvent: matched?.name ?? null };
  });
}
