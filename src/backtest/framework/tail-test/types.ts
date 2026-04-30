// src/backtest/framework/tail-test/types.ts
import type { DailyEquity } from "../../types";
import type { Trade } from "../strategy-result";

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
  tradesInPeriod: Trade[];
}

export interface WindowAnalysis {
  window: StressWindow;
  dataAvailable: boolean;
  startEquity: number;
  endEquity: number;
  pnl: number;
  pnlPct: number;
  ddPct: number;
  tradeCount: number;
  winRate: number;
  totalPnl: number;
}

export interface TailMetrics {
  cvar5: number;
  cvar1: number;
  worstTrade: Trade | null;
  worstDay: { date: string; dailyPnl: number } | null;
  consecutiveLossCount: number;
}

export interface VixBucket {
  label: ">30" | "20-30" | "≤20";
  tradingDays: number;
  tradeCount: number;
  winRate: number;
  pnlPerTrade: number;
}

export type ThresholdCategory = "平時" | "テール";

export interface ThresholdCheck {
  name: string;
  category: ThresholdCategory;
  actual: number | null;
  threshold: number | null;
  pass: boolean | null;  // null = data unavailable or threshold not applicable
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
  totalTrades: number;
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
  trades: Trade[];
}
