import type { DailyEquity } from "../types";

export interface StrategyAllocation {
  curve: DailyEquity[];
  weight: number; // 0..1
  initialBudget: number;
}

/**
 * 複数戦略の equity curve を重み付け合成し、portfolio equity curve を返す。
 *
 * 各戦略の equity curve は独自 initialBudget を持つので、まず "1 単位投資した場合のリターン率"
 * に正規化してから、重み付けで合成する。
 *
 * portfolio の initialBudget は Σ initialBudget_i * weight_i。
 * 共通日付のみ計算（戦略間で日付が違う場合は intersection）。
 */
export function combineEquityCurves(allocations: StrategyAllocation[]): DailyEquity[] {
  const totalWeight = allocations.reduce((s, a) => s + a.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 1e-6) {
    throw new Error(`weights must sum to 1.0, got ${totalWeight}`);
  }
  if (allocations.length === 0) return [];

  // Build date → equity map per strategy
  const maps = allocations.map(
    (a) => new Map(a.curve.map((d) => [d.date, d.totalEquity])),
  );

  // Common dates (intersection)
  const commonDates = [...maps[0].keys()]
    .filter((d) => maps.every((m) => m.has(d)))
    .sort();

  if (commonDates.length === 0) return [];

  const portfolioBudget = allocations.reduce(
    (s, a) => s + a.initialBudget * a.weight,
    0,
  );

  return commonDates.map((date) => {
    let portfolioEquity = 0;
    for (let i = 0; i < allocations.length; i++) {
      const strategyEquity = maps[i].get(date)!;
      const strategyReturnRate = strategyEquity / allocations[i].initialBudget;
      portfolioEquity += allocations[i].weight * strategyReturnRate * portfolioBudget;
    }
    return {
      date,
      cash: 0,
      positionsValue: portfolioEquity,
      totalEquity: portfolioEquity,
      openPositionCount: 0,
    };
  });
}
