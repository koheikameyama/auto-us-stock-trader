# Phase 1: tail-test Framework 抽象化リファクタ Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Phase 0 で credit-spread と dual-momentum 2 例から「戦略横断」のパターンが固まったので、tail-test framework を strategy-agnostic に抽象化し、踏み台 adapter を削除して `StrategyResult` 経由の素直な統合に変える。

**Architecture:**
1. 共通 `StrategyResult` interface 導入（`framework/strategy-result.ts`）
2. tail-test の "spread" 用語を "trade" に rename（`SimulatedSpread` 直接依存を排除）
3. ディレクトリを `tail-test/` → `framework/tail-test/` に移動
4. credit-spread thresholds を pass-fail から `credit-spread/tail-test-thresholds.ts` に切り出し
5. credit-spread / dual-momentum runner を新 framework 経由に書き換え
6. dual-momentum-adapter.ts を削除
7. `framework/correlation.ts` を新規追加（Phase 4 用準備）

**Tech Stack:** TypeScript / vitest / Prisma

**設計文書:**
- 全体設計: [2026-04-30-portfolio-strategy-evaluation-design.md](2026-04-30-portfolio-strategy-evaluation-design.md)
- Phase 0 実装結果: [2026-04-30-dual-momentum-phase-0-implementation-plan.md](2026-04-30-dual-momentum-phase-0-implementation-plan.md), KOH-455

---

## 前提条件

- Phase 0 完了済（KOH-455 Done, commit `1163cc2`）
- credit-spread tail-test と dual-momentum tail-test 両方が動作中（共に `src/backtest/tail-test/*` を共有）
- 全 56 vitest tests PASS, typecheck 0 errors
- credit-spread の 2007〜 全期間レポート (`docs/reports/credit-spread-tail-2026-04-30.md`) は KOH-451 evidence として保護されており、再生成して上書きしてはいけない
- 踏み台コード位置:
  - `src/backtest/tail-test/dual-momentum-adapter.ts`（Phase 1 で削除）
  - `src/backtest/dual-momentum/run-tail-test.ts` の adapter 経由部分（Phase 1 で書き換え）
  - `src/backtest/tail-test/types.ts` の `SimulatedSpread` import（rename して排除）

## Phase 1 完了基準

- [ ] `src/backtest/framework/strategy-result.ts` に `StrategyResult` / `Trade` interface が存在
- [ ] `src/backtest/framework/tail-test/` 配下に旧 `tail-test/` の core ファイルが移動済（dd-extractor, window-analyzer, tail-metrics, pass-fail, report, stress-windows, types）
- [ ] tail-test の API は `Trade[]` ベース（`SimulatedSpread` 直接 import なし）
- [ ] credit-spread runner が新 framework + `CREDIT_SPREAD_THRESHOLDS` を使う
- [ ] dual-momentum runner が新 framework + adapter なしで動く（`StrategyResult` を直接生成）
- [ ] `src/backtest/tail-test/dual-momentum-adapter.ts` 削除済
- [ ] credit-spread tail-test (smoke run 2020-2023) の数値が refactor 前と一致
- [ ] dual-momentum tail-test (smoke run 2020-2023) の数値が refactor 前と一致
- [ ] `framework/correlation.ts` で Pearson 相関係数算出可能
- [ ] 全 vitest テスト PASS、typecheck 0 errors
- [ ] `package.json` の `tail-test:credit-spread` / `tail-test:dual-momentum` が新 path で動く

---

## Task 1: Pre-flight + ベースライン記録

**Files:** なし（記録のみ）

**Step 1: 全テスト + typecheck 確認**

Run: `npm run test && npm run typecheck`
Expected: 56 tests PASS, 0 typecheck errors

**Step 2: credit-spread tail-test ベースライン記録（短期で速く）**

Run:
```bash
npm run tail-test:credit-spread -- --start 2020-01-01 --end 2023-12-31 --label phase1-baseline > /tmp/cs-baseline.txt 2>&1
```

確認: `docs/reports/credit-spread-tail-YYYY-MM-DD-phase1-baseline.md` が生成。
記録: ターミナル出力の主要メトリクス（Win Rate / Profit Factor / CAGR / Max DD / 総 spread 数 / Verdict）。

**Step 3: dual-momentum tail-test ベースライン記録**

Run:
```bash
npm run tail-test:dual-momentum -- --start 2020-01-01 --end 2023-12-31 > /tmp/dm-baseline.txt 2>&1
```

記録: 同様に主要メトリクス。

**Step 4: コミットなし**（インフラ作業のみ）

---

## Task 2: 共通 StrategyResult / Trade interface 定義

**Files:**
- Create: `src/backtest/framework/strategy-result.ts`
- Create: `src/backtest/framework/__tests__/.gitkeep`

**Step 1: ディレクトリ作成**

Run: `mkdir -p src/backtest/framework/__tests__`

**Step 2: strategy-result.ts 作成**

```ts
// src/backtest/framework/strategy-result.ts
import type { DailyEquity } from "../types";

/**
 * 戦略横断で tail-test framework が消費する trade レコード。
 * spread 固有 (shortStrike, creditReceived 等) や rotation 固有 (ticker, shares 等)
 * のフィールドは含めず、tail-test に必要な最小情報だけを持つ。
 */
export interface Trade {
  /** 識別子（任意、レポート用） */
  symbol: string;
  /** エントリー日 YYYY-MM-DD */
  entryDate: string;
  /** クローズ日 YYYY-MM-DD（オープンの場合 null） */
  closeDate: string | null;
  /** 純損益（手数料込み、ドル） */
  netPnl: number | null;
  /** PnL 率（%、initialBudget もしくは position size 比、戦略により定義が変わる） */
  pnlPct: number | null;
  /** 保有日数 */
  holdingDays: number | null;
  /** 戦略固有カテゴリ（"win" | "loss" | "stopOut" | "rotation_exit" 等、optional） */
  category?: string;
}

/**
 * 戦略実行結果（tail-test framework が消費する標準形）。
 */
export interface StrategyResult {
  /** "credit-spread" | "dual-momentum" 等 */
  strategyName: string;
  /** 戦略固有 config（レポート 設定 セクション用、shape 任意） */
  config: Record<string, unknown>;
  /** 評価期間 */
  period: { start: string; end: string };
  /** 開始資金 */
  initialBudget: number;
  /** 日次 equity curve */
  equityCurve: DailyEquity[];
  /** クローズ済 trade（tail-metrics / window-analyzer の入力） */
  trades: Trade[];
  /** 戦略全体メトリクス（base metrics 計算済） */
  metrics: {
    winRate: number;        // 0..1
    profitFactor: number;
    maxDrawdown: number;    // 0..1
    netReturnPct: number;   // 累積リターン
  };
}
```

**Step 3: typecheck 確認**

Run: `npm run typecheck`
Expected: 0 errors

**Step 4: コミット**

```bash
git add src/backtest/framework/strategy-result.ts
git commit -m "feat(framework): StrategyResult / Trade interface を追加"
```

---

## Task 3: tail-test core を framework/ に移動 + Trade ベースに rename

**Files:**
- Move: `src/backtest/tail-test/types.ts` → `src/backtest/framework/tail-test/types.ts`
- Move: `src/backtest/tail-test/dd-extractor.ts` → `src/backtest/framework/tail-test/dd-extractor.ts`
- Move: `src/backtest/tail-test/window-analyzer.ts` → `src/backtest/framework/tail-test/window-analyzer.ts`
- Move: `src/backtest/tail-test/tail-metrics.ts` → `src/backtest/framework/tail-test/tail-metrics.ts`
- Move: `src/backtest/tail-test/pass-fail.ts` → `src/backtest/framework/tail-test/pass-fail.ts`
- Move: `src/backtest/tail-test/report.ts` → `src/backtest/framework/tail-test/report.ts`
- Move: `src/backtest/tail-test/stress-windows.ts` → `src/backtest/framework/tail-test/stress-windows.ts`
- Move: `src/backtest/tail-test/__tests__/*` → `src/backtest/framework/tail-test/__tests__/*`
- Delete: `src/backtest/tail-test/dual-momentum-adapter.ts`（Task 5 で adapter 削除時に処理）
- Modify: 全 framework/tail-test/*.ts の `SimulatedSpread` 参照を `Trade` に rename
- Modify: `framework/tail-test/types.ts` の field 名を rename:
  - `spreadCount` → `tradeCount`
  - `worstSpread` → `worstTrade`
  - `closedSpreads` → `trades`
  - `tradesInPeriod` はそのまま（既に generic 名）

**Step 1: git mv で移動**

```bash
mkdir -p src/backtest/framework/tail-test/__tests__
git mv src/backtest/tail-test/types.ts src/backtest/framework/tail-test/types.ts
git mv src/backtest/tail-test/dd-extractor.ts src/backtest/framework/tail-test/dd-extractor.ts
git mv src/backtest/tail-test/window-analyzer.ts src/backtest/framework/tail-test/window-analyzer.ts
git mv src/backtest/tail-test/tail-metrics.ts src/backtest/framework/tail-test/tail-metrics.ts
git mv src/backtest/tail-test/pass-fail.ts src/backtest/framework/tail-test/pass-fail.ts
git mv src/backtest/tail-test/report.ts src/backtest/framework/tail-test/report.ts
git mv src/backtest/tail-test/stress-windows.ts src/backtest/framework/tail-test/stress-windows.ts
git mv src/backtest/tail-test/__tests__ src/backtest/framework/tail-test/
```

注: `tail-test/dual-momentum-adapter.ts` は移動せず、Task 5 で削除。`tail-test/run-credit-spread-tail-test.ts` は Task 6 で `credit-spread/run-tail-test.ts` に移動するのでここでは触らない。

**Step 2: types.ts の rename**

```ts
// src/backtest/framework/tail-test/types.ts
import type { DailyEquity } from "../../types";
import type { Trade } from "../strategy-result";  // <— SimulatedSpread から変更

// ...

export interface DDPeriod {
  // ...
  tradesInPeriod: Trade[];  // <— Trade に rename
}

export interface WindowAnalysis {
  // ...
  tradeCount: number;  // <— spreadCount から rename
  // 他フィールドは据え置き
  winRate: number;
  totalPnl: number;
}

export interface TailMetrics {
  cvar5: number;
  cvar1: number;
  worstTrade: Trade | null;  // <— worstSpread から rename
  worstDay: { date: string; dailyPnl: number } | null;
  consecutiveLossCount: number;
}

export interface VixBucket {
  label: ">30" | "20-30" | "≤20";
  tradingDays: number;
  tradeCount: number;       // <— spreadCount から rename
  winRate: number;
  pnlPerTrade: number;      // <— pnlPerSpread から rename
}

export interface TailTestResult {
  // ...
  totalTrades: number;        // <— totalSpreads から rename
  // ...
  trades: Trade[];            // <— closedSpreads から rename
}
```

**Step 3: dd-extractor.ts**

```ts
import type { Trade } from "../strategy-result";  // <— SimulatedSpread から変更
// 内部の `tradesInPeriod: []` は型変更だけで動作はそのまま
```

**Step 4: window-analyzer.ts**

`SimulatedSpread` import を削除し、`Trade` に置換。

```ts
import type { Trade } from "../strategy-result";

export function analyzeWindow(
  window: StressWindow,
  equityCurve: DailyEquity[],
  trades: Trade[],          // <— closedSpreads から rename
): WindowAnalysis {
  // ...
  const inWindowTrades = trades.filter((t) => {
    // 元: s.entryDate, s.closeDate を使う → t.entryDate, t.closeDate
    return t.entryDate >= window.start && t.entryDate <= window.end;
    // (元のロジック維持)
  });

  // ...
  return {
    // ...
    tradeCount: inWindowTrades.length,  // <— spreadCount から
    winRate: ...,
    totalPnl: ...,
  };
}
```

注: 元の filter ロジックを保持する（`closeDate <= window.end` 等の条件は元と同じ）。`netPnl` 参照は `t.netPnl ?? 0` のように null safe にする（`Trade.netPnl` は nullable）。

**Step 5: tail-metrics.ts**

```ts
import type { Trade } from "../strategy-result";

export function calculateTailMetrics(
  trades: Trade[],            // <— spreads から rename
  equityCurve: DailyEquity[],
): TailMetrics {
  // 元: s.state === "CLOSED" && s.netPnl != null
  // → Trade には state field がないので closeDate != null && netPnl != null
  const closed = trades.filter((t) => t.closeDate != null && t.netPnl != null);
  // ... rest preserves logic
}

export function calculateVixBuckets(
  tradingDays: string[],
  vixMap: Map<string, number>,
  trades: Trade[],            // <— spreads から rename
): VixBucket[] {
  const buckets: VixBucket[] = [
    { label: ">30",   tradingDays: 0, tradeCount: 0, winRate: 0, pnlPerTrade: 0 },
    // ...
  ];
  // ロジックそのまま、field 名のみ rename
}
```

**Step 6: pass-fail.ts**

`SimulatedSpread` import なし → 触らない。ただし、将来 credit-spread thresholds を切り出すため、`DEFAULT_THRESHOLDS` 定義はこのファイルから削除（Task 4 で credit-spread 側へ移動）。

このタスクでは pass-fail.ts は import path 修正のみ（`./types` → `./types`、変更なし）。

**Step 7: report.ts**

field 名 rename を反映:
- `result.totalSpreads` → `result.totalTrades`
- `result.closedSpreads` → `result.trades`
- `w.spreadCount` → `w.tradeCount`
- `b.spreadCount` → `b.tradeCount`
- `b.pnlPerSpread` → `b.pnlPerTrade`
- `tailMetrics.worstSpread` → `tailMetrics.worstTrade`

ヘッダーラベルも rename: 「総 spread 数」→「総 trade 数」、「最悪 spread」→「最悪 trade」、「Bucket | 取引日数 | spread」→「Bucket | 取引日数 | trade」。

`spreads.csv` 参照行は仮対応として "trades.csv" にしておく（実 CSV 出力は credit-spread runner 側でやる、Task 6 で）。

**Step 8: typecheck + テスト**

Run: `npm run typecheck && npm run test`
Expected: typecheck 0 errors。テストは現状の credit-spread runner / dual-momentum runner のままでは壊れる（次タスクで修正）ので、framework/tail-test/__tests__/* のみ通れば OK。

**重要:** runner ファイル (`run-credit-spread-tail-test.ts`, `run-tail-test.ts`) はまだ古い path で import しているのでこの段階で typecheck はエラーになる。Task 6 まで含めてコミットを 1 つにまとめるか、テスト無効化を一時的に許容するか選択。

**選択肢 A:** Task 3 でテストエラーを許容、Task 6 完了時にまとめてコミット。
**選択肢 B:** Task 3 で runner も import 修正だけ先に直して typecheck 通す（Task 6 の本格 refactor は別タスク）。

**おすすめ B:** typecheck を緑に保つ。runner の import path だけを修正（古い `tail-test/` → `framework/tail-test/`）し、Trade ↔ SimulatedSpread の整合は引き続き adapter 経由で動かす（Task 5/6 で adapter 削除時に整理）。

```ts
// runner files import path 更新例（Task 3 で）
- import { extractDDPeriods } from "./dd-extractor";  // 旧
+ import { extractDDPeriods } from "../framework/tail-test/dd-extractor";  // 新
```

**Step 9: 全テスト + typecheck**

Run: `npm run test && npm run typecheck`
Expected: 全 PASS, 0 errors

**Step 10: コミット**

```bash
git add src/backtest/framework/tail-test/ src/backtest/dual-momentum/run-tail-test.ts src/backtest/tail-test/run-credit-spread-tail-test.ts
git commit -m "refactor(framework): tail-test を framework/tail-test/ に移動 + Trade ベース化

- 旧 tail-test/* を framework/tail-test/* に git mv
- types.ts: SimulatedSpread 直接参照を Trade に rename
- spreadCount/closedSpreads/worstSpread/pnlPerSpread/totalSpreads
  を tradeCount/trades/worstTrade/pnlPerTrade/totalTrades に rename
- runner の import path 更新（adapter 経由は据え置き、Task 5/6 で整理）"
```

---

## Task 4: credit-spread thresholds を切り出し

**Files:**
- Create: `src/backtest/credit-spread/tail-test-thresholds.ts`
- Modify: `src/backtest/framework/tail-test/pass-fail.ts`（DEFAULT_THRESHOLDS export を削除 or generic 名に rename）
- Modify: `src/backtest/tail-test/run-credit-spread-tail-test.ts`（new path から import）

**Step 1: credit-spread/tail-test-thresholds.ts 作成**

```ts
// src/backtest/credit-spread/tail-test-thresholds.ts
import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * SPY Credit Spread 用 tail-test 閾値（KOH-449 起源、KOH-451 で 7/7 PASS 確認済）。
 */
export const CREDIT_SPREAD_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.70,
  profitFactorMin: 1.30,
  cagrMin: 0.10,
  maxDrawdownMax: 0.25,
  cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.30,
  worstWindowPnlPctMin: -0.50,
};
```

**Step 2: pass-fail.ts から DEFAULT_THRESHOLDS export を削除**

`framework/tail-test/pass-fail.ts` の `DEFAULT_THRESHOLDS` 定数を削除。`DefaultThresholds` interface は残す（戦略各々がこれを実装するため）。

**Step 3: credit-spread runner を新 import に変更**

`src/backtest/tail-test/run-credit-spread-tail-test.ts`:
```ts
- import { evaluateThresholds, DEFAULT_THRESHOLDS } from "./pass-fail";
+ import { evaluateThresholds } from "../framework/tail-test/pass-fail";
+ import { CREDIT_SPREAD_THRESHOLDS } from "../credit-spread/tail-test-thresholds";

// 呼び出し: thresholds: DEFAULT_THRESHOLDS → thresholds: CREDIT_SPREAD_THRESHOLDS
```

**Step 4: 既存 pass-fail テストの修正**

`framework/tail-test/__tests__/pass-fail.test.ts` で `DEFAULT_THRESHOLDS` を使っていたら、テストファイル内に同じ shape のローカル定数を定義して使う（テスト用の固定値であり、credit-spread とは独立）:

```ts
const TEST_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.70, profitFactorMin: 1.30, cagrMin: 0.10,
  maxDrawdownMax: 0.25, cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.30, worstWindowPnlPctMin: -0.50,
};
```

**Step 5: typecheck + テスト**

Run: `npm run typecheck && npm run test`
Expected: 全 PASS, 0 errors

**Step 6: credit-spread smoke run + ベースライン比較**

Run: `npm run tail-test:credit-spread -- --start 2020-01-01 --end 2023-12-31 --label phase1-step4`
比較: 主要メトリクスが Task 1 ベースラインと一致

**Step 7: コミット**

```bash
git add src/backtest/credit-spread/tail-test-thresholds.ts src/backtest/framework/tail-test/pass-fail.ts src/backtest/framework/tail-test/__tests__/pass-fail.test.ts src/backtest/tail-test/run-credit-spread-tail-test.ts
git commit -m "refactor(credit-spread): tail-test thresholds を credit-spread/ に切り出し"
```

---

## Task 5: dual-momentum を StrategyResult 直接生成に書き換え + adapter 削除

**Files:**
- Modify: `src/backtest/dual-momentum/run-tail-test.ts`（adapter 経由 → 直接 StrategyResult 生成）
- Delete: `src/backtest/tail-test/dual-momentum-adapter.ts`

**Step 1: run-tail-test.ts を新 framework に書き換え**

```ts
// src/backtest/dual-momentum/run-tail-test.ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_DUAL_MOMENTUM_DEFAULTS } from "../us/us-dual-momentum-config";
import { runUSDualMomentumBacktest } from "../us/us-dual-momentum-simulation";
import { fetchUSHistoricalFromDB } from "../us/us-data-fetcher";
import type { USDualMomentumBacktestConfig } from "../us/us-dual-momentum-types";
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import { DUAL_MOMENTUM_THRESHOLDS } from "./tail-test-thresholds";

async function main() {
  // ... arg parsing と config 設定は元のまま ...

  const result = runUSDualMomentumBacktest(config, etfMap);

  // ── adapter 削除、直接 Trade[] を作る ──
  const trades: Trade[] = result.positions
    .filter((p) => p.exitReason === "rotation_exit" && p.exitDate && p.netPnl != null)
    .map((p) => ({
      symbol: p.ticker,
      entryDate: p.entryDate,
      closeDate: p.exitDate ?? null,
      netPnl: p.netPnl ?? null,
      pnlPct: p.pnlPct ?? null,
      holdingDays: p.holdingDays ?? null,
      category: "rotation_exit",
    }));

  // StrategyResult を組み立て
  const strategyResult: StrategyResult = {
    strategyName: "Dual Momentum",
    config: { ...config },
    period: { start: startDate, end: endDate },
    initialBudget: config.initialBudget,
    equityCurve: result.equityCurve,
    trades,
    metrics: {
      winRate: result.metrics.winRate / 100,
      profitFactor: result.metrics.profitFactor,
      maxDrawdown: result.metrics.maxDrawdown / 100,
      netReturnPct: result.metrics.netReturnPct,
    },
  };

  // 既存 tail-test framework を Trade ベースで呼ぶ
  const ddPeriods = extractDDPeriods(strategyResult.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) =>
    analyzeWindow(w, strategyResult.equityCurve, strategyResult.trades)
  );
  const tailMetrics = calculateTailMetrics(strategyResult.trades, strategyResult.equityCurve);

  const finalEq =
    strategyResult.equityCurve[strategyResult.equityCurve.length - 1]?.totalEquity ??
    strategyResult.initialBudget;
  const years = strategyResult.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / strategyResult.initialBudget, 1 / years) - 1 : 0;

  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD = available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct = available.length === 0 ? null : Math.min(...available.map((w) => w.pnlPct));

  const verdict = evaluateThresholds({
    winRate: strategyResult.metrics.winRate,
    profitFactor: strategyResult.metrics.profitFactor,
    cagr,
    maxDrawdown: strategyResult.metrics.maxDrawdown,
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    maxLossDollar: strategyResult.initialBudget,
    thresholds: DUAL_MOMENTUM_THRESHOLDS,
  });

  // TailTestResult 組み立て + Markdown レポート出力（元のまま）
  // ...
}

main().catch(...);
```

**Step 2: adapter 削除**

```bash
git rm src/backtest/tail-test/dual-momentum-adapter.ts
```

`src/backtest/tail-test/` ディレクトリが空になっていれば削除（あるいは `run-credit-spread-tail-test.ts` のみ残るので保持）。

**Step 3: typecheck + テスト**

Run: `npm run typecheck && npm run test`
Expected: 0 errors, 全 PASS

**Step 4: smoke + ベースライン比較**

Run: `npm run tail-test:dual-momentum -- --start 2020-01-01 --end 2023-12-31`
比較: Task 1 dm-baseline と主要メトリクス一致

**Step 5: コミット**

```bash
git add src/backtest/dual-momentum/run-tail-test.ts
git rm src/backtest/tail-test/dual-momentum-adapter.ts
git commit -m "refactor(dual-momentum): adapter 経由を廃止し StrategyResult 直接生成に変更"
```

---

## Task 6: credit-spread runner も StrategyResult 経由に整理

**Files:**
- Move: `src/backtest/tail-test/run-credit-spread-tail-test.ts` → `src/backtest/credit-spread/run-tail-test.ts`
- Modify: `package.json` の `tail-test:credit-spread` script

**Step 1: ファイル移動 + 中身を StrategyResult 経由に書き換え**

```bash
git mv src/backtest/tail-test/run-credit-spread-tail-test.ts src/backtest/credit-spread/run-tail-test.ts
```

中身を dual-momentum runner と同じ pattern に揃える:

```ts
// src/backtest/credit-spread/run-tail-test.ts
import { runUSCreditSpreadBacktest } from "../us/us-credit-spread-simulation";
// ... 既存 imports ...
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { CREDIT_SPREAD_THRESHOLDS } from "./tail-test-thresholds";
// framework imports に切替

const result = await runUSCreditSpreadBacktest(config, gspc, vix);

// SimulatedSpread → Trade 変換
const closed = result.spreads.filter((s) => s.state === "CLOSED" && s.netPnl != null);
const trades: Trade[] = closed.map((s) => ({
  symbol: s.underlyingSymbol,
  entryDate: s.entryDate,
  closeDate: s.closeDate ?? null,
  netPnl: s.netPnl ?? null,
  pnlPct: s.netPnl != null ? (s.netPnl / config.initialBudget) * 100 : null,
  holdingDays: s.closeDate
    ? Math.round((new Date(s.closeDate).getTime() - new Date(s.entryDate).getTime()) / 86400000)
    : null,
  category: s.closeReason,
}));

const strategyResult: StrategyResult = {
  strategyName: "SPY Credit Spread",
  config: { ...config },
  period: { start: startDate, end: endDate },
  initialBudget: config.initialBudget,
  equityCurve: result.equityCurve,
  trades,
  metrics: {
    winRate: result.metrics.winRate / 100,
    profitFactor: result.metrics.profitFactor,
    maxDrawdown: result.metrics.maxDrawdown / 100,
    netReturnPct: result.metrics.netReturnPct,
  },
};

// ... rest（dual-momentum runner と同じ流れ） ...
// VIX bucket は credit-spread だけ計算するので残す
const vixBuckets = calculateVixBuckets(tradingDays, vix, trades);
```

**Step 2: package.json scripts の path 更新**

```json
"tail-test:credit-spread": "tsx src/backtest/credit-spread/run-tail-test.ts",
```

**Step 3: typecheck + テスト + smoke**

Run: `npm run typecheck && npm run test`
Run smoke (短期):
```bash
npm run tail-test:credit-spread -- --start 2020-01-01 --end 2023-12-31 --label phase1-step6
```

比較: Task 1 cs-baseline と主要メトリクス一致。
**重要:** 既存の `docs/reports/credit-spread-tail-2026-04-30.md`（KOH-451 evidence）を上書きしないように `--label phase1-step6` を付ける。

**Step 4: コミット**

```bash
git add src/backtest/credit-spread/run-tail-test.ts package.json
git rm src/backtest/tail-test/run-credit-spread-tail-test.ts
git commit -m "refactor(credit-spread): run-tail-test を credit-spread/ に移動し StrategyResult 経由化"
```

**Step 5: 空ディレクトリ整理**

```bash
rmdir src/backtest/tail-test 2>/dev/null || echo "tail-test/ 残骸あり、確認"
ls src/backtest/tail-test 2>/dev/null  # 空なら git status で削除追跡される
```

src/backtest/tail-test/ が空になっていれば自動的に git tracking されない。

---

## Task 7: framework/correlation.ts を新規追加（Phase 4 用準備）

**Files:**
- Create: `src/backtest/framework/correlation.ts`
- Create: `src/backtest/framework/__tests__/correlation.test.ts`

**Step 1: 失敗するテストを書く**

```ts
// src/backtest/framework/__tests__/correlation.test.ts
import { describe, it, expect } from "vitest";
import { calculatePearsonCorrelation, alignEquityCurves, dailyReturns } from "../correlation";
import type { DailyEquity } from "../../types";

function eq(date: string, totalEquity: number): DailyEquity {
  return { date, cash: 0, positionsValue: totalEquity, totalEquity, openPositionCount: 0 };
}

describe("dailyReturns", () => {
  it("returns successive percent changes", () => {
    const curve = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 99)];
    const ret = dailyReturns(curve);
    expect(ret).toHaveLength(2);
    expect(ret[0]).toBeCloseTo(0.1, 5);  // 110/100 - 1
    expect(ret[1]).toBeCloseTo(-0.1, 5); // 99/110 - 1
  });

  it("returns empty array when curve has < 2 points", () => {
    expect(dailyReturns([])).toEqual([]);
    expect(dailyReturns([eq("2024-01-01", 100)])).toEqual([]);
  });
});

describe("alignEquityCurves", () => {
  it("returns common date range only", () => {
    const a = [eq("2024-01-01", 100), eq("2024-01-02", 110), eq("2024-01-03", 120)];
    const b = [eq("2024-01-02", 50), eq("2024-01-03", 60), eq("2024-01-04", 70)];
    const aligned = alignEquityCurves(a, b);
    expect(aligned.dates).toEqual(["2024-01-02", "2024-01-03"]);
    expect(aligned.equityA).toEqual([110, 120]);
    expect(aligned.equityB).toEqual([50, 60]);
  });
});

describe("calculatePearsonCorrelation", () => {
  it("returns 1.0 for identical series", () => {
    expect(calculatePearsonCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeCloseTo(1.0, 5);
  });

  it("returns -1.0 for perfectly inversely correlated series", () => {
    expect(calculatePearsonCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1.0, 5);
  });

  it("returns ~0 for uncorrelated random-like series", () => {
    const r = calculatePearsonCorrelation([1, -1, 1, -1, 1], [1, 1, -1, -1, 1]);
    expect(Math.abs(r)).toBeLessThan(0.5);
  });

  it("throws on length mismatch", () => {
    expect(() => calculatePearsonCorrelation([1, 2, 3], [1, 2])).toThrow();
  });
});
```

**Step 2: vitest run → fail**

Run: `npx vitest run src/backtest/framework/__tests__/correlation.test.ts`
Expected: FAIL（モジュール未存在）

**Step 3: 実装**

```ts
// src/backtest/framework/correlation.ts
import type { DailyEquity } from "../types";

/**
 * 日次リターン（各日の equity 変化率）を計算。
 * 入力 < 2 点の場合は empty array。
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
 * 2 つの equity curve を共通日付に揃える。
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
 * Pearson 相関係数を計算（2 配列、同じ長さ）。
 */
export function calculatePearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length) {
    throw new Error(`length mismatch: ${x.length} vs ${y.length}`);
  }
  const n = x.length;
  if (n === 0) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
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
```

**Step 4: テスト pass 確認**

Run: `npx vitest run src/backtest/framework/__tests__/correlation.test.ts`
Expected: 全 PASS

**Step 5: コミット**

```bash
git add src/backtest/framework/correlation.ts src/backtest/framework/__tests__/correlation.test.ts
git commit -m "feat(framework): correlation.ts (Pearson + alignEquityCurves + dailyReturns) を追加"
```

---

## Task 8: 全期間 smoke run + Phase 0 レポートとの差分確認

**Step 1: 全テスト + typecheck**

Run: `npm run test && npm run typecheck`
Expected: 全 PASS, 0 errors

**Step 2: dual-momentum 全期間 smoke**

Run: `npm run tail-test:dual-momentum -- --start 2007-01-03 --label phase1-final`

確認:
- `docs/reports/dual-momentum-tail-YYYY-MM-DD-phase1-final.md` が生成される
- Phase 0 の `docs/reports/dual-momentum-tail-2026-04-30.md`（label なし）と数値が一致
  - 主要メトリクス: 総 trade 数 37, Win Rate 64.86%, Profit Factor 3.50, CAGR 5.62%, Max DD 32.58%
  - 「総 spread 数」「最悪 spread」が「総 trade 数」「最悪 trade」になっている

**Step 3: credit-spread 短期 smoke (KOH-451 レポート上書き防止のため --label 必須)**

Run: `npm run tail-test:credit-spread -- --start 2020-01-01 --end 2023-12-31 --label phase1-final`

確認:
- Task 1 のベースライン `cs-baseline.txt` と一致
- ヘッダーラベル変更が反映

**Step 4: design doc に Phase 1 完了報告追記**

`docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md` の `## 進捗` セクションに追記:

```markdown
### Phase 1: tail-test framework 抽象化リファクタ (KOH-XXX, 2026-XX-XX 完了)

**実装完了内容:**
- src/backtest/framework/strategy-result.ts に StrategyResult / Trade interface 追加
- src/backtest/tail-test/* を src/backtest/framework/tail-test/* に移動
- "spread" 用語を "trade" にリネーム（tradeCount, trades, worstTrade 等）
- credit-spread thresholds を pass-fail から credit-spread/tail-test-thresholds.ts に分離
- credit-spread / dual-momentum の runner を StrategyResult 直接生成に書き換え
- tail-test/dual-momentum-adapter.ts 削除（踏み台コード）
- framework/correlation.ts 追加（Phase 4 portfolio 化判断準備）

**回帰確認:**
- credit-spread tail-test (2020-2023) 数値が refactor 前と一致
- dual-momentum tail-test (2020-2023, 2007-) 数値が refactor 前と一致

**次のフェーズへの判断:**
Phase 2-A (PEAD) と Phase 2-B (Momentum) を並列実行可能（framework が抽象化済）。
```

**Step 5: コミット**

```bash
git add docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md
git commit -m "docs(portfolio): Phase 1 (framework 抽象化) 完了報告を design doc に追記"
```

---

## Phase 1 完了確認チェックリスト

- [ ] `src/backtest/framework/strategy-result.ts` 存在、Trade / StrategyResult export
- [ ] `src/backtest/framework/tail-test/` 配下に旧 tail-test core 7 ファイル移動済
- [ ] `src/backtest/tail-test/dual-momentum-adapter.ts` 削除済
- [ ] `src/backtest/credit-spread/tail-test-thresholds.ts` 存在、CREDIT_SPREAD_THRESHOLDS export
- [ ] `src/backtest/credit-spread/run-tail-test.ts` 存在、StrategyResult 経由
- [ ] `src/backtest/dual-momentum/run-tail-test.ts` adapter 経由なし、StrategyResult 経由
- [ ] `src/backtest/framework/correlation.ts` 存在、3 関数 export
- [ ] package.json `tail-test:credit-spread` が新 path
- [ ] 全 vitest テスト PASS（既存 + correlation 新規 = 60+ tests）
- [ ] typecheck 0 errors
- [ ] credit-spread / dual-momentum smoke 結果が refactor 前と一致

## Phase 2 への引き継ぎ事項

framework 抽象化完了後、Phase 2-A (PEAD) / Phase 2-B (Momentum) は以下のパターンで実装可能:

1. JP リポから simulation を移管 + 純関数化（Phase 0 と同パターン）
2. データ backfill（戦略毎の universe / 期間）
3. `<strategy>/tail-test-thresholds.ts` 作成
4. `<strategy>/run-tail-test.ts` 作成（直接 StrategyResult を生成、adapter 不要）
5. `package.json` script 追加

framework 側は触らない（抽象化が完了しているため）。

## YAGNI（Phase 1 で採用しないもの）

- WindowAnalysis / TailMetrics の field 名さらなる generic 化（"trade" で十分）
- multi-strategy-report.ts（Phase 4 で必要時に作成）
- correlation の rolling window（Phase 4 で必要時）
- 戦略間 portfolio simulation（Phase 4）
- credit-spread の純関数化第二弾（KOH-452 で完了済、Phase 1 のスコープ外）
- VIX bucket 計算の戦略 agnostic 化（credit-spread のみ使う、現状で十分）
