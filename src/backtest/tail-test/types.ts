// src/backtest/tail-test/types.ts
import type { DailyEquity } from "../types";
import type { SimulatedSpread } from "../us/us-credit-spread-types";

export interface StressWindow {
  name: string;
  start: string; // YYYY-MM-DD inclusive
  end: string;   // YYYY-MM-DD inclusive
}

export interface DDPeriod {
  peakDate: string;
  troughDate: string;
  recoveryDate: string | null; // null if not recovered by end of equity
  peakEquity: number;
  troughEquity: number;
  ddPct: number;        // 正の値（22.5% は 0.225）
  ddDollar: number;
  durationDays: number; // peak から trough まで
  matchedEvent: string | null;
  tradesInPeriod: SimulatedSpread[];
}

export interface WindowAnalysis {
  window: StressWindow;
  dataAvailable: boolean;
  startEquity: number;
  endEquity: number;
  pnl: number;
  pnlPct: number;
  ddPct: number;
  spreadCount: number;
  winRate: number;
  totalPnl: number;
}

export interface TailMetrics {
  cvar5: number;
  cvar1: number;
  worstSpread: SimulatedSpread | null;
  worstDay: { date: string; dailyPnl: number } | null;
  consecutiveLossCount: number;
}

export interface VixBucket {
  label: ">30" | "20-30" | "≤20";
  tradingDays: number;
  spreadCount: number;
  winRate: number;
  pnlPerSpread: number;
}

export type ThresholdCategory = "平時" | "テール";

export interface ThresholdCheck {
  name: string;
  category: ThresholdCategory;
  actual: number | null;
  threshold: number;
  pass: boolean | null;  // null = data unavailable
  comment?: string;
}

export interface PassFailVerdict {
  overallPass: boolean;
  checks: ThresholdCheck[];
  summary: string;
}

export interface TailTestResult {
  configSummary: Record<string, unknown>;
  startDate: string;
  endDate: string;
  totalSpreads: number;
  baseMetrics: {
    winRate: number;
    profitFactor: number;
    cagr: number;
    maxDrawdown: number;
    netReturnPct: number;
  };
  ddRanking: DDPeriod[];
  stressWindows: WindowAnalysis[];
  tailMetrics: TailMetrics;
  vixBuckets: VixBucket[];
  verdict: PassFailVerdict;
  equityCurve: DailyEquity[];
  closedSpreads: SimulatedSpread[];
}
