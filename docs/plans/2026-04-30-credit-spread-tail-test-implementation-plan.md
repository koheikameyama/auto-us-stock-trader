# SPY Credit Spread テール耐性検証 実装プラン (Phase 3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 2007〜現在の SPY Credit Spread をフル期間 backtest し、equity curve から DD 上位を自動抽出 + 9 つの事前定義ストレスイベントごとに勝率/PnL/DD を集計。7 つの閾値で PASS/FAIL を判定し、Markdown レポート + CSV を `docs/reports/` に出力する。

**Architecture:** `src/backtest/tail-test/` 配下に純関数モジュールを配置（dd-extractor, window-analyzer, tail-metrics, pass-fail, report）。エントリーポイント `run-credit-spread-tail-test.ts` が既存 `runUSCreditSpreadBacktest` を呼び出し、結果を tail-test 群でポストプロセス → Markdown 出力。新規モジュールは TDD で書く。

**Tech Stack:** TypeScript, vitest, dayjs, tsx

**前提:**
- KOH-447 (Phase 1: 移管) 完了
- KOH-448 (Phase 2: 2007〜backfill) 完了 (^GSPC/^VIX が 4860 日分)
- vitest 導入済 (`npm test`, `npm run test:watch`)
- 既存: `src/backtest/us/us-credit-spread-{config,run,simulation,types}.ts`, `data-fetcher.ts`, `metrics.ts`, `types.ts`

**設計参照:** `docs/plans/2026-04-28-credit-spread-tail-test-design.md` (Section: Phase 3, Section 5/6)

---

## ロールバック方法

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
git status
# 全変更を破棄して開始前に戻す
git checkout -- .
rm -rf src/backtest/tail-test docs/reports
git restore --staged .
# 既コミット済みなら git revert <SHA>
```

---

## Task 1: tail-test ディレクトリ作成 + types

**Files:**
- Create: `src/backtest/tail-test/types.ts`

**Step 1: ディレクトリ作成**

```bash
mkdir -p src/backtest/tail-test/__tests__
```

**Step 2: types.ts を作成**

```typescript
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
```

**Step 3: 検証**

Run: `npm run typecheck`
Expected: エラーなし

**Step 4: コミット**

```bash
git add src/backtest/tail-test/types.ts
git commit -m "feat(tail-test): 型定義を追加"
```

---

## Task 2: stress-windows.ts (定数のみ、テスト不要)

**Files:**
- Create: `src/backtest/tail-test/stress-windows.ts`

**Step 1: 実装**

```typescript
// src/backtest/tail-test/stress-windows.ts
import type { StressWindow } from "./types";

export const STRESS_WINDOWS: readonly StressWindow[] = [
  { name: "Lehman / 2008 GFC",          start: "2008-09-01", end: "2009-03-31" },
  { name: "Flash Crash",                 start: "2010-05-01", end: "2010-05-31" },
  { name: "EU Debt Crisis",              start: "2011-08-01", end: "2011-10-31" },
  { name: "China Black Monday",          start: "2015-08-15", end: "2015-09-30" },
  { name: "Volmageddon",                 start: "2018-02-01", end: "2018-02-28" },
  { name: "Q4 2018 Selloff",             start: "2018-10-01", end: "2018-12-31" },
  { name: "COVID-19",                    start: "2020-02-15", end: "2020-04-30" },
  { name: "2022 Bear",                   start: "2022-01-01", end: "2022-10-31" },
  { name: "Aug 2024 Yen Carry Unwind",   start: "2024-08-01", end: "2024-08-15" },
] as const;
```

**Step 2: 検証**

Run: `npm run typecheck`
Expected: エラーなし

**Step 3: コミット**

```bash
git add src/backtest/tail-test/stress-windows.ts
git commit -m "feat(tail-test): 9 つの事前定義ストレス期間を追加"
```

---

## Task 3: dd-extractor.ts (TDD)

**Files:**
- Create: `src/backtest/tail-test/__tests__/dd-extractor.test.ts`
- Create: `src/backtest/tail-test/dd-extractor.ts`

**Step 1: failing テストを書く**

```typescript
// src/backtest/tail-test/__tests__/dd-extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractDDPeriods } from "../dd-extractor";
import type { DailyEquity } from "../../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: totalEquity, positionsValue: 0, totalEquity, openPositionCount: 0 };
}

describe("extractDDPeriods", () => {
  it("returns empty array for monotonically increasing equity", () => {
    const curve = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    expect(extractDDPeriods(curve, 5)).toEqual([]);
  });

  it("identifies a single DD period: peak -> trough -> recovery", () => {
    const curve = [
      eq("2024-01-01", 100),
      eq("2024-01-02", 120), // peak
      eq("2024-01-03", 110),
      eq("2024-01-04", 90),  // trough
      eq("2024-01-05", 100),
      eq("2024-01-06", 120), // recovery (back to peak)
    ];
    const result = extractDDPeriods(curve, 5);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      peakDate: "2024-01-02",
      troughDate: "2024-01-04",
      recoveryDate: "2024-01-06",
      ddPct: 0.25,           // (120-90)/120
      ddDollar: 30,
    });
  });

  it("returns null recoveryDate if not recovered by end", () => {
    const curve = [
      eq("2024-01-01", 100),
      eq("2024-01-02", 120), // peak
      eq("2024-01-03", 80),  // trough
      eq("2024-01-04", 90),  // not recovered
    ];
    const result = extractDDPeriods(curve, 5);
    expect(result).toHaveLength(1);
    expect(result[0].recoveryDate).toBeNull();
  });

  it("ranks multiple DDs by ddPct descending and limits to topN", () => {
    const curve = [
      eq("2024-01-01", 100),
      eq("2024-01-02", 90),  // small dd 10%
      eq("2024-01-03", 100), // recover
      eq("2024-01-04", 110), // peak
      eq("2024-01-05", 80),  // big dd ~27%
      eq("2024-01-06", 110), // recover
      eq("2024-01-07", 120), // peak
      eq("2024-01-08", 100), // medium dd ~17%
      eq("2024-01-09", 120), // recover
    ];
    const top2 = extractDDPeriods(curve, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0].ddPct).toBeGreaterThan(top2[1].ddPct); // sorted desc
    expect(top2[0].ddPct).toBeCloseTo(0.2727, 3);
  });
});
```

**Step 2: テスト実行（失敗確認）**

Run: `npm test -- src/backtest/tail-test/__tests__/dd-extractor.test.ts`
Expected: FAIL（モジュール未実装）

**Step 3: 実装**

```typescript
// src/backtest/tail-test/dd-extractor.ts
import type { DailyEquity } from "../types";
import type { DDPeriod } from "./types";

/**
 * equity curve から running max を追跡して連続 DD 期間を識別、
 * ddPct 降順で上位 topN を返却。matchedEvent は別途タグ付け（window-analyzer）。
 *
 * 各 DD 期間は: peak (running max が更新された日) → trough (running max からの最大乖離日)
 *               → recovery (totalEquity が peakEquity に戻った最初の日、または null)
 */
export function extractDDPeriods(
  equityCurve: DailyEquity[],
  topN: number,
): DDPeriod[] {
  if (equityCurve.length === 0) return [];

  const periods: DDPeriod[] = [];
  let peakEquity = equityCurve[0].totalEquity;
  let peakDate = equityCurve[0].date;
  let inDD = false;
  let troughEquity = peakEquity;
  let troughDate = peakDate;

  for (let i = 1; i < equityCurve.length; i++) {
    const { date, totalEquity } = equityCurve[i];

    if (totalEquity >= peakEquity) {
      // 新ピーク or 復元
      if (inDD) {
        // recovery
        periods.push({
          peakDate,
          troughDate,
          recoveryDate: date,
          peakEquity,
          troughEquity,
          ddPct: (peakEquity - troughEquity) / peakEquity,
          ddDollar: peakEquity - troughEquity,
          durationDays: dateDiff(peakDate, troughDate),
          matchedEvent: null,
          tradesInPeriod: [],
        });
        inDD = false;
      }
      peakEquity = totalEquity;
      peakDate = date;
      troughEquity = totalEquity;
      troughDate = date;
    } else {
      // DD 中
      inDD = true;
      if (totalEquity < troughEquity) {
        troughEquity = totalEquity;
        troughDate = date;
      }
    }
  }

  // ループ終了時に DD 中なら未復元として push
  if (inDD) {
    periods.push({
      peakDate,
      troughDate,
      recoveryDate: null,
      peakEquity,
      troughEquity,
      ddPct: (peakEquity - troughEquity) / peakEquity,
      ddDollar: peakEquity - troughEquity,
      durationDays: dateDiff(peakDate, troughDate),
      matchedEvent: null,
      tradesInPeriod: [],
    });
  }

  return periods.sort((a, b) => b.ddPct - a.ddPct).slice(0, topN);
}

function dateDiff(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}
```

**Step 4: テスト実行（成功確認）**

Run: `npm test -- src/backtest/tail-test/__tests__/dd-extractor.test.ts`
Expected: 4/4 PASS

**Step 5: コミット**

```bash
git add src/backtest/tail-test/dd-extractor.ts src/backtest/tail-test/__tests__/dd-extractor.test.ts
git commit -m "feat(tail-test): DD 期間抽出を TDD で実装"
```

---

## Task 4: window-analyzer.ts (TDD)

**Files:**
- Create: `src/backtest/tail-test/__tests__/window-analyzer.test.ts`
- Create: `src/backtest/tail-test/window-analyzer.ts`

**Step 1: failing テスト**

```typescript
// __tests__/window-analyzer.test.ts
import { describe, it, expect } from "vitest";
import { analyzeWindow, tagDDsWithEvents } from "../window-analyzer";
import type { DailyEquity } from "../../types";
import type { SimulatedSpread } from "../../us/us-credit-spread-types";
import type { DDPeriod, StressWindow } from "../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: totalEquity, positionsValue: 0, totalEquity, openPositionCount: 0 };
}

describe("analyzeWindow", () => {
  const curve: DailyEquity[] = [
    eq("2020-01-31", 100),
    eq("2020-02-28", 90),
    eq("2020-03-23", 70),
    eq("2020-04-30", 95),
  ];
  const window: StressWindow = { name: "COVID-19", start: "2020-02-15", end: "2020-04-30" };

  it("calculates pnl, ddPct, etc. for given window", () => {
    const spreads: SimulatedSpread[] = [];
    const r = analyzeWindow(window, curve, spreads);
    expect(r.dataAvailable).toBe(true);
    expect(r.startEquity).toBe(90); // 2020-02-28 (first day in window)
    expect(r.endEquity).toBe(95);
    expect(r.pnl).toBe(5);
    expect(r.ddPct).toBeCloseTo((90 - 70) / 90, 3); // 22.2%
  });

  it("returns dataAvailable=false when window outside curve range", () => {
    const r = analyzeWindow(
      { name: "Old", start: "2007-01-01", end: "2007-12-31" },
      curve,
      [],
    );
    expect(r.dataAvailable).toBe(false);
  });
});

describe("tagDDsWithEvents", () => {
  it("tags a DD period if peak or trough overlaps a stress window", () => {
    const dds: DDPeriod[] = [{
      peakDate: "2020-02-19",
      troughDate: "2020-03-23",
      recoveryDate: "2020-06-08",
      peakEquity: 100, troughEquity: 70, ddPct: 0.3, ddDollar: 30, durationDays: 33,
      matchedEvent: null, tradesInPeriod: [],
    }];
    const tagged = tagDDsWithEvents(dds, [
      { name: "COVID-19", start: "2020-02-15", end: "2020-04-30" },
    ]);
    expect(tagged[0].matchedEvent).toBe("COVID-19");
  });

  it("returns null matchedEvent when no overlap", () => {
    const dds: DDPeriod[] = [{
      peakDate: "2024-01-01", troughDate: "2024-01-15", recoveryDate: "2024-02-01",
      peakEquity: 100, troughEquity: 90, ddPct: 0.1, ddDollar: 10, durationDays: 14,
      matchedEvent: null, tradesInPeriod: [],
    }];
    const tagged = tagDDsWithEvents(dds, [{ name: "X", start: "2020-01-01", end: "2020-12-31" }]);
    expect(tagged[0].matchedEvent).toBeNull();
  });
});
```

**Step 2: テスト失敗確認 → 実装**

```typescript
// window-analyzer.ts
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
```

**Step 3: テスト成功確認 → コミット**

```bash
npm test -- window-analyzer
git add src/backtest/tail-test/window-analyzer.ts src/backtest/tail-test/__tests__/window-analyzer.test.ts
git commit -m "feat(tail-test): window 分析と DD-event タグ付けを TDD で実装"
```

---

## Task 5: tail-metrics.ts (TDD)

**Files:**
- Create: `src/backtest/tail-test/__tests__/tail-metrics.test.ts`
- Create: `src/backtest/tail-test/tail-metrics.ts`

**Step 1: failing テスト**

```typescript
// __tests__/tail-metrics.test.ts
import { describe, it, expect } from "vitest";
import { calculateTailMetrics, calculateVixBuckets } from "../tail-metrics";
import type { SimulatedSpread } from "../../us/us-credit-spread-types";
import type { DailyEquity } from "../../types";

function spread(p: Partial<SimulatedSpread> & { netPnl: number }): SimulatedSpread {
  return {
    underlyingSymbol: "SPY",
    entryDate: "2024-01-01",
    expirationDate: "2024-02-01",
    entrySpotPrice: 470,
    entryIV: 0.15,
    shortStrike: 450,
    longStrike: 445,
    shortDeltaAtEntry: -0.2,
    creditReceived: 0.85,
    contracts: 1,
    state: "CLOSED",
    closeDate: "2024-01-20",
    closeReason: "profit_target",
    closeSpreadPrice: 0.4,
    netPnl: p.netPnl,
    totalCommissions: 2.6,
    ...p,
  } as SimulatedSpread;
}

describe("calculateTailMetrics", () => {
  it("computes cvar5 as average of worst 5% trades", () => {
    const spreads: SimulatedSpread[] = [
      spread({ netPnl: -500 }),
      spread({ netPnl: -400 }),
      ...Array.from({ length: 18 }, (_, i) => spread({ netPnl: 50 + i })),
    ];
    // 20 trades, worst 5% = 1 trade => cvar5 = -500
    const m = calculateTailMetrics(spreads, []);
    expect(m.cvar5).toBe(-500);
    expect(m.worstSpread?.netPnl).toBe(-500);
  });

  it("computes consecutiveLossCount", () => {
    const spreads: SimulatedSpread[] = [
      spread({ netPnl: 50, closeDate: "2024-01-10" }),
      spread({ netPnl: -30, closeDate: "2024-01-15" }),
      spread({ netPnl: -40, closeDate: "2024-01-20" }),
      spread({ netPnl: -20, closeDate: "2024-01-25" }), // 連敗ピーク 3
      spread({ netPnl: 100, closeDate: "2024-02-01" }),
      spread({ netPnl: -10, closeDate: "2024-02-05" }),
    ];
    const m = calculateTailMetrics(spreads, []);
    expect(m.consecutiveLossCount).toBe(3);
  });
});

describe("calculateVixBuckets", () => {
  it("buckets trading days by VIX level", () => {
    const tradingDays = ["2024-01-01", "2024-01-02", "2024-01-03"];
    const vix = new Map([
      ["2024-01-01", 12],   // ≤20
      ["2024-01-02", 25],   // 20-30
      ["2024-01-03", 35],   // >30
    ]);
    const result = calculateVixBuckets(tradingDays, vix, []);
    expect(result.find((b) => b.label === "≤20")?.tradingDays).toBe(1);
    expect(result.find((b) => b.label === "20-30")?.tradingDays).toBe(1);
    expect(result.find((b) => b.label === ">30")?.tradingDays).toBe(1);
  });
});
```

**Step 2: 実装**

```typescript
// tail-metrics.ts
import type { DailyEquity } from "../types";
import type { SimulatedSpread } from "../us/us-credit-spread-types";
import type { TailMetrics, VixBucket } from "./types";

export function calculateTailMetrics(
  spreads: SimulatedSpread[],
  equityCurve: DailyEquity[],
): TailMetrics {
  const closed = spreads.filter((s) => s.state === "CLOSED" && s.netPnl != null);
  if (closed.length === 0) {
    return { cvar5: 0, cvar1: 0, worstSpread: null, worstDay: null, consecutiveLossCount: 0 };
  }
  const sorted = [...closed].sort((a, b) => (a.netPnl ?? 0) - (b.netPnl ?? 0));
  const cvar5Count = Math.max(1, Math.floor(closed.length * 0.05));
  const cvar1Count = Math.max(1, Math.floor(closed.length * 0.01));
  const cvar5 = avg(sorted.slice(0, cvar5Count).map((s) => s.netPnl!));
  const cvar1 = avg(sorted.slice(0, cvar1Count).map((s) => s.netPnl!));

  // 連敗
  const byCloseDate = closed
    .filter((s) => s.closeDate != null)
    .sort((a, b) => (a.closeDate! < b.closeDate! ? -1 : 1));
  let cur = 0, max = 0;
  for (const s of byCloseDate) {
    if ((s.netPnl ?? 0) < 0) {
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

  return { cvar5, cvar1, worstSpread: sorted[0], worstDay, consecutiveLossCount: max };
}

export function calculateVixBuckets(
  tradingDays: string[],
  vixMap: Map<string, number>,
  spreads: SimulatedSpread[],
): VixBucket[] {
  const buckets: VixBucket[] = [
    { label: ">30",   tradingDays: 0, spreadCount: 0, winRate: 0, pnlPerSpread: 0 },
    { label: "20-30", tradingDays: 0, spreadCount: 0, winRate: 0, pnlPerSpread: 0 },
    { label: "≤20",   tradingDays: 0, spreadCount: 0, winRate: 0, pnlPerSpread: 0 },
  ];
  const counters = buckets.map(() => ({ wins: 0, count: 0, totalPnl: 0 }));

  for (const day of tradingDays) {
    const v = vixMap.get(day);
    if (v == null) continue;
    const idx = v > 30 ? 0 : v > 20 ? 1 : 2;
    buckets[idx].tradingDays += 1;
  }
  for (const s of spreads) {
    const v = vixMap.get(s.entryDate);
    if (v == null) continue;
    const idx = v > 30 ? 0 : v > 20 ? 1 : 2;
    counters[idx].count += 1;
    if ((s.netPnl ?? 0) > 0) counters[idx].wins += 1;
    counters[idx].totalPnl += s.netPnl ?? 0;
  }
  for (let i = 0; i < buckets.length; i++) {
    buckets[i].spreadCount = counters[i].count;
    buckets[i].winRate = counters[i].count === 0 ? 0 : counters[i].wins / counters[i].count;
    buckets[i].pnlPerSpread = counters[i].count === 0 ? 0 : counters[i].totalPnl / counters[i].count;
  }
  return buckets;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
```

**Step 3: テスト/コミット**

```bash
npm test -- tail-metrics
git add src/backtest/tail-test/tail-metrics.ts src/backtest/tail-test/__tests__/tail-metrics.test.ts
git commit -m "feat(tail-test): CVaR / 連敗 / VIX バケットを TDD で実装"
```

---

## Task 6: pass-fail.ts (TDD)

**Files:**
- Create: `src/backtest/tail-test/__tests__/pass-fail.test.ts`
- Create: `src/backtest/tail-test/pass-fail.ts`

**Step 1: failing テスト**

```typescript
// __tests__/pass-fail.test.ts
import { describe, it, expect } from "vitest";
import { evaluateThresholds, DEFAULT_THRESHOLDS } from "../pass-fail";
import type { DDPeriod, WindowAnalysis, TailMetrics } from "../types";

describe("evaluateThresholds", () => {
  it("PASS when all metrics meet thresholds", () => {
    const verdict = evaluateThresholds({
      winRate: 0.75,
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: 0.25,
      worstWindowPnlPct: -0.30,
      maxLossDollar: 500,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(verdict.overallPass).toBe(true);
    expect(verdict.checks.every((c) => c.pass !== false)).toBe(true);
  });

  it("FAIL when winRate < 70%", () => {
    const verdict = evaluateThresholds({
      winRate: 0.65,
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: 0.25,
      worstWindowPnlPct: -0.30,
      maxLossDollar: 500,
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(verdict.overallPass).toBe(false);
    const winRateCheck = verdict.checks.find((c) => c.name === "Win Rate");
    expect(winRateCheck?.pass).toBe(false);
  });

  it("skips check when actual is null (data unavailable)", () => {
    const verdict = evaluateThresholds({
      winRate: 0.75,
      profitFactor: 1.5,
      cagr: 0.12,
      maxDrawdown: 0.20,
      cvar5: -200,
      worstWindowDD: null,    // 全 window 全部 dataAvailable=false
      worstWindowPnlPct: null,
      maxLossDollar: 500,
      thresholds: DEFAULT_THRESHOLDS,
    });
    const tailDDCheck = verdict.checks.find((c) => c.name.includes("テール期間 DD"));
    expect(tailDDCheck?.pass).toBeNull();
    expect(verdict.overallPass).toBe(true); // null はカウントしない
  });
});
```

**Step 2: 実装**

```typescript
// pass-fail.ts
import type { ThresholdCheck, PassFailVerdict } from "./types";

export interface DefaultThresholds {
  winRateMin: number;
  profitFactorMin: number;
  cagrMin: number;
  maxDrawdownMax: number;
  cvar5MinRatio: number;        // -(maxLoss * cvar5MinRatio)
  worstWindowDDMax: number;
  worstWindowPnlPctMin: number;
}

export const DEFAULT_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.70,
  profitFactorMin: 1.30,
  cagrMin: 0.10,
  maxDrawdownMax: 0.25,
  cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.30,
  worstWindowPnlPctMin: -0.50,
};

export interface ThresholdInputs {
  winRate: number;
  profitFactor: number;
  cagr: number;
  maxDrawdown: number;
  cvar5: number | null;
  worstWindowDD: number | null;       // 全 window 中の最大 DD
  worstWindowPnlPct: number | null;   // 全 window 中の最悪 PnL%
  maxLossDollar: number;              // 1 spread の最大損失（spread width × 100 × contracts）
  thresholds: DefaultThresholds;
}

export function evaluateThresholds(inputs: ThresholdInputs): PassFailVerdict {
  const t = inputs.thresholds;
  const checks: ThresholdCheck[] = [
    check("Win Rate", "平時", inputs.winRate, t.winRateMin, "≥", inputs.winRate >= t.winRateMin),
    check("Profit Factor", "平時", inputs.profitFactor, t.profitFactorMin, "≥", inputs.profitFactor >= t.profitFactorMin),
    check("CAGR", "平時", inputs.cagr, t.cagrMin, "≥", inputs.cagr >= t.cagrMin),
    check("Max DD", "平時", inputs.maxDrawdown, t.maxDrawdownMax, "≤", inputs.maxDrawdown <= t.maxDrawdownMax),
    check(
      "CVaR 5%",
      "テール",
      inputs.cvar5,
      -(inputs.maxLossDollar * t.cvar5MinRatio),
      "≥",
      inputs.cvar5 == null ? null : inputs.cvar5 >= -(inputs.maxLossDollar * t.cvar5MinRatio),
    ),
    check(
      "テール期間 DD（最悪）",
      "テール",
      inputs.worstWindowDD,
      t.worstWindowDDMax,
      "≤",
      inputs.worstWindowDD == null ? null : inputs.worstWindowDD <= t.worstWindowDDMax,
    ),
    check(
      "テール期間 PnL%（最悪）",
      "テール",
      inputs.worstWindowPnlPct,
      t.worstWindowPnlPctMin,
      "≥",
      inputs.worstWindowPnlPct == null ? null : inputs.worstWindowPnlPct >= t.worstWindowPnlPctMin,
    ),
  ];

  const evaluated = checks.filter((c) => c.pass !== null);
  const passed = evaluated.filter((c) => c.pass).length;
  const failed = evaluated.filter((c) => !c.pass).length;
  const overallPass = failed === 0;

  return {
    overallPass,
    checks,
    summary: overallPass
      ? `PASS: ${passed}/${evaluated.length} checks (skipped ${checks.length - evaluated.length})`
      : `FAIL: ${passed}/${evaluated.length} checks (skipped ${checks.length - evaluated.length})`,
  };
}

function check(
  name: string, category: "平時" | "テール",
  actual: number | null, threshold: number,
  _op: "≥" | "≤", pass: boolean | null,
): ThresholdCheck {
  return { name, category, actual, threshold, pass };
}
```

**Step 3: テスト/コミット**

```bash
npm test -- pass-fail
git add src/backtest/tail-test/pass-fail.ts src/backtest/tail-test/__tests__/pass-fail.test.ts
git commit -m "feat(tail-test): 7 つの閾値判定 (PASS/FAIL) を TDD で実装"
```

---

## Task 7: report.ts (Markdown レポート生成)

**Files:**
- Create: `src/backtest/tail-test/report.ts`
- Create: `src/backtest/tail-test/__tests__/report.test.ts`（軽め: 結合テストで雰囲気のみ）

**Step 1: 軽量テスト**

```typescript
// __tests__/report.test.ts
import { describe, it, expect } from "vitest";
import { generateMarkdownReport } from "../report";

describe("generateMarkdownReport", () => {
  it("includes verdict and key sections", () => {
    const md = generateMarkdownReport({
      configSummary: { underlyingSymbol: "SPY", shortPutDelta: 0.20 },
      startDate: "2007-01-03",
      endDate: "2026-04-28",
      totalSpreads: 412,
      baseMetrics: { winRate: 0.75, profitFactor: 1.42, cagr: 0.112, maxDrawdown: 0.221, netReturnPct: 0.96 },
      ddRanking: [],
      stressWindows: [],
      tailMetrics: { cvar5: -240, cvar1: -480, worstSpread: null, worstDay: null, consecutiveLossCount: 4 },
      vixBuckets: [],
      verdict: {
        overallPass: true,
        summary: "PASS: 7/7 checks",
        checks: [
          { name: "Win Rate", category: "平時", actual: 0.75, threshold: 0.70, pass: true },
        ],
      },
      equityCurve: [],
      closedSpreads: [],
    });
    expect(md).toContain("# SPY Credit Spread");
    expect(md).toContain("PASS");
    expect(md).toContain("Win Rate");
  });
});
```

**Step 2: 実装（簡潔さ重視、設計書 Section 6 のテンプレに沿って）**

```typescript
// report.ts
import type { TailTestResult } from "./types";

export function generateMarkdownReport(result: TailTestResult): string {
  const m = result.baseMetrics;
  const v = result.verdict;
  const lines: string[] = [];

  lines.push(`# SPY Credit Spread テール耐性検証レポート — ${todayString()}`);
  lines.push("");
  lines.push("## 結論");
  lines.push(v.overallPass ? `✅ **PASS**（${v.summary}）` : `❌ **FAIL**（${v.summary}）`);
  lines.push("");
  lines.push(`実取引推奨: ${v.overallPass ? "YES" : "NO"}`);
  lines.push("");
  lines.push("## 設定");
  for (const [k, v2] of Object.entries(result.configSummary)) {
    lines.push(`- ${k}: ${v2}`);
  }
  lines.push(`- 期間: ${result.startDate} 〜 ${result.endDate}`);
  lines.push(`- 総 spread 数: ${result.totalSpreads}`);
  lines.push("");
  lines.push("## 平時メトリクス");
  lines.push("| 指標 | 値 |");
  lines.push("|---|---|");
  lines.push(`| Win Rate | ${pct(m.winRate)} |`);
  lines.push(`| Profit Factor | ${m.profitFactor.toFixed(2)} |`);
  lines.push(`| CAGR | ${pct(m.cagr)} |`);
  lines.push(`| Max DD | ${pct(m.maxDrawdown)} |`);
  lines.push(`| Net Return | ${pct(m.netReturnPct)} |`);
  lines.push("");
  lines.push("## テールメトリクス");
  lines.push("| 指標 | 値 |");
  lines.push("|---|---|");
  lines.push(`| CVaR 5% | ${dollar(result.tailMetrics.cvar5)} |`);
  lines.push(`| CVaR 1% | ${dollar(result.tailMetrics.cvar1)} |`);
  lines.push(`| 最悪 spread | ${result.tailMetrics.worstSpread ? dollar(result.tailMetrics.worstSpread.netPnl ?? 0) : "-"} |`);
  lines.push(`| 最大連敗 | ${result.tailMetrics.consecutiveLossCount} |`);
  lines.push("");
  lines.push("## 判定");
  lines.push("| # | 指標 | 実測値 | 閾値 | 判定 |");
  lines.push("|---|---|---|---|---|");
  v.checks.forEach((c, i) => {
    const status = c.pass === true ? "✅" : c.pass === false ? "❌" : "⏭ skip";
    lines.push(`| ${i + 1} | ${c.name} | ${c.actual ?? "-"} | ${c.threshold} | ${status} |`);
  });
  lines.push("");
  lines.push("## DD 上位");
  lines.push("| Rank | Peak | Trough | Recovery | DD% | DD$ | 期間(日) | 一致イベント |");
  lines.push("|---|---|---|---|---|---|---|---|");
  result.ddRanking.forEach((d, i) => {
    lines.push(`| ${i + 1} | ${d.peakDate} | ${d.troughDate} | ${d.recoveryDate ?? "未復元"} | ${pct(d.ddPct)} | ${dollar(d.ddDollar)} | ${d.durationDays} | ${d.matchedEvent ?? "-"} |`);
  });
  lines.push("");
  lines.push("## 事前定義イベント");
  lines.push("| イベント | 期間 | spread | 勝率 | PnL | DD |");
  lines.push("|---|---|---|---|---|---|");
  for (const w of result.stressWindows) {
    if (!w.dataAvailable) {
      lines.push(`| ${w.window.name} | ${w.window.start} 〜 ${w.window.end} | (データなし) | - | - | - |`);
    } else {
      lines.push(`| ${w.window.name} | ${w.window.start} 〜 ${w.window.end} | ${w.spreadCount} | ${pct(w.winRate)} | ${dollar(w.totalPnl)} | ${pct(w.ddPct)} |`);
    }
  }
  lines.push("");
  lines.push("## VIX レジーム");
  lines.push("| Bucket | 取引日数 | spread | 勝率 | PnL/spread |");
  lines.push("|---|---|---|---|---|");
  for (const b of result.vixBuckets) {
    lines.push(`| ${b.label} | ${b.tradingDays} | ${b.spreadCount} | ${pct(b.winRate)} | ${dollar(b.pnlPerSpread)} |`);
  }
  lines.push("");
  lines.push("## 詳細");
  lines.push("- equity-curve.csv: 同階層に出力（date, cash, totalEquity）");
  lines.push("- spreads.csv: 同階層に出力（各 spread の明細）");
  return lines.join("\n");
}

function pct(x: number): string { return `${(x * 100).toFixed(2)}%`; }
function dollar(x: number): string { return `$${x.toFixed(2)}`; }
function todayString(): string { return new Date().toISOString().slice(0, 10); }
```

**Step 3: テスト/コミット**

```bash
npm test -- report
git add src/backtest/tail-test/report.ts src/backtest/tail-test/__tests__/report.test.ts
git commit -m "feat(tail-test): Markdown レポート生成"
```

---

## Task 8: run-credit-spread-tail-test.ts (エントリーポイント)

**Files:**
- Create: `src/backtest/tail-test/run-credit-spread-tail-test.ts`

**Step 1: 実装**

```typescript
// run-credit-spread-tail-test.ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_CREDIT_SPREAD_DEFAULTS } from "../us/us-credit-spread-config";
import { runUSCreditSpreadBacktest } from "../us/us-credit-spread-simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "../us/us-data-fetcher";
import type { USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";
import { extractDDPeriods } from "./dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "./window-analyzer";
import { calculateTailMetrics, calculateVixBuckets } from "./tail-metrics";
import { evaluateThresholds, DEFAULT_THRESHOLDS } from "./pass-fail";
import { generateMarkdownReport } from "./report";
import { STRESS_WINDOWS } from "./stress-windows";
import type { TailTestResult } from "./types";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const startDate = getArg("start") ?? "2007-01-03";
  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");

  const config: USCreditSpreadBacktestConfig = {
    ...US_CREDIT_SPREAD_DEFAULTS,
    startDate,
    endDate,
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("SPY Credit Spread Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);

  console.log("\nLoading data...");
  const gspc = await fetchSP500FromDB(startDate, endDate);
  const vix = await fetchVixFromDB(startDate, endDate);
  console.log(`  ^GSPC: ${gspc.size} days | VIX: ${vix.size} days`);

  console.log("\nRunning simulation...");
  const result = await runUSCreditSpreadBacktest(config, gspc, vix);

  // ── 後処理 ──
  const closed = result.spreads.filter((s) => s.state === "CLOSED");
  const ddPeriods = extractDDPeriods(result.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) => analyzeWindow(w, result.equityCurve, closed));
  const tailMetrics = calculateTailMetrics(result.spreads, result.equityCurve);
  const tradingDays = result.equityCurve.map((e) => e.date);
  const vixBuckets = calculateVixBuckets(tradingDays, vix, closed);

  // CAGR
  const initial = config.initialBudget;
  const finalEq = result.equityCurve[result.equityCurve.length - 1]?.totalEquity ?? initial;
  const years = result.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;

  // 全 stress window の最悪 DD / PnL%
  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD = available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct = available.length === 0 ? null : Math.min(...available.map((w) => w.pnlPct));

  const verdict = evaluateThresholds({
    winRate: result.metrics.winRate / 100,           // metrics.winRate は % なので比率に
    profitFactor: result.metrics.profitFactor,
    cagr,
    maxDrawdown: result.metrics.maxDrawdown / 100,    // 同上
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    maxLossDollar: config.spreadWidth * 100 * config.contractsPerSpread,
    thresholds: DEFAULT_THRESHOLDS,
  });

  const tailResult: TailTestResult = {
    configSummary: {
      underlyingSymbol: config.underlyingSymbol,
      shortPutDelta: config.shortPutDelta,
      spreadWidth: config.spreadWidth,
      dte: config.dte,
      profitTarget: config.profitTarget,
      vixCap: config.vixCap,
      indexTrendSmaPeriod: config.indexTrendSmaPeriod,
      initialBudget: config.initialBudget,
    },
    startDate,
    endDate,
    totalSpreads: result.metrics.totalSpreads,
    baseMetrics: {
      winRate: result.metrics.winRate / 100,
      profitFactor: result.metrics.profitFactor,
      cagr,
      maxDrawdown: result.metrics.maxDrawdown / 100,
      netReturnPct: result.metrics.netReturnPct / 100,
    },
    ddRanking: taggedDDs,
    stressWindows: stressAnalyses,
    tailMetrics,
    vixBuckets,
    verdict,
    equityCurve: result.equityCurve,
    closedSpreads: closed,
  };

  // ── 出力 ──
  const outDir = path.resolve("docs/reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = dayjs().format("YYYY-MM-DD");
  const reportPath = path.join(outDir, `credit-spread-tail-${today}.md`);
  fs.writeFileSync(reportPath, generateMarkdownReport(tailResult), "utf-8");

  // CSV
  fs.writeFileSync(
    path.join(outDir, `equity-curve-${today}.csv`),
    "date,cash,positionsValue,totalEquity,openPositionCount\n" +
      result.equityCurve.map((e) => `${e.date},${e.cash},${e.positionsValue},${e.totalEquity},${e.openPositionCount}`).join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, `spreads-${today}.csv`),
    "entryDate,closeDate,shortStrike,longStrike,credit,closeReason,netPnl\n" +
      closed.map((s) => `${s.entryDate},${s.closeDate ?? ""},${s.shortStrike},${s.longStrike},${s.creditReceived.toFixed(4)},${s.closeReason ?? ""},${s.netPnl ?? 0}`).join("\n"),
  );

  // ── ターミナル出力 ──
  console.log("\n" + "=".repeat(60));
  console.log("Verdict");
  console.log("=".repeat(60));
  console.log(`Total spreads: ${result.metrics.totalSpreads}`);
  for (const c of verdict.checks) {
    const status = c.pass === true ? "[PASS]" : c.pass === false ? "[FAIL]" : "[skip]";
    console.log(`  ${c.name.padEnd(30)} ${String(c.actual).padStart(10)} (≥/≤ ${c.threshold}) ${status}`);
  }
  console.log(`\n${verdict.overallPass ? "✅" : "❌"} ${verdict.summary}`);
  console.log(`Report: ${reportPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
```

**Step 2: package.json に script 追加**

`scripts` に以下を追加:
```json
"tail-test:credit-spread": "tsx src/backtest/tail-test/run-credit-spread-tail-test.ts"
```

**Step 3: 型チェック**

Run: `npm run typecheck`
Expected: エラーなし

**Step 4: コミット**

```bash
git add src/backtest/tail-test/run-credit-spread-tail-test.ts package.json
git commit -m "feat(tail-test): エントリーポイント追加 (CAGR / Verdict / CSV/Markdown 出力)"
```

---

## Task 9: 検証実行 + レポート確認

**Files:** なし（実行のみ）

**Step 1: 全期間 (2007〜) 実行**

```bash
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28
```

Expected:
- `docs/reports/credit-spread-tail-YYYY-MM-DD.md` が生成される
- `equity-curve-YYYY-MM-DD.csv`, `spreads-YYYY-MM-DD.csv` が同階層に出力
- ターミナルに `[PASS]` / `[FAIL]` のリストが表示される

**Step 2: レポート目視確認**

`cat docs/reports/credit-spread-tail-*.md | head -60` で結論部を確認:
- DD 上位 5 期間に "Lehman / 2008 GFC" がタグされていること
- COVID-19, Volmageddon 等のイベントが事前定義テーブルに含まれていること

**Step 3: 検証結果をコミット（生成物を残す）**

```bash
git add docs/reports/
git commit -m "report: SPY Credit Spread テール耐性検証 初回実行結果

期間: 2007-01-03 〜 2026-04-28
判定: <PASS or FAIL>
最悪 DD イベント: <イベント名>"
```

---

## Task 10: 最終チェック + Linear 更新

**Step 1: 全テスト実行**

Run: `npm test`
Expected: すべて PASS（dd-extractor, window-analyzer, tail-metrics, pass-fail, report）

**Step 2: Linear KOH-449 を Done で作成**

description には:
- 全 tail-test モジュールが TDD で実装されたこと
- 検証結果（PASS/FAIL、最悪 DD イベント、CAGR）
- 実取引へ進めるかの判断（PASS なら次は IBKR/Webull、FAIL なら設定見直し）
- レポートファイルへのリンク

---

## 全 Task 完了基準

- ✅ `find src/backtest/tail-test -type f -name "*.ts" | wc -l` が 11（types, stress-windows, dd-extractor, window-analyzer, tail-metrics, pass-fail, report, run + 4 tests）
- ✅ `npm run typecheck` エラーなし
- ✅ `npm test` 全 PASS
- ✅ `npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28` が完走、レポートが生成される
- ✅ レポートに DD 上位、stress windows、verdict、各 metric が含まれる

## DRY / YAGNI

- Monte Carlo / パラメータ感度分析は実装しない
- HTML / PDF 出力は実装しない（Markdown のみ）
- DB 永続化（BacktestRun テーブル等）は実装しない
- グラフ画像生成は実装しない（CSV があるので Excel で）
- パラメータ CLI フラグでの上書きは実装しない（コード編集で対応）

## 次フェーズ（さらに後）

- PASS なら → IBKR / Webull API クライアント実装（ロードマップ #4）
- FAIL なら → 設定見直し（shortPutDelta、spreadWidth、VIX cap 等の調整 + 再検証）
