/**
 * 米国株バックテスト共通ヘルパー
 *
 * 日本株との差分を吸収するユーティリティ:
 * - 売買単位: 1株（日本は100株）
 * - 決済: T+1（日本はT+2）
 * - 値幅制限: なし
 * - コスト: SEC fee + スプレッド
 */

import type { OHLCVData } from "../../core/technical-analysis";
import { calculateUSTransactionCosts, calculateUSTax } from "./us-trading-costs";
import type { SimulatedPosition } from "../types";

/** 米国株の売買単位 */
export const US_UNIT_SHARES = 1;

/** 米国株の決済日数（T+1） */
export const US_SETTLEMENT_DAYS = 1;

/** テクニカル指標計算に必要な最低バー数 */
export const US_MIN_WINDOW_BARS = 80;

/** ユニバースフィルター通過判定 */
export function passesUSUniverseGates(params: {
  price: number;
  avgVolume25: number;
  atrPct: number;
  maxPrice: number;
  minPrice: number;
  minAvgVolume25: number;
  minAtrPct: number;
  minTurnover: number;
}): boolean {
  if (params.price > params.maxPrice) return false;
  if (params.price < params.minPrice) return false;
  if (params.avgVolume25 < params.minAvgVolume25) return false;
  if (params.atrPct < params.minAtrPct) return false;
  const turnover = params.price * params.avgVolume25;
  if (turnover < params.minTurnover) return false;
  return true;
}

/** 米国株のポジションサイジング（1株単位、リスクベース + 資金上限） */
export function calculateUSPositionSize(params: {
  cash: number;
  entryPrice: number;
  stopLossPrice: number;
  riskPerTradePct: number;
  positionCapEnabled: boolean;
}): number {
  const { cash, entryPrice, stopLossPrice, riskPerTradePct, positionCapEnabled } = params;

  const riskPerShare = entryPrice - stopLossPrice;
  if (riskPerShare <= 0) return 0;

  // リスクベースの株数
  const riskAmount = cash * (riskPerTradePct / 100);
  const riskBasedShares = Math.floor(riskAmount / riskPerShare);

  // 資金上限
  const maxPositionPct = positionCapEnabled
    ? getUSDynamicMaxPositionPct(cash, entryPrice)
    : 100;
  const budgetBasedShares = Math.floor(
    (cash * (maxPositionPct / 100)) / entryPrice,
  );

  const quantity = Math.min(riskBasedShares, budgetBasedShares);
  if (quantity <= 0) return 0;
  if (entryPrice * quantity > cash) return 0;

  return quantity;
}

/**
 * 米国株の動的ポジション上限（%）
 * 1株単位なので日本版（100株単位）より柔軟
 */
function getUSDynamicMaxPositionPct(
  effectiveCapital: number,
  stockPrice: number,
): number {
  const MIN_PCT = 20;
  const MAX_PCT = 40;
  const minRequired = Math.ceil((stockPrice / effectiveCapital) * 100);
  return Math.min(MAX_PCT, Math.max(MIN_PCT, minRequired));
}

// ──────────────────────────────────────────
// precompute (breakout-simulation.ts の precomputeSimData 米国版)
// ──────────────────────────────────────────

export interface USPrecomputedSimData {
  tradingDays: string[];
  tradingDayIndex: Map<string, number>;
  dateIndexMap: Map<string, Map<string, number>>;
  dailyBreadth: Map<string, number>;
  dailyIndexAboveSma: Map<string, boolean>;
}

/**
 * シミュレーション用の事前計算データを構築（米国版）
 *
 * - トレーディングデイ抽出
 * - 銘柄ごとの日付→インデックスマップ
 * - ブレッドス（SMA25上%）
 * - S&P500 SMAフィルター
 */
export function precomputeUSSimData(
  startDate: string,
  endDate: string,
  allData: Map<string, OHLCVData[]>,
  marketTrendFilter: boolean,
  indexTrendFilter: boolean,
  indexTrendSmaPeriod: number,
  indexData?: Map<string, number>,
): USPrecomputedSimData {
  // トレーディングデイの抽出（全銘柄のユニオン）
  const allDates = new Set<string>();
  for (const [, bars] of allData) {
    for (const bar of bars) {
      if (bar.date >= startDate && bar.date <= endDate) {
        allDates.add(bar.date);
      }
    }
  }
  const tradingDays = [...allDates].sort();
  const tradingDayIndex = new Map<string, number>();
  tradingDays.forEach((d, i) => tradingDayIndex.set(d, i));

  // 銘柄ごとの日付→バーインデックスマップ
  const dateIndexMap = new Map<string, Map<string, number>>();
  for (const [ticker, bars] of allData) {
    const indexMap = new Map<string, number>();
    bars.forEach((bar, i) => indexMap.set(bar.date, i));
    dateIndexMap.set(ticker, indexMap);
  }

  // ブレッドス: SMA25 上の銘柄比率
  const dailyBreadth = new Map<string, number>();
  if (marketTrendFilter) {
    for (const day of tradingDays) {
      let above = 0;
      let total = 0;
      for (const [ticker, bars] of allData) {
        const idx = dateIndexMap.get(ticker)?.get(day);
        if (idx == null || idx < 25) continue;
        const window = bars.slice(Math.max(0, idx - 24), idx + 1);
        if (window.length < 25) continue;
        const sma25 = window.reduce((s, b) => s + b.close, 0) / window.length;
        total++;
        if (bars[idx].close > sma25) above++;
      }
      dailyBreadth.set(day, total > 0 ? above / total : 0);
    }
  }

  // S&P 500 SMA フィルター
  const dailyIndexAboveSma = new Map<string, boolean>();
  if (indexTrendFilter && indexData) {
    const indexDates = [...indexData.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (let i = 0; i < indexDates.length; i++) {
      const [date, close] = indexDates[i];
      if (!tradingDayIndex.has(date)) continue;
      // SMA 計算
      const start = Math.max(0, i - indexTrendSmaPeriod + 1);
      const window = indexDates.slice(start, i + 1);
      if (window.length < indexTrendSmaPeriod) {
        dailyIndexAboveSma.set(date, true); // データ不足時は通す
        continue;
      }
      const sma =
        window.reduce((sum, [, c]) => sum + c, 0) / window.length;
      dailyIndexAboveSma.set(date, close >= sma);
    }
  }

  return {
    tradingDays,
    tradingDayIndex,
    dateIndexMap,
    dailyBreadth,
    dailyIndexAboveSma,
  };
}

// ──────────────────────────────────────────
// ポジションクローズ共通処理（米国版）
// ──────────────────────────────────────────

export function closeUSPosition(
  pos: SimulatedPosition,
  exitPrice: number,
  exitReason: SimulatedPosition["exitReason"],
  dayIdx: number,
  closedTrades: SimulatedPosition[],
  tradingDays: string[],
  costModelEnabled: boolean,
  verbose: boolean,
): void {
  const grossPnl = (exitPrice - pos.entryPrice) * pos.quantity;
  const pnlPct =
    pos.entryPrice > 0
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
      : 0;
  const entryDayIdx = tradingDays.indexOf(pos.entryDate);
  const holdingDays = entryDayIdx >= 0 ? dayIdx - entryDayIdx : 1;

  const exitValue = exitPrice * pos.quantity;
  const exitCost = costModelEnabled
    ? calculateUSTransactionCosts(exitValue, true)
    : 0;
  const totalCost = (pos.entryCommission ?? 0) + exitCost;
  const tax = calculateUSTax(grossPnl, totalCost);
  const netPnl = grossPnl - totalCost - tax;

  pos.exitDate = tradingDays[dayIdx];
  pos.exitPrice = exitPrice;
  pos.exitReason = exitReason;
  pos.pnl = Math.round(grossPnl * 100) / 100;
  pos.pnlPct = Math.round(pnlPct * 100) / 100;
  pos.holdingDays = holdingDays;
  pos.exitCommission = Math.round(exitCost * 100) / 100;
  pos.totalCost = Math.round(totalCost * 100) / 100;
  pos.tax = Math.round(tax * 100) / 100;
  pos.grossPnl = Math.round(grossPnl * 100) / 100;
  pos.netPnl = Math.round(netPnl * 100) / 100;

  closedTrades.push(pos);

  if (verbose) {
    console.log(
      `  [${tradingDays[dayIdx]}] ${pos.ticker} ${exitReason}: $${exitPrice.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%, ${holdingDays}d)`,
    );
  }
}
