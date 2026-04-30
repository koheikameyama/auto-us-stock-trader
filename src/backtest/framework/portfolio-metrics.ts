import type { DailyEquity } from "../types";
import { dailyReturns } from "./correlation";

/**
 * CAGR (compound annual growth rate)。
 * curve.length / 252 を年数として、最終 equity / initialBudget の年率複利を返す。
 */
export function calculateAnnualizedReturn(
  curve: DailyEquity[],
  initialBudget: number,
): number {
  if (curve.length < 2) return 0;
  const finalEq = curve[curve.length - 1].totalEquity;
  const years = curve.length / 252;
  if (years <= 0) return 0;
  if (initialBudget <= 0) return 0;
  return Math.pow(finalEq / initialBudget, 1 / years) - 1;
}

/**
 * 年率 Sharpe ratio（日次リターンベース、riskFreeRate は年率）。
 * 標本標準偏差ではなく母集団標準偏差で計算（既存実装の慣習に合わせる）。
 * 分散ゼロ or 空配列は 0 を返す。
 */
export function calculateSharpeRatio(
  curve: DailyEquity[],
  riskFreeRate = 0,
): number {
  const returns = dailyReturns(curve);
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  const dailyRiskFree = riskFreeRate / 252;
  return ((mean - dailyRiskFree) * 252) / (std * Math.sqrt(252));
}
