import type { DailyEquity } from "../types";

/**
 * 日次リターン（各日の equity 変化率）を計算。
 * 入力 < 2 点 / prev equity ≤ 0 は除外。
 */
export function dailyReturns(curve: DailyEquity[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].totalEquity;
    const cur = curve[i].totalEquity;
    if (prev > 0) returns.push(cur / prev - 1);
  }
  return returns;
}

export interface AlignedCurves {
  dates: string[];
  equityA: number[];
  equityB: number[];
}

/**
 * 2 つの equity curve を共通日付に揃える（ascending sort）。
 */
export function alignEquityCurves(
  a: DailyEquity[],
  b: DailyEquity[]
): AlignedCurves {
  const aMap = new Map(a.map((d) => [d.date, d.totalEquity]));
  const bMap = new Map(b.map((d) => [d.date, d.totalEquity]));
  const commonDates = [...aMap.keys()].filter((d) => bMap.has(d)).sort();
  return {
    dates: commonDates,
    equityA: commonDates.map((d) => aMap.get(d)!),
    equityB: commonDates.map((d) => bMap.get(d)!),
  };
}

/**
 * Pearson 相関係数（同じ長さの 2 配列）。
 * 分散ゼロ or 空配列の場合は 0 を返す。
 */
export function calculatePearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length) {
    throw new Error(`length mismatch: ${x.length} vs ${y.length}`);
  }
  const n = x.length;
  if (n === 0) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    denX = 0,
    denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return 0;
  return num / Math.sqrt(denX * denY);
}

export interface NamedCurve {
  name: string;
  curve: DailyEquity[];
}

/**
 * N 戦略間の相関行列 (Pearson) を計算。
 * 共通期間で日次リターンを取り出し、ペアごとに Pearson 相関を計算する。
 * 対称行列で対角は 1.0。
 */
export function calculateCorrelationMatrix(strategies: NamedCurve[]): number[][] {
  const n = strategies.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1.0;
      } else if (j > i) {
        const aligned = alignEquityCurves(strategies[i].curve, strategies[j].curve);
        // align で共通日付の equity が揃うので、daily return を取り直す
        const a: number[] = [];
        const b: number[] = [];
        for (let k = 1; k < aligned.dates.length; k++) {
          const prevA = aligned.equityA[k - 1];
          const prevB = aligned.equityB[k - 1];
          if (prevA > 0 && prevB > 0) {
            a.push(aligned.equityA[k] / prevA - 1);
            b.push(aligned.equityB[k] / prevB - 1);
          }
        }
        matrix[i][j] = calculatePearsonCorrelation(a, b);
      } else {
        matrix[i][j] = matrix[j][i]; // symmetric
      }
    }
  }
  return matrix;
}
