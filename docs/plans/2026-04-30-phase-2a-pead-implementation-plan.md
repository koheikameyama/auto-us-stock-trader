# Phase 2-A: PEAD Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Phase 1 完了済 framework を使って PEAD（Post-Earnings Announcement Drift）戦略を tail-test に通し、portfolio 補完候補としての評価レポートを生成する。Phase 2-B (Momentum) と並列実行可能。

**Architecture:**
1. JP リポから既に bulk migrate 済の `src/backtest/us/us-pead-*.ts` をベースに、credit-spread/dual-momentum と同じパターンで純関数を `src/backtest/pead/` に抽出（TDD）
2. simulation.ts 本体は純関数を呼ぶラッパーに refactor
3. データ backfill を確認（S&P500 個別株 + earnings、2015〜が現実的範囲）
4. `pead/tail-test-thresholds.ts` を作成（Tier 1 用閾値）
5. `pead/run-tail-test.ts` を作成（StrategyResult 直接生成、Phase 1 framework 経由）

**Tech Stack:** TypeScript / vitest / Prisma / yfinance / psycopg2

**設計文書:**
- 全体設計: [2026-04-30-portfolio-strategy-evaluation-design.md](2026-04-30-portfolio-strategy-evaluation-design.md)
- Phase 1 (framework 抽象化): [2026-04-30-phase-1-framework-abstraction-implementation-plan.md](2026-04-30-phase-1-framework-abstraction-implementation-plan.md), KOH-456
- Phase 0 (dual-momentum) 参考: [2026-04-30-dual-momentum-phase-0-implementation-plan.md](2026-04-30-dual-momentum-phase-0-implementation-plan.md), KOH-455

---

## 前提条件

- Phase 1 完了済（KOH-456 Done, commit `676426b`）— framework が strategy-agnostic 化済
- JP 移管済コード: `src/backtest/us/us-pead-{config,run,simulation}.ts` + `us-types.ts` の `USPeadBacktestConfig` / `USPeadBacktestResult`
- 既存 backfill scripts: `scripts/data/backfill_daily_bars.py`, `scripts/data/backfill_earnings.py`
- 既存 data-fetcher: `fetchUSHistoricalFromDB`, `fetchVixFromDB`, `fetchSP500FromDB`, `fetchUSEarningsFromDB`, `getUSTickerCodes`
- Phase 1 で確立された `framework/strategy-result.ts` の `StrategyResult` / `Trade` interface
- Phase 1 で確立された runner pattern（[credit-spread/run-tail-test.ts](../../src/backtest/credit-spread/run-tail-test.ts), [dual-momentum/run-tail-test.ts](../../src/backtest/dual-momentum/run-tail-test.ts)）

## Phase 2-A 完了基準

- [ ] `src/backtest/pead/` 配下に純関数 + テストが存在
- [ ] `us-pead-simulation.ts` が純関数を呼ぶラッパーに refactor 済（数値完全一致）
- [ ] S&P500 個別株 + earnings データ 2015〜 が local + Railway DB に存在（既存で足りていれば backfill 不要）
- [ ] `src/backtest/pead/tail-test-thresholds.ts` 存在
- [ ] `src/backtest/pead/run-tail-test.ts` 存在（StrategyResult 直接生成）
- [ ] `npm run tail-test:pead` で完走、`docs/reports/pead-tail-YYYY-MM-DD.md` 生成
- [ ] 全 vitest tests PASS、typecheck 0 errors
- [ ] framework 側に変更なし

---

## Task 1: Pre-flight + ベースライン記録

**Step 1: 全テスト + typecheck**
```bash
npm run test && npm run typecheck
```
Expected: 全 PASS, 0 errors

**Step 2: 既存 PEAD backtest 動作確認**
```bash
npx tsx src/backtest/us/us-pead-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/pead-baseline.txt 2>&1
tail -30 /tmp/pead-baseline.txt
```
記録: 主要メトリクス（Total trades / Win Rate / Profit Factor / CAGR / Max DD）。Task 5 で refactor 後と比較する。

**Step 3: データ範囲確認**

Local DB SQL:
```sql
SELECT COUNT(DISTINCT "tickerCode") AS tickers, MIN(date), MAX(date), COUNT(*)
FROM auto_us_stock_trader."StockDailyBar";

SELECT COUNT(DISTINCT "tickerCode") AS tickers, MIN(date), MAX(date), COUNT(*)
FROM auto_us_stock_trader."EarningsDate";
```

期待: 個別株 universe が 500+ ticker, 2015-01-01 以降のデータあり。earnings は 2015〜2026 の範囲で各 ticker に存在。

**Step 4: コミットなし**

---

## Task 2: TDD - PEAD 純関数の抽出

**Files:**
- Create: `src/backtest/pead/__tests__/`
- Create: `src/backtest/pead/signal-detector.ts`
- Create: `src/backtest/pead/__tests__/signal-detector.test.ts`

**抽出対象（候補、移管時に詳細決定）:**

us-pead-simulation.ts (398 lines) を読んで以下の純関数を抽出:

1. **`detectPeadSignal(prevClose, todayOpen, todayVolume, avgVolume25, gapMinPct, volSurgeRatio)` → `Signal | null`**
   - 決算翌日の gap + 出来高サージで PEAD entry signal を生成
   - 純粋: 入力数値のみで判定、副作用なし

2. **`evaluatePeadExit(position, today, currentPrice, atr, holdingDays, config)` → `ExitDecision`**
   - 既存 PEAD position の HOLD/CLOSE 判定（trailing stop / time stop / SL）
   - 純粋: 状態遷移を表す純関数

3. **(オプション) `calculatePositionSize(equity, riskPerTrade, entryPrice, stopPrice)` → `shares`**
   - 既存 simulation 内の position sizing logic を抽出

**Step 1: 失敗テストを書く**（detectPeadSignal の例）

```ts
import { describe, it, expect } from "vitest";
import { detectPeadSignal } from "../signal-detector";

describe("detectPeadSignal", () => {
  it("returns signal when gap and volume both meet thresholds", () => {
    const sig = detectPeadSignal({
      prevClose: 100, todayOpen: 104, todayVolume: 200_000, avgVolume25: 100_000,
      gapMinPct: 0.03, volSurgeRatio: 1.5,
    });
    expect(sig).not.toBeNull();
    expect(sig!.gapPct).toBeCloseTo(0.04, 5);
  });

  it("returns null when gap below threshold", () => {
    const sig = detectPeadSignal({
      prevClose: 100, todayOpen: 102, todayVolume: 200_000, avgVolume25: 100_000,
      gapMinPct: 0.03, volSurgeRatio: 1.5,
    });
    expect(sig).toBeNull();
  });

  it("returns null when volume below threshold", () => {
    const sig = detectPeadSignal({
      prevClose: 100, todayOpen: 105, todayVolume: 100_000, avgVolume25: 100_000,
      gapMinPct: 0.03, volSurgeRatio: 1.5,
    });
    expect(sig).toBeNull();
  });

  // 4-5 ケース（境界値、null 入力等）
});
```

**Step 2: テスト失敗確認**
```bash
npx vitest run src/backtest/pead/__tests__/signal-detector.test.ts
```
Expected: FAIL（モジュール未存在）

**Step 3: 最小実装**

us-pead-simulation.ts の `precomputePeadDailySignals` から該当ロジックを抽出して `signal-detector.ts` に移植。型定義は最小限。

**Step 4: テスト pass**
Expected: 全 PASS

**Step 5: コミット**
```bash
git add src/backtest/pead/signal-detector.ts src/backtest/pead/__tests__/signal-detector.test.ts
git commit -m "feat(pead): detectPeadSignal を純関数として TDD 抽出"
```

**(同様に Step 6-10 で `evaluatePeadExit` と `calculatePositionSize` を順次 TDD 抽出)**

---

## Task 3: simulation refactor

**Files:**
- Modify: `src/backtest/us/us-pead-simulation.ts`

**Step 1: refactor 前ベースライン記録**
```bash
npx tsx src/backtest/us/us-pead-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/pead-before.txt
```

**Step 2: simulation.ts を純関数を呼ぶラッパーに変更**
- `import { detectPeadSignal, evaluatePeadExit, calculatePositionSize } from "../pead/...";`
- 元の inline ロジックを純関数呼び出しに置換
- 動作は完全に保持（数値完全一致が必須）

**Step 3: typecheck + test**
```bash
npm run typecheck && npm run test
```
Expected: 0 errors, 全 PASS（ユニットテストは pead/__tests__/* の追加分含む）

**Step 4: 数値再現確認**
```bash
npx tsx src/backtest/us/us-pead-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/pead-after.txt
diff /tmp/pead-before.txt /tmp/pead-after.txt
```
Expected: 完全一致 or floating point の最終桁差のみ。一致しなければ refactor のロジックエラー、原因究明 → 修正。

**Step 5: コミット**
```bash
git add src/backtest/us/us-pead-simulation.ts
git commit -m "refactor(pead): simulation を純関数を呼ぶラッパー化"
```

---

## Task 4: PEAD thresholds 定義

**Files:**
- Create: `src/backtest/pead/tail-test-thresholds.ts`

```ts
import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * PEAD 用 tail-test 閾値（Tier 1）。
 * 個別株 idiosyncratic で vol regime 非依存、credit-spread と低相関期待。
 * 平均勝率は moderate, profit factor で稼ぐタイプの戦略想定。
 */
export const PEAD_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.55,        // 個別株 momentum で過半勝つ程度を期待
  profitFactorMin: 1.5,    // win/loss が偏るため PF で目標
  cagrMin: 0.08,           // 8% / 年（credit-spread より低めで OK）
  maxDrawdownMax: 0.35,    // 個別株 universe で 35% は許容
  cvar5MinRatio: 0.5,      // credit-spread と同じ尺度
  worstWindowDDMax: 0.40,
  worstWindowPnlPctMin: -0.45,
};
```

**コミット**: Task 5 と一緒。

---

## Task 5: run-tail-test.ts 作成

**Files:**
- Create: `src/backtest/pead/run-tail-test.ts`

参考: [src/backtest/dual-momentum/run-tail-test.ts](../../src/backtest/dual-momentum/run-tail-test.ts) を template として、PEAD 用に書き換える。Phase 0 の adapter は不要、framework が抽象化済。

主要構造:

```ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_PEAD_DEFAULTS } from "../us/us-pead-config";
import { runUSPeadBacktest } from "../us/us-pead-simulation";
import {
  getUSTickerCodes, fetchUSHistoricalFromDB, fetchSP500FromDB,
  fetchVixFromDB, fetchUSEarningsFromDB,
} from "../us/us-data-fetcher";
import type { USPeadBacktestConfig } from "../us/us-types";
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import { PEAD_THRESHOLDS } from "./tail-test-thresholds";

async function main() {
  // arg parsing (start/end/budget/label)
  // データ取得 (tickers + bars + index + vix + earnings)
  // runUSPeadBacktest 実行
  // SimulatedPosition[] → Trade[] 変換
  // StrategyResult 構築（strategyName: "pead"）
  // tail-test framework 呼び出し
  // verdict 算出 (PEAD_THRESHOLDS)
  // Markdown レポート出力 → docs/reports/pead-tail-YYYY-MM-DD.md (Title Case "PEAD" を渡す)
}
```

**Trade 変換**:

```ts
const trades: Trade[] = result.trades
  .filter((t) => t.exitDate != null && t.netPnl != null)
  .map((t) => ({
    symbol: t.ticker,
    entryDate: t.entryDate,
    closeDate: t.exitDate ?? null,
    netPnl: t.netPnl ?? null,
    pnlPct: t.pnlPct ?? null,
    holdingDays: t.holdingDays ?? null,
    category: t.exitReason,
  }));
```

**maxLossDollar**: PEAD は per-trade SL (`maxLossPct * initialBudget / maxPositions` 等) — initialBudget で代用するか、より精緻に position size × maxLossPct で計算するか runner 内で決める。

**Step**:
1. ファイル作成
2. typecheck + test
3. smoke run (短期 2020-2023 で動作確認)
4. レポート生成確認
5. コミット:
```bash
git add src/backtest/pead/tail-test-thresholds.ts src/backtest/pead/run-tail-test.ts
git commit -m "feat(pead): tail-test thresholds と run-tail-test runner を追加"
```

---

## Task 6: package.json script 追加

**Files:**
- Modify: `package.json`

```json
"tail-test:pead": "tsx src/backtest/pead/run-tail-test.ts",
```

`tail-test:dual-momentum` の隣に配置。

**Smoke** + コミット:
```bash
npm run tail-test:pead -- --start 2020-01-01 --end 2023-12-31
git add package.json
git commit -m "chore(scripts): tail-test:pead を package.json に追加"
```

---

## Task 7: 全期間 tail-test 実行 + レポート生成

**Step 1: 全期間 (2015-01-01〜) で実行**

```bash
npm run tail-test:pead -- --start 2015-01-01
```

期待: 完走、`docs/reports/pead-tail-YYYY-MM-DD.md` 生成。

**Step 2: 結果評価**

ロード: 平時 metrics, DD 上位, stress windows（COVID, Volmageddon, 2022 Bear 等）, verdict。

**Step 3: レポートをコミット**
```bash
git add docs/reports/pead-tail-*.md
git commit -m "report(pead): 全期間 tail-test レポート生成"
```

---

## Task 8: 最終 smoke + design doc 進捗追記

**Step 1: 全テスト + typecheck**
```bash
npm run test && npm run typecheck
```

**Step 2: design doc に Phase 2-A 完了報告追記**

`docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md` の進捗セクションに `Phase 2-A: PEAD (KOH-XXX, 2026-XX-XX 完了)` セクション追記。

**Step 3: コミット**
```bash
git add docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md
git commit -m "docs(portfolio): Phase 2-A (PEAD) 完了報告を design doc に追記"
```

---

## Phase 2-A 完了確認チェックリスト

- [ ] 純関数 ファイル + テスト群が `src/backtest/pead/` に存在
- [ ] simulation refactor 後の数値が refactor 前と一致
- [ ] `pead/tail-test-thresholds.ts` 存在
- [ ] `pead/run-tail-test.ts` 存在
- [ ] `npm run tail-test:pead` で完走
- [ ] レポートが `docs/reports/pead-tail-YYYY-MM-DD.md` に保存
- [ ] 全 vitest tests PASS、typecheck 0 errors
- [ ] framework 側に変更なし（`git diff <base> HEAD -- src/backtest/framework/` で確認）

## YAGNI（Phase 2-A で採用しないもの）

- Walk-Forward analysis（generateUSPeadParameterCombinations は移管しない）
- Survivorship bias 補正
- earnings surprise の実数値抽出（既存 simulation は gap+volume のみ使用）
- 戦略間 portfolio simulation（Phase 4）
- earnings 範囲を 2007 まで拡張（yfinance の earnings 取得限界の可能性、2015〜で十分）
