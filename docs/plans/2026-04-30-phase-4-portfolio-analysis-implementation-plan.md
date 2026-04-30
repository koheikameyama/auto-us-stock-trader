# Phase 4: Portfolio 相関分析 + portfolio 化判断 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Tier 1 の 3 戦略 (Dual Momentum, PEAD, Cross-Sectional Momentum) と SPY Credit Spread の相関係数を実測し、portfolio simulation で diversifier としての価値を判定する。本番 portfolio 構成判断 (KOH-459 相当) の input になる。

**Architecture:**
1. 各戦略 (credit-spread + 3 Tier 1) を共通期間で再実行し `StrategyResult` を取得
2. `framework/correlation.ts` (Phase 1 で TDD 済) で日次リターン相関行列を算出
3. portfolio 合成関数を新規追加 (`framework/portfolio.ts`): 重み付け equity curves を合成 → portfolio equity curve
4. 等資金 50/50 (credit-spread + 各 diversifier) の 3 シナリオを simulate → tail-test 適用
5. Markdown レポートで相関行列 + 各 portfolio 評価を一覧化

**Tech Stack:** TypeScript / vitest / 既存 Prisma / framework/correlation.ts

**設計文書:**
- 全体設計: [2026-04-30-portfolio-strategy-evaluation-design.md](2026-04-30-portfolio-strategy-evaluation-design.md)
- Phase 0 完了: KOH-455 (Dual Momentum)
- Phase 1 完了: KOH-456 (framework 抽象化 + correlation.ts)
- Phase 2-A 完了: KOH-457 (PEAD)
- Phase 2-B 完了: KOH-458 (Cross-Sectional Momentum)

---

## 前提条件

- Phase 0/1/2-A/2-B 完了済
- `framework/correlation.ts` に `dailyReturns`, `alignEquityCurves`, `calculatePearsonCorrelation` が存在 (12 tests)
- 各戦略の runner が `StrategyResult` を生成可能（credit-spread/dual-momentum/PEAD/Momentum 全て）
- 既存 reports:
  - `docs/reports/credit-spread-tail-2026-04-30.md` (KOH-451 evidence, 全期間 2007-)
  - `docs/reports/dual-momentum-tail-2026-04-30.md` (Phase 0)
  - `docs/reports/pead-tail-2026-05-01.md` (Phase 2-A)
  - `docs/reports/momentum-tail-2026-05-01.md` (Phase 2-B)
- 全 106 tests + correlation 12 tests = pass、typecheck 0 errors

## 重要な前提判断

**Tier 1 の 3 戦略すべて単独 FAIL** (PEAD/Momentum 平時 metrics が壊滅的)。設計 doc では「Tier 1 で個別 pass した戦略を抽出 → portfolio 化」とあるが、今回は個別 PASS が無いので、**「単独 FAIL でも portfolio 化で diversifier として機能するか」を Phase 4 で判定する** という改訂前提で進める。

判定の意思決定ツリー:
- **portfolio Sharpe ≥ credit-spread 単独 Sharpe** AND **portfolio Max DD ≤ credit-spread 単独 Max DD**: portfolio 採用検討
- **どちらか劣化**: 単独 credit-spread のみで本番運用（diversifier 不採用）

## Phase 4 完了基準

- [ ] `src/backtest/framework/portfolio.ts` で重み付け portfolio equity curve 合成可能 (TDD)
- [ ] 共通期間 (4 戦略の overlap、おそらく 2015-01-03 以降) で 4 戦略の StrategyResult を取得
- [ ] credit-spread vs 各 Tier 1 戦略の相関係数行列を算出
- [ ] 50/50 portfolio (credit-spread + dual-momentum / + PEAD / + momentum) を simulate して tail-test
- [ ] レポート `docs/reports/portfolio-correlation-matrix-YYYY-MM-DD.md` 生成
- [ ] 結論: portfolio 採用 YES / 保留 / NO の判定が記録
- [ ] 全 vitest tests PASS、typecheck 0 errors
- [ ] framework 側のみ変更（既存 strategy runner は変更しない、またはオプショナル拡張）

---

## Task 1: Pre-flight + 既存テスト確認

**Files:** なし

**Step 1: 全テスト + typecheck**

Run: `npm run test && npm run typecheck`
Expected: 106+ tests PASS, 0 typecheck errors

**Step 2: 各戦略 runner が `StrategyResult` を返すか確認**

各 runner を読んで、`StrategyResult` の組み立て箇所を確認:
- `src/backtest/credit-spread/run-tail-test.ts`
- `src/backtest/dual-momentum/run-tail-test.ts`
- `src/backtest/pead/run-tail-test.ts`
- `src/backtest/momentum/run-tail-test.ts`

すべて `const strategyResult: StrategyResult = { ... }` を構築しているはず。

**Step 3: コミットなし**

---

## Task 2: TDD - portfolio.ts (重み付け equity curve 合成)

**Files:**
- Create: `src/backtest/framework/portfolio.ts`
- Create: `src/backtest/framework/__tests__/portfolio.test.ts`

**Step 1: 失敗テストを書く**

```ts
// src/backtest/framework/__tests__/portfolio.test.ts
import { describe, it, expect } from "vitest";
import { combineEquityCurves } from "../portfolio";
import type { DailyEquity } from "../../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: 0, positionsValue: totalEquity, totalEquity, openPositionCount: 0 };
}

describe("combineEquityCurves", () => {
  it("combines two curves with 50/50 weight (equal start)", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-01", 100), eq("2024-01-02",  90), eq("2024-01-03", 100)];
    // 50/50 portfolio: each has $50 initial.
    // Day 1: 50, 50 → 100
    // Day 2: 55 (110%), 45 (90%) → 100
    // Day 3: 60 (120%), 50 (100%) → 110
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 100 },
      { curve: b, weight: 0.5, initialBudget: 100 },
    ]);
    expect(portfolio.map((p) => p.totalEquity)).toEqual([100, 100, 110]);
  });

  it("normalizes by individual initialBudget then applies weight", () => {
    const a = [eq("2024-01-01", 1000), eq("2024-01-02", 1100)]; // 10% return
    const b = [eq("2024-01-01",  500), eq("2024-01-02",  525)]; //  5% return
    // Combined initialBudget = a.initial * w_a + b.initial * w_b
    // For 50/50, total = 1000 * 0.5 + 500 * 0.5 = 750
    // Day 0: 750 (start)
    // Day 1: a returns 10% (10% * 0.5 = 5%), b returns 5% (5% * 0.5 = 2.5%) → 7.5% portfolio return
    //   = 750 * 1.075 = 806.25
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 1000 },
      { curve: b, weight: 0.5, initialBudget: 500 },
    ]);
    expect(portfolio[0].totalEquity).toBeCloseTo(750, 2);
    expect(portfolio[1].totalEquity).toBeCloseTo(806.25, 2);
  });

  it("aligns dates and skips non-overlap", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-02", 100), eq("2024-01-03", 105), eq("2024-01-04", 110)];
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 100 },
      { curve: b, weight: 0.5, initialBudget: 100 },
    ]);
    expect(portfolio.map((p) => p.date)).toEqual(["2024-01-02", "2024-01-03"]);
  });

  it("throws when weights don't sum to 1.0 (within tolerance)", () => {
    const a = [eq("2024-01-01", 100)];
    expect(() => combineEquityCurves([
      { curve: a, weight: 0.4, initialBudget: 100 },
      { curve: a, weight: 0.4, initialBudget: 100 },
    ])).toThrow(/weight/i);
  });

  it("returns empty when no overlap", () => {
    const a = [eq("2024-01-01", 100)];
    const b = [eq("2024-02-01", 100)];
    const portfolio = combineEquityCurves([
      { curve: a, weight: 0.5, initialBudget: 100 },
      { curve: b, weight: 0.5, initialBudget: 100 },
    ]);
    expect(portfolio).toEqual([]);
  });
});
```

**Step 2: テスト失敗確認**

Run: `npx vitest run src/backtest/framework/__tests__/portfolio.test.ts`
Expected: FAIL（モジュール未存在）

**Step 3: 実装**

```ts
// src/backtest/framework/portfolio.ts
import type { DailyEquity } from "../types";

export interface StrategyAllocation {
  curve: DailyEquity[];
  weight: number;          // 0..1
  initialBudget: number;
}

/**
 * 複数戦略の equity curve を重み付け合成し、portfolio equity curve を返す。
 *
 * 各戦略の equity curve は独自 initialBudget を持つので、まず "1 単位投資した場合のリターン率"
 * に正規化してから、重み付けで合成する。
 *
 * 共通日付のみ計算（戦略間で日付が違う場合の取り扱い）。
 */
export function combineEquityCurves(allocations: StrategyAllocation[]): DailyEquity[] {
  const totalWeight = allocations.reduce((s, a) => s + a.weight, 0);
  if (Math.abs(totalWeight - 1.0) > 1e-6) {
    throw new Error(`weights must sum to 1.0, got ${totalWeight}`);
  }
  if (allocations.length === 0) return [];

  // Build date → equity map per strategy
  const maps = allocations.map((a) => new Map(a.curve.map((d) => [d.date, d.totalEquity])));

  // Common dates (intersection)
  const commonDates = [...maps[0].keys()]
    .filter((d) => maps.every((m) => m.has(d)))
    .sort();

  if (commonDates.length === 0) return [];

  const portfolioBudget = allocations.reduce((s, a) => s + a.initialBudget * a.weight, 0);

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
```

注: portfolio の initialBudget は `Σ initialBudget_i * weight_i`。各戦略 equity を initialBudget で割って return rate に変換 → weight 倍 → 合算。

**Step 4: テスト pass**

Run: `npx vitest run src/backtest/framework/__tests__/portfolio.test.ts`
Expected: 5/5 PASS

**Step 5: 全テスト + typecheck**

Run: `npm run test && npm run typecheck`

**Step 6: コミット**

```bash
git add src/backtest/framework/portfolio.ts src/backtest/framework/__tests__/portfolio.test.ts
git commit -m "feat(framework): combineEquityCurves (重み付け portfolio 合成) を TDD 追加"
```

---

## Task 3: TDD - correlation matrix helper

**Files:**
- Modify: `src/backtest/framework/correlation.ts` (関数追加)
- Modify: `src/backtest/framework/__tests__/correlation.test.ts` (テスト追加)

**Step 1: 失敗テストを追加**

```ts
// src/backtest/framework/__tests__/correlation.test.ts に追加
import { calculateCorrelationMatrix } from "../correlation";

describe("calculateCorrelationMatrix", () => {
  it("returns symmetric matrix with 1.0 diagonal", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-01", 100), eq("2024-01-02", 105), eq("2024-01-03", 110)];
    const matrix = calculateCorrelationMatrix([
      { name: "A", curve: a },
      { name: "B", curve: b },
    ]);
    expect(matrix.length).toBe(2);
    expect(matrix[0].length).toBe(2);
    expect(matrix[0][0]).toBeCloseTo(1.0, 5); // A vs A
    expect(matrix[1][1]).toBeCloseTo(1.0, 5); // B vs B
    expect(matrix[0][1]).toBeCloseTo(matrix[1][0], 5); // symmetric
  });

  it("identifies perfectly correlated curves", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-01", 50), eq("2024-01-02", 55), eq("2024-01-03", 60)]; // same daily returns
    const matrix = calculateCorrelationMatrix([
      { name: "A", curve: a },
      { name: "B", curve: b },
    ]);
    expect(matrix[0][1]).toBeCloseTo(1.0, 5);
  });
});
```

**Step 2: テスト失敗確認**

Run: `npx vitest run src/backtest/framework/__tests__/correlation.test.ts -t calculateCorrelationMatrix`
Expected: FAIL

**Step 3: 実装**

`framework/correlation.ts` に追加:

```ts
export interface NamedCurve {
  name: string;
  curve: DailyEquity[];
}

/**
 * N 戦略間の相関行列 (Pearson) を計算。日次リターンベース、共通期間で算出。
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
        // align すると共通日付の equity が揃う、そこから daily return を取り直す必要あり
        const a = [];
        const b = [];
        for (let k = 1; k < aligned.dates.length; k++) {
          a.push(aligned.equityA[k] / aligned.equityA[k - 1] - 1);
          b.push(aligned.equityB[k] / aligned.equityB[k - 1] - 1);
        }
        matrix[i][j] = calculatePearsonCorrelation(a, b);
      } else {
        matrix[i][j] = matrix[j][i]; // symmetric
      }
    }
  }
  return matrix;
}
```

**Step 4: テスト pass + 全テスト + typecheck**

**Step 5: コミット**

```bash
git add src/backtest/framework/correlation.ts src/backtest/framework/__tests__/correlation.test.ts
git commit -m "feat(framework): calculateCorrelationMatrix (N 戦略の相関行列) を TDD 追加"
```

---

## Task 4: TDD - portfolio metrics helper

**Files:**
- Create: `src/backtest/framework/portfolio-metrics.ts`
- Create: `src/backtest/framework/__tests__/portfolio-metrics.test.ts`

**Step 1: 失敗テストを書く**

```ts
import { describe, it, expect } from "vitest";
import { calculateSharpeRatio, calculateAnnualizedReturn } from "../portfolio-metrics";
import type { DailyEquity } from "../../types";

function eq(d: string, v: number): DailyEquity {
  return { date: d, cash: 0, positionsValue: v, totalEquity: v, openPositionCount: 0 };
}

describe("calculateAnnualizedReturn (CAGR)", () => {
  it("returns 0 for unchanged equity", () => {
    const curve = [eq("2024-01-01", 100), eq("2024-12-31", 100)];
    // 252 trading days ~= 1 year, equity unchanged
    expect(calculateAnnualizedReturn(curve, 100)).toBeCloseTo(0, 4);
  });

  it("returns ~10% for 10% return over 1 year", () => {
    const curve: DailyEquity[] = [];
    for (let i = 0; i < 252; i++) {
      curve.push(eq(`2024-D${i}`, 100 + i * 10/252));
    }
    expect(calculateAnnualizedReturn(curve, 100)).toBeCloseTo(0.10, 2);
  });

  it("returns 0 when curve has < 2 points", () => {
    expect(calculateAnnualizedReturn([], 100)).toBe(0);
  });
});

describe("calculateSharpeRatio", () => {
  it("returns positive value for positive trending curve", () => {
    const curve: DailyEquity[] = [];
    for (let i = 0; i < 252; i++) curve.push(eq(`D${i}`, 100 * (1 + 0.0004 * i)));
    const s = calculateSharpeRatio(curve);
    expect(s).toBeGreaterThan(0);
  });

  it("returns 0 for constant equity (zero variance)", () => {
    const curve = Array.from({ length: 100 }, (_, i) => eq(`D${i}`, 100));
    expect(calculateSharpeRatio(curve)).toBe(0);
  });
});
```

**Step 2: テスト失敗 → 実装**

```ts
// src/backtest/framework/portfolio-metrics.ts
import type { DailyEquity } from "../types";
import { dailyReturns } from "./correlation";

export function calculateAnnualizedReturn(curve: DailyEquity[], initialBudget: number): number {
  if (curve.length < 2) return 0;
  const finalEq = curve[curve.length - 1].totalEquity;
  const years = curve.length / 252;
  if (years <= 0) return 0;
  return Math.pow(finalEq / initialBudget, 1 / years) - 1;
}

export function calculateSharpeRatio(curve: DailyEquity[], riskFreeRate = 0): number {
  const returns = dailyReturns(curve);
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  // Annualize: mean * 252 / (std * sqrt(252))
  const dailyRiskFree = riskFreeRate / 252;
  return ((mean - dailyRiskFree) * 252) / (std * Math.sqrt(252));
}
```

**Step 3: pass + commit**

```bash
git add src/backtest/framework/portfolio-metrics.ts src/backtest/framework/__tests__/portfolio-metrics.test.ts
git commit -m "feat(framework): portfolio-metrics (Sharpe / CAGR) を TDD 追加"
```

---

## Task 5: 各 strategy runner を library 化（StrategyResult を返す形に）

**Files:**
- Modify: 各 `src/backtest/{credit-spread,dual-momentum,pead,momentum}/run-tail-test.ts`

**目的:** Phase 4 portfolio analysis runner から各戦略の simulation を呼び、`StrategyResult` を取得できるようにする。各 runner の中の "main" 関数を export して再利用する形にする。

**選択肢:**
- A. 各 runner の `main()` を export し、CLI から呼ぶ薄い wrapper を残す
- B. 別ファイル `<strategy>/strategy.ts` に StrategyResult 生成ロジックを抽出、runner はそれを呼ぶ wrapper になる

**おすすめ B** だが工数が大きい。**Phase 4 では A の最小工数で進める**:

```ts
// 例: credit-spread/run-tail-test.ts
export async function runCreditSpreadStrategy(
  startDate: string,
  endDate: string,
  budget?: number
): Promise<StrategyResult> {
  // 既存 main の simulation 部分（runUSCreditSpreadBacktest 呼び + StrategyResult 構築）を抽出
  // tail-test 部分（DD extraction, report generation）は呼ばない
  // ...
  return strategyResult;
}

async function main() {
  // 既存 CLI ロジック: arg parse → call runCreditSpreadStrategy → tail-test → report
}

main().catch(...);
```

各 4 戦略で同じパターン。

**Step 1**: credit-spread/run-tail-test.ts に `runCreditSpreadStrategy(start, end, budget?)` を export

**Step 2**: dual-momentum/run-tail-test.ts に `runDualMomentumStrategy(start, end, budget?)` を export

**Step 3**: pead/run-tail-test.ts に `runPeadStrategy(start, end, budget?)` を export

**Step 4**: momentum/run-tail-test.ts に `runMomentumStrategy(start, end, budget?)` を export

**Step 5**: 各 smoke (短期 2020-2023) で既存挙動が変わっていないことを確認:
```bash
npm run tail-test:credit-spread -- --start 2020-01-01 --end 2023-12-31 --label phase4-step5-cs
npm run tail-test:dual-momentum -- --start 2020-01-01 --end 2023-12-31
npm run tail-test:pead -- --start 2020-01-01 --end 2023-12-31 --label phase4-step5-pead
npm run tail-test:momentum -- --start 2020-01-01 --end 2023-12-31 --label phase4-step5-mom
```

verdict が変わらないこと確認。

**Step 6: コミット**

```bash
git add src/backtest/credit-spread/run-tail-test.ts src/backtest/dual-momentum/run-tail-test.ts src/backtest/pead/run-tail-test.ts src/backtest/momentum/run-tail-test.ts
git commit -m "refactor(strategies): 各 runner から StrategyResult 生成関数を export

Phase 4 portfolio analysis から各戦略を再利用するため。
既存 CLI 動作は維持。"
```

---

## Task 6: portfolio analysis runner

**Files:**
- Create: `src/backtest/framework/run-portfolio-analysis.ts`

```ts
#!/usr/bin/env tsx
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import type { StrategyResult } from "./strategy-result";
import { calculateCorrelationMatrix, dailyReturns } from "./correlation";
import { combineEquityCurves } from "./portfolio";
import { calculateAnnualizedReturn, calculateSharpeRatio } from "./portfolio-metrics";
import { extractDDPeriods } from "./tail-test/dd-extractor";
import { runCreditSpreadStrategy } from "../credit-spread/run-tail-test";
import { runDualMomentumStrategy } from "../dual-momentum/run-tail-test";
import { runPeadStrategy } from "../pead/run-tail-test";
import { runMomentumStrategy } from "../momentum/run-tail-test";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  // 共通期間: 4 戦略 overlap
  // - credit-spread: 2007-01-03〜
  // - dual-momentum: 2007-01-03〜（rotation ETF 2007 backfill 済）
  // - PEAD: 2015-01-01〜（earnings データ範囲）
  // - momentum: 2015-01-01〜（個別株 universe）
  // → 共通: 2015-01-01〜
  const startDate = getArg("start") ?? "2015-01-01";
  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const budget = getArg("budget") ? Number(getArg("budget")) : 3300;

  console.log(`Phase 4 Portfolio Analysis`);
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Per-strategy budget: $${budget}\n`);

  // 各戦略を並列実行（互いに独立なので Promise.all）
  console.log("Running 4 strategies...");
  const [creditSpread, dualMomentum, pead, momentum] = await Promise.all([
    runCreditSpreadStrategy(startDate, endDate, budget),
    runDualMomentumStrategy(startDate, endDate, budget),
    runPeadStrategy(startDate, endDate, budget),
    runMomentumStrategy(startDate, endDate, budget),
  ]);

  const strategies = [creditSpread, dualMomentum, pead, momentum];
  const names = strategies.map((s) => s.strategyName);

  // 単独メトリクス
  const standalones = strategies.map((s) => ({
    name: s.strategyName,
    cagr: calculateAnnualizedReturn(s.equityCurve, s.initialBudget),
    sharpe: calculateSharpeRatio(s.equityCurve),
    maxDD: s.metrics.maxDrawdown,
  }));

  // 相関行列
  const matrix = calculateCorrelationMatrix(
    strategies.map((s) => ({ name: s.strategyName, curve: s.equityCurve }))
  );

  // 50/50 portfolio (credit-spread + 各 diversifier)
  const portfolios = strategies.slice(1).map((d) => {
    const combined = combineEquityCurves([
      { curve: creditSpread.equityCurve, weight: 0.5, initialBudget: creditSpread.initialBudget },
      { curve: d.equityCurve, weight: 0.5, initialBudget: d.initialBudget },
    ]);
    const portfolioBudget = creditSpread.initialBudget * 0.5 + d.initialBudget * 0.5;
    return {
      name: `credit-spread + ${d.strategyName} (50/50)`,
      curve: combined,
      cagr: calculateAnnualizedReturn(combined, portfolioBudget),
      sharpe: calculateSharpeRatio(combined),
      maxDD: maxDrawdownFromCurve(combined),
    };
  });

  // Markdown レポート出力
  const today = dayjs().format("YYYY-MM-DD");
  const reportDir = path.join(process.cwd(), "docs/reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `portfolio-correlation-matrix-${today}.md`);
  const md = generateReport(names, standalones, matrix, portfolios, startDate, endDate);
  fs.writeFileSync(reportPath, md);

  console.log(`\nReport: ${reportPath}`);

  // ターミナル要約
  console.log(`\n--- Standalone Metrics ---`);
  standalones.forEach((s) => {
    console.log(`  ${s.name}: CAGR=${(s.cagr*100).toFixed(2)}%, Sharpe=${s.sharpe.toFixed(2)}, MaxDD=${(s.maxDD*100).toFixed(2)}%`);
  });
  console.log(`\n--- Correlations vs credit-spread ---`);
  for (let j = 1; j < names.length; j++) {
    console.log(`  ${names[0]} vs ${names[j]}: ${matrix[0][j].toFixed(3)}`);
  }
  console.log(`\n--- 50/50 Portfolios ---`);
  portfolios.forEach((p) => {
    console.log(`  ${p.name}: CAGR=${(p.cagr*100).toFixed(2)}%, Sharpe=${p.sharpe.toFixed(2)}, MaxDD=${(p.maxDD*100).toFixed(2)}%`);
  });
}

function maxDrawdownFromCurve(curve: { totalEquity: number }[]): number {
  let peak = 0, maxDD = 0;
  for (const d of curve) {
    if (d.totalEquity > peak) peak = d.totalEquity;
    const dd = peak > 0 ? (peak - d.totalEquity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function generateReport(
  names: string[],
  standalones: any[],
  matrix: number[][],
  portfolios: any[],
  startDate: string,
  endDate: string
): string {
  // Markdown 文字列を組み立て
  // セクション:
  //   ## 結論 (採用推奨/保留/不採用)
  //   ## 評価期間 + 単独メトリクス表
  //   ## 相関行列 (4x4)
  //   ## 50/50 Portfolio 評価表
  //   ## 判定詳細
  // 結論ロジック:
  //   - 各 portfolio Sharpe > credit-spread Sharpe AND portfolio MaxDD < credit-spread MaxDD: "採用候補"
  //   - 1 つも該当なし: "不採用"
  // ...
  return "...";  // フル実装
}

main().catch((e) => { console.error(e); process.exit(1); });
```

**Step 1**: 上記スケルトンを書く（`generateReport` の実装含む）

**Step 2**: `package.json` に script 追加:
```json
"portfolio-analysis": "tsx src/backtest/framework/run-portfolio-analysis.ts",
```

**Step 3**: 短期 smoke run:
```bash
npm run portfolio-analysis -- --start 2020-01-01 --end 2023-12-31
```

verify: 完走、`docs/reports/portfolio-correlation-matrix-YYYY-MM-DD.md` 生成、4 戦略の数値が既存 reports と一致

**Step 4**: コミット
```bash
git add src/backtest/framework/run-portfolio-analysis.ts package.json
git commit -m "feat(framework): portfolio 相関分析 runner と script を追加"
```

---

## Task 7: 全期間 (2015-) 実行 + レポート生成

**Step 1: 実行**

```bash
npm run portfolio-analysis -- --start 2015-01-01 2>&1 | tee /tmp/portfolio-fullrun.txt
```

期待: 4 戦略並列実行 (~5 分)、レポート生成。

**Step 2: レポート確認**

```bash
cat docs/reports/portfolio-correlation-matrix-2026-XX-XX.md
```

セクション確認:
- 結論 (judgment)
- 単独メトリクス
- 相関行列 4x4
- 50/50 portfolio 評価
- 判定詳細

**Step 3: コミット（report ファイル）**

```bash
git add docs/reports/portfolio-correlation-matrix-*.md
git commit -m "report(portfolio): Phase 4 全期間 portfolio 相関分析レポート"
```

---

## Task 8: design doc 進捗追記 + 最終 smoke

**Step 1: 全テスト + typecheck**

```bash
npm run test && npm run typecheck
```

**Step 2: design doc に Phase 4 完了報告追記**

`docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md` の `## 進捗` セクションに追記:

```markdown
### Phase 4: Portfolio 相関分析 + portfolio 化判断 (KOH-XXX, 2026-XX-XX 完了)

**実装完了内容:**
- src/backtest/framework/portfolio.ts (combineEquityCurves)
- src/backtest/framework/portfolio-metrics.ts (calculateAnnualizedReturn, calculateSharpeRatio)
- src/backtest/framework/correlation.ts に calculateCorrelationMatrix を追加
- src/backtest/framework/run-portfolio-analysis.ts (CLI runner)
- 各 strategy runner から StrategyResult 生成関数を export
- レポート: docs/reports/portfolio-correlation-matrix-YYYY-MM-DD.md

**主要結果（2015-01-01〜YYYY-MM-DD, X 年）:**

[相関行列表 + 50/50 portfolio 評価表 をレポートから抜粋]

**Verdict:** [採用 / 保留 / 不採用]

**次のフェーズへの判断:**
- [ ] [採用の場合] credit-spread + 上位戦略の本番 portfolio 構成案を別 task で定義 (KOH-XXX)
- [ ] [保留の場合] Phase 3 (Tier 2) ライト評価で diversifier 候補を追加検討
- [ ] [不採用の場合] credit-spread 単独本番運用に進む (KOH-459 input)
```

**Step 3: コミット**

```bash
git add docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md
git commit -m "docs(portfolio): Phase 4 (相関分析 + portfolio 判定) 完了報告を design doc に追記"
```

---

## Phase 4 完了確認チェックリスト

- [ ] `framework/portfolio.ts` + tests
- [ ] `framework/portfolio-metrics.ts` + tests
- [ ] `framework/correlation.ts` に `calculateCorrelationMatrix` 追加
- [ ] 各 strategy runner から StrategyResult 生成関数 export 済
- [ ] `framework/run-portfolio-analysis.ts` 動作
- [ ] `docs/reports/portfolio-correlation-matrix-YYYY-MM-DD.md` 生成
- [ ] 結論 (採用 / 保留 / 不採用) 明記
- [ ] 全 vitest tests PASS、typecheck 0 errors
- [ ] KOH-451 evidence + Phase 0/2-A/2-B unlabeled reports 保護維持

## YAGNI（Phase 4 で採用しないもの）

- Risk Parity / MVO 最適化（等資金 + 50/50 で十分初動判断可）
- 70/30 や 30/70 の検討（50/50 で diversifier 価値が無いなら他比率も同じ結論）
- rolling 相関分析（全期間相関で十分、tail event 別の相関上振れは worst window で見る）
- 3 戦略以上の portfolio (4 戦略全乗せ等)（YAGNI、まず 50/50 で判断）
- HTML / interactive 出力
- Phase 3 cleanup の前倒し（M1-M5 cross-cutting issues は別タスクで処理）
