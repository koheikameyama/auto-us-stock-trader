# Phase 2-B: Momentum (Cross-Sectional) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Phase 1 完了済 framework を使って Cross-Sectional Momentum 戦略を tail-test に通し、portfolio 補完候補としての評価レポートを生成する。Phase 2-A (PEAD) と並列実行可能。

**Architecture:**
1. JP リポから既に bulk migrate 済の `src/backtest/us/us-momentum-*.ts` をベースに、Phase 0/2-A と同じパターンで純関数を `src/backtest/momentum/` に抽出（TDD）
2. simulation.ts 本体は純関数を呼ぶラッパーに refactor
3. データ backfill 確認（S&P500 個別株 2015〜が現実的）
4. `momentum/tail-test-thresholds.ts` を作成
5. `momentum/run-tail-test.ts` を作成（StrategyResult 直接生成、Phase 1 framework 経由）

**Tech Stack:** TypeScript / vitest / Prisma / yfinance / psycopg2

**設計文書:**
- 全体設計: [2026-04-30-portfolio-strategy-evaluation-design.md](2026-04-30-portfolio-strategy-evaluation-design.md)
- Phase 1 (framework 抽象化): [2026-04-30-phase-1-framework-abstraction-implementation-plan.md](2026-04-30-phase-1-framework-abstraction-implementation-plan.md), KOH-456
- Phase 0 (dual-momentum) 参考: [2026-04-30-dual-momentum-phase-0-implementation-plan.md](2026-04-30-dual-momentum-phase-0-implementation-plan.md), KOH-455
- Phase 2-A (PEAD) 並列実行: [2026-04-30-phase-2a-pead-implementation-plan.md](2026-04-30-phase-2a-pead-implementation-plan.md)

---

## 前提条件

- Phase 1 完了済（KOH-456 Done, commit `676426b`）
- JP 移管済コード: `src/backtest/us/us-momentum-{config,run,simulation}.ts` + `us-types.ts` の `USMomentumBacktestConfig` / `USMomentumBacktestResult`
- 既存 backfill scripts: `scripts/data/backfill_daily_bars.py`
- 既存 data-fetcher: `fetchUSHistoricalFromDB`, `fetchVixFromDB`, `fetchSP500FromDB`, `getUSTickerCodes`
- Phase 1 で確立された framework と runner pattern

注: Cross-Sectional Momentum は時系列モメンタムとは異なり、複数銘柄をランキング → 上位 N に投資 → 定期リバランスする戦略。dual-momentum (Antonacci GEM) と概念は近いが、**ETF rotation でなく個別株 universe** を対象とする点が違う。設計 doc では "Momentum (時系列)" と書かれているが、JP 実装は cross-sectional なので実装はそれに従う。

## Phase 2-B 完了基準

- [ ] `src/backtest/momentum/` 配下に純関数 + テストが存在
- [ ] `us-momentum-simulation.ts` が純関数を呼ぶラッパーに refactor 済（数値完全一致）
- [ ] S&P500 個別株 2015〜 が DB に存在
- [ ] `src/backtest/momentum/tail-test-thresholds.ts` 存在
- [ ] `src/backtest/momentum/run-tail-test.ts` 存在
- [ ] `npm run tail-test:momentum` で完走、`docs/reports/momentum-tail-YYYY-MM-DD.md` 生成
- [ ] 全 vitest tests PASS、typecheck 0 errors
- [ ] framework 側に変更なし

---

## Task 1: Pre-flight + ベースライン記録

**Step 1: 全テスト + typecheck**
```bash
npm run test && npm run typecheck
```

**Step 2: 既存 Momentum backtest 動作確認**
```bash
npx tsx src/backtest/us/us-momentum-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/mom-baseline.txt 2>&1
tail -30 /tmp/mom-baseline.txt
```
記録: 主要メトリクス（Total trades / Win Rate / Profit Factor / CAGR / Max DD）。Task 5 で refactor 後と比較。

**Step 3: データ範囲確認**

Local DB SQL:
```sql
SELECT COUNT(DISTINCT "tickerCode") AS tickers, MIN(date), MAX(date), COUNT(*)
FROM auto_us_stock_trader."StockDailyBar";
```

期待: 個別株 universe が 500+ ticker、2015-01-01 以降で十分なデータあり。Phase 2-A と DB 共有。

**Step 4: コミットなし**

---

## Task 2: TDD - Momentum 純関数の抽出

**Files:**
- Create: `src/backtest/momentum/__tests__/`
- Create: `src/backtest/momentum/momentum-ranker.ts`
- Create: `src/backtest/momentum/__tests__/momentum-ranker.test.ts`

**抽出対象（候補、移管時に詳細決定）:**

us-momentum-simulation.ts (418 lines) を読んで以下の純関数を抽出:

1. **`calculateLookbackReturn(prices, lookbackDays) → number | null`**
   - lookbackDays 営業日前 → 直近のリターン率
   - dual-momentum の `pctReturn` と同じパターンだが返り値スケール（%/比率）を確認
   - **既に Phase 0 で `momentum-calculator.ts:pctReturn` を抽出済** — 共通化を検討（DRY）。
   - **判断:** `framework/` 配下に移すか、`momentum/` に独自実装を持つか。**おすすめ:** Phase 0 で抽出した `pctReturn` を `framework/momentum-calculator.ts` に移動して両方が使う形にする（小規模なので問題ないはず）。または momentum で自前定義（YAGNI 寄り）。
   - **このタスクでは pctReturn 統合は YAGNI、`momentum/momentum-calculator.ts` 配下に dual-momentum と同じ実装を持つ**（同じテストもコピー、後続フェーズで DRY 化）

2. **`rankByMomentum(tickers, priceMap, lookbackDays, today) → Ranking[]`**
   - 全 ticker のリターンを計算してソート
   - 純粋: priceMap (Map<ticker, OHLCVData[]>) と config から ranking を生成

3. **`selectTopN(rankings, topN, minReturnPct) → string[]`**
   - 閾値超え + 上位 N を選定

4. **`calculatePositionSize(equity, riskPerTrade, entryPrice, stopPrice)` → `shares`**
   - 既存 simulation の sizing logic を抽出

5. **`evaluateMomentumExit(position, today, currentPrice, atr, holdingDays, config)` → `ExitDecision`**
   - 既存 position の HOLD/CLOSE 判定（trailing stop / time stop / SL / リバランス時の入れ替え）

**Step 1: 失敗テストを書く**（rankByMomentum の例）

```ts
import { describe, it, expect } from "vitest";
import { rankByMomentum } from "../momentum-ranker";

describe("rankByMomentum", () => {
  it("ranks tickers by lookback return descending", () => {
    const priceMap = new Map([
      ["AAPL", [100, 105, 110, 115, 120]], // 20% return over 4 days
      ["MSFT", [200, 195, 190, 185, 180]], // -10% return
      ["GOOG", [50, 55, 60, 65, 70]],      // 40% return
    ].map(([t, prices]) => [t, prices.map((c, i) => ({ date: `2024-01-0${i+1}`, close: c, open: c, high: c, low: c, volume: 0 }))]));

    const rankings = rankByMomentum(["AAPL", "MSFT", "GOOG"], priceMap, 4, "2024-01-05");
    expect(rankings.map((r) => r.ticker)).toEqual(["GOOG", "AAPL", "MSFT"]);
    expect(rankings[0].momentum).toBeCloseTo(40, 1);
  });

  // 4-5 ケース（empty universe, 一部 ticker データ不足等）
});
```

**Step 2-5: TDD 標準フロー（fail → 実装 → pass → commit）**

各純関数で同じパターン。コミットメッセージ例:
```
feat(momentum): rankByMomentum を純関数として TDD 抽出
feat(momentum): selectTopN を純関数として TDD 抽出
feat(momentum): evaluateMomentumExit を純関数として TDD 抽出
```

---

## Task 3: simulation refactor

**Files:**
- Modify: `src/backtest/us/us-momentum-simulation.ts`

**Step 1: 前ベースライン記録**
```bash
npx tsx src/backtest/us/us-momentum-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/mom-before.txt
```

**Step 2: simulation refactor**
- `import { ... } from "../momentum/...";`
- 元の inline ロジックを純関数呼び出しに置換
- 動作完全保持

**Step 3: typecheck + test**
```bash
npm run typecheck && npm run test
```

**Step 4: 数値再現**
```bash
npx tsx src/backtest/us/us-momentum-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/mom-after.txt
diff /tmp/mom-before.txt /tmp/mom-after.txt
```
Expected: 完全一致

**Step 5: コミット**
```bash
git add src/backtest/us/us-momentum-simulation.ts
git commit -m "refactor(momentum): simulation を純関数を呼ぶラッパー化"
```

---

## Task 4: Momentum thresholds 定義

**Files:**
- Create: `src/backtest/momentum/tail-test-thresholds.ts`

```ts
import type { DefaultThresholds } from "../framework/tail-test/pass-fail";

/**
 * Cross-Sectional Momentum 用 tail-test 閾値（Tier 1）。
 * 上下両トレンドで稼げる戦略想定だが、急変局面では losing streak が長引く可能性あり。
 * credit-spread と異なり個別株 universe で vol exposure が低いため低相関期待。
 */
export const MOMENTUM_THRESHOLDS: DefaultThresholds = {
  winRateMin: 0.50,        // momentum で過半勝つ程度
  profitFactorMin: 1.3,
  cagrMin: 0.08,
  maxDrawdownMax: 0.30,
  cvar5MinRatio: 0.5,
  worstWindowDDMax: 0.35,
  worstWindowPnlPctMin: -0.45,
};
```

**コミット**: Task 5 と一緒。

---

## Task 5: run-tail-test.ts 作成

**Files:**
- Create: `src/backtest/momentum/run-tail-test.ts`

参考: `src/backtest/dual-momentum/run-tail-test.ts` template。Phase 2-A (PEAD) と同じ構造。

主要構造:

```ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_MOMENTUM_DEFAULTS } from "../us/us-momentum-config";
import { runUSMomentumBacktest } from "../us/us-momentum-simulation";
import {
  getUSTickerCodes, fetchUSHistoricalFromDB, fetchSP500FromDB, fetchVixFromDB,
} from "../us/us-data-fetcher";
import type { USMomentumBacktestConfig } from "../us/us-types";
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import { MOMENTUM_THRESHOLDS } from "./tail-test-thresholds";

async function main() {
  // arg parsing (start/end/budget/label)
  // データ取得 (tickers + bars + index + vix、earnings は不要)
  // runUSMomentumBacktest 実行
  // SimulatedPosition[] → Trade[] 変換
  // StrategyResult 構築（strategyName: "momentum"）
  // tail-test framework 呼び出し
  // verdict 算出 (MOMENTUM_THRESHOLDS)
  // Markdown レポート出力 → docs/reports/momentum-tail-YYYY-MM-DD.md (Title Case "Momentum" を渡す)
}
```

**Trade 変換**（PEAD と同じ pattern、SimulatedPosition[] → Trade[]）:

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

**Step**: ファイル作成 → typecheck → test → smoke run → commit。

```bash
git add src/backtest/momentum/tail-test-thresholds.ts src/backtest/momentum/run-tail-test.ts
git commit -m "feat(momentum): tail-test thresholds と run-tail-test runner を追加"
```

---

## Task 6: package.json script 追加

```json
"tail-test:momentum": "tsx src/backtest/momentum/run-tail-test.ts",
```

**Smoke** + コミット:
```bash
npm run tail-test:momentum -- --start 2020-01-01 --end 2023-12-31
git add package.json
git commit -m "chore(scripts): tail-test:momentum を package.json に追加"
```

---

## Task 7: 全期間 tail-test 実行 + レポート生成

**Step 1: 全期間 (2015-01-01〜) で実行**

```bash
npm run tail-test:momentum -- --start 2015-01-01
```

**Step 2: 結果評価 + レポートをコミット**
```bash
git add docs/reports/momentum-tail-*.md
git commit -m "report(momentum): 全期間 tail-test レポート生成"
```

---

## Task 8: 最終 smoke + design doc 進捗追記

`docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md` に Phase 2-B 完了報告追記。

```bash
git add docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md
git commit -m "docs(portfolio): Phase 2-B (Momentum) 完了報告を design doc に追記"
```

---

## Phase 2-B 完了確認チェックリスト

- [ ] 純関数ファイル + テスト群が `src/backtest/momentum/` に存在
- [ ] simulation refactor 後の数値が refactor 前と一致
- [ ] `momentum/tail-test-thresholds.ts` 存在
- [ ] `momentum/run-tail-test.ts` 存在
- [ ] `npm run tail-test:momentum` で完走
- [ ] レポートが `docs/reports/momentum-tail-YYYY-MM-DD.md` に保存
- [ ] 全 vitest tests PASS、typecheck 0 errors
- [ ] framework 側に変更なし

## 並列実行時の注意

Phase 2-A (PEAD) と Phase 2-B (Momentum) は独立した戦略フォルダ・別ファイルを作成するため、ファイル衝突は基本的に発生しない。ただし以下の共通ファイルへの同時変更は要注意:

- `package.json` — Task 6 で `tail-test:pead` と `tail-test:momentum` を追加するが、別行に追加すれば衝突しない
- `docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md` — Task 8 で進捗追記、merge conflict 注意（最終的に両方の Phase 2 報告が共存する形）
- `src/backtest/momentum/momentum-calculator.ts` (もし作成するなら) と Phase 0 の `src/backtest/dual-momentum/momentum-calculator.ts` の DRY 化は本 phase ではしない（YAGNI）

## YAGNI（Phase 2-B で採用しないもの）

- Walk-Forward analysis
- Survivorship bias 補正
- 戦略間 portfolio simulation（Phase 4）
- pctReturn の framework 共通化（後続 phase で必要時に整理）
- Time-series momentum 実装（cross-sectional 実装で十分、設計 doc の "時系列" 表記は不正確）
