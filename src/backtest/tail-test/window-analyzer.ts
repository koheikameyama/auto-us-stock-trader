import type { DailyEquity } from "../types";
import type { SimulatedSpread } from "../us/us-credit-spread-types";
import type { DDPeriod, StressWindow, WindowAnalysis } from "./types";

export function analyzeWindow(
  window: StressWindow,
  equityCurve: DailyEquity[],
  closedSpreads: SimulatedSpread[],
): WindowAnalysis {
  const inWindow = equityCurve.filter((e) => e.date >= window.start && e.date <= window.end);
  if (inWindow.length === 0) {
    return {
      window, dataAvailable: false,
      startEquity: 0, endEquity: 0, pnl: 0, pnlPct: 0, ddPct: 0,
      spreadCount: 0, winRate: 0, totalPnl: 0,
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

  const inWindowSpreads = closedSpreads.filter((s) => {
    const enterIn = s.entryDate >= window.start && s.entryDate <= window.end;
    const closeIn = s.closeDate ? s.closeDate >= window.start && s.closeDate <= window.end : false;
    return enterIn || closeIn;
  });
  const wins = inWindowSpreads.filter((s) => (s.netPnl ?? 0) > 0).length;
  const totalPnl = inWindowSpreads.reduce((acc, s) => acc + (s.netPnl ?? 0), 0);

  return {
    window, dataAvailable: true,
    startEquity, endEquity,
    pnl: endEquity - startEquity,
    pnlPct: (endEquity - startEquity) / startEquity,
    ddPct: maxDD,
    spreadCount: inWindowSpreads.length,
    winRate: inWindowSpreads.length === 0 ? 0 : wins / inWindowSpreads.length,
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
