# SPY Credit Spread BT コード移管 実装プラン (Phase 1)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** JP リポ `auto-stock-trader` の git history (`f1f19e08^`) から SPY Credit Spread バックテストコードを抽出し、`auto-us-stock-trader` リポに移管。`auto_us_stock_trader` schema 構成に合わせて data-fetcher を改変、smoke run で動作確認まで完遂する。

**Architecture:** 移管対象は約 10 ファイル。既存テスト済みの simulation/config/types はそのまま移植（import パス書換のみ）、data-fetcher だけは新スキーマ（market カラム廃止 / IndexDailyBar 分離）に合わせて再実装。Prisma client はシングルトンとして `src/lib/prisma-client.ts` で export。vitest を導入し、新規コード（data-fetcher）にユニットテスト追加。

**Tech Stack:** TypeScript 6, tsx, Prisma 6.19.3, dayjs, vitest

**設計参照:** `docs/plans/2026-04-28-credit-spread-tail-test-design.md` (Section: Phase 1)

**前提:** `package.json` には `prisma`, `@prisma/client`, `tsx`, `typescript`, `dayjs`, `p-limit`, `@types/node` が導入済み。

---

## ロールバック方法（任意の Task で問題発生時）

```bash
# Phase 1 で追加したファイルを全削除して開始前に戻す
cd /Users/kouheikameyama/development/auto-us-stock-trader
git status                          # 変更を確認
git restore --staged src/ tsconfig.json vitest.config.ts package.json package-lock.json 2>/dev/null
rm -rf src/backtest src/lib node_modules/.vitest
git checkout -- package.json package-lock.json tsconfig.json 2>/dev/null
# 既コミット済みの場合: git revert <SHA> または git reset --soft HEAD~N
```

`auto-stock-trader` リポ側は触らない（読み取りのみ）。本リポ側の変更はすべて `git status` で可視。

---

## Task 1: tsconfig.json を追加

**Files:**
- Create: `tsconfig.json`

**Step 1: ファイル作成**

```bash
cat > /Users/kouheikameyama/development/auto-us-stock-trader/tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "vitest.config.ts"],
  "exclude": ["node_modules"]
}
EOF
```

**Step 2: 検証**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: 何も出力されない（src/ がまだ空のため）か、`error TS18003: No inputs were found` のみ

**Step 3: コミット**

```bash
git add tsconfig.json
git commit -m "chore: tsconfig.json を追加（移管準備）"
```

---

## Task 2: src/ ディレクトリ構造を作成

**Files:**
- Create: `src/lib/`, `src/backtest/credit-spread/`, `src/backtest/__tests__/`

**Step 1: ディレクトリ作成**

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
mkdir -p src/lib src/backtest/credit-spread src/backtest/__tests__
```

**Step 2: 検証**

Run: `find src -type d | sort`
Expected: 以下が含まれる
```
src
src/backtest
src/backtest/__tests__
src/backtest/credit-spread
src/lib
```

**Step 3: 既存 `src/.gitkeep` を削除（src/ 配下にファイル追加するため不要）**

```bash
rm -f src/.gitkeep
```

**Step 4: コミットなし**（次タスクで一緒にコミット、空ディレクトリは git で追跡されない）

---

## Task 3: Prisma client シングルトンを作成

**Files:**
- Create: `src/lib/prisma-client.ts`

**Step 1: ファイル作成**

```bash
cat > /Users/kouheikameyama/development/auto-us-stock-trader/src/lib/prisma-client.ts <<'EOF'
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
EOF
```

**Step 2: 型チェック**

Run: `npx tsc --noEmit 2>&1`
Expected: エラーなし（または既存ファイル無関係エラーのみ）

**Step 3: コミット**

```bash
git add src/lib/prisma-client.ts
git commit -m "feat: Prisma client シングルトンを追加"
```

---

## Task 4: options-pricing.ts を JP リポから抽出して配置

**Files:**
- Create: `src/lib/options-pricing.ts`

**Step 1: 抽出**

```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/core/options-pricing.ts > /Users/kouheikameyama/development/auto-us-stock-trader/src/lib/options-pricing.ts
```

**Step 2: 内容確認**

Run: `wc -l /Users/kouheikameyama/development/auto-us-stock-trader/src/lib/options-pricing.ts`
Expected: 100 行以上のファイルが存在する（BS pricing + findStrikeForTargetDelta）

Run: `grep -E "^export (function|const)" /Users/kouheikameyama/development/auto-us-stock-trader/src/lib/options-pricing.ts`
Expected: `bsPutPrice`, `bsCallPrice`, `findStrikeForTargetDelta` 等が含まれる

**Step 3: import 確認**

Run: `grep "^import" /Users/kouheikameyama/development/auto-us-stock-trader/src/lib/options-pricing.ts`
Expected: 外部依存なし、または `dayjs` 等の既導入パッケージのみ

**Step 4: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし

**Step 5: コミット**

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
git add src/lib/options-pricing.ts
git commit -m "feat: options-pricing を JP リポから移管（BS pricing）"
```

---

## Task 5: backtest/types.ts を新規作成（必要部分のみ抜粋）

**Files:**
- Create: `src/backtest/types.ts`

**Step 1: JP の types.ts と関連型定義を確認**

Run:
```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/types.ts | grep -A 50 "interface SimulatedPosition\|interface DailyEquity\|interface PerformanceMetrics\|^export "
```

`SimulatedPosition`, `DailyEquity`, `PerformanceMetrics` の定義位置と内容を把握する。

**Step 2: 必要部分だけ抽出して新規作成**

`SimulatedPosition`, `DailyEquity`, `PerformanceMetrics`, および付随する小型 type alias（exitReason 等）のみを抜粋した最小ファイルを作成。Credit Spread 専用のため、ブレイクアウト/その他戦略の type は含めない。

参考実装（実際の内容は JP の types.ts に従う）:

```typescript
// src/backtest/types.ts
export type ExitReason =
  | "take_profit"
  | "stop_loss"
  | "time_stop"
  | "still_open";

export interface SimulatedPosition {
  ticker: string;
  entryDate: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  quantity: number;
  volumeSurgeRatio: number;
  regime: string | null;
  maxHighDuringHold: number;
  minLowDuringHold: number;
  trailingStopPrice: number | null;
  entryAtr: number | null;
  exitDate: string | null;
  exitPrice: number;
  exitReason: ExitReason;
  pnl: number;
  pnlPct: number;
  holdingDays: number;
  limitLockDays: number;
  entryCommission: number;
  exitCommission: number;
  totalCost: number;
  tax: number;
  grossPnl: number;
  netPnl: number;
}

export interface DailyEquity {
  date: string;
  cash: number;
  positionsValue: number;
  totalEquity: number;
  openPositionCount: number;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgHoldingDays: number;
  maxDrawdown: number;
  sharpeRatio: number | null;
  totalGrossPnl: number;
  totalCommission: number;
  totalNetPnl: number;
  netReturnPct: number;
}
```

**注意:** 上記は仮実装。JP の types.ts の実物と必ず一致させる（フィールド漏れがあると後段の simulation.ts で型エラーになる）。Step 1 で確認した内容で必要に応じて補正。

**Step 3: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし

**Step 4: コミット**

```bash
git add src/backtest/types.ts
git commit -m "feat: backtest 共通 types を追加（必要部分抜粋）"
```

---

## Task 6: backtest/metrics.ts を新規作成（calculateMetrics のみ）

**Files:**
- Create: `src/backtest/metrics.ts`

**Step 1: JP の metrics.ts を確認**

Run:
```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/metrics.ts | head -100
```

**Step 2: calculateMetrics 関数だけを抽出**

`calculateMetrics(trades, equityCurve, initialBudget): PerformanceMetrics` を抜粋。依存する private ヘルパーがあれば一緒に持ってくる。`SimulatedPosition`, `DailyEquity`, `PerformanceMetrics` は `./types` から import に書換える。

```bash
# JP のファイルをコピー → import パスを書換
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/metrics.ts > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/metrics.ts

cd /Users/kouheikameyama/development/auto-us-stock-trader
# JP 側の types.ts は同じ階層なので "./types" のまま、変更不要
# 不要な戦略専用 helper があれば手動削除（DRY: 必要なものだけ残す）
```

**Step 3: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし。エラーが出る場合は types.ts に不足フィールドがあるので Task 5 を補完。

**Step 4: コミット**

```bash
git add src/backtest/metrics.ts
git commit -m "feat: calculateMetrics を JP リポから移管"
```

---

## Task 7: credit-spread/types.ts を移管

**Files:**
- Create: `src/backtest/credit-spread/types.ts`

**Step 1: 抽出**

```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/us/us-credit-spread-types.ts > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/credit-spread/types.ts
```

**Step 2: import パス書換**

Run:
```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
sed -i '' 's|from "../types"|from "../types"|' src/backtest/credit-spread/types.ts
# 一階層深くなったので "../types" → "../types" は変わらない（src/backtest/credit-spread/ → src/backtest/types は ../types で OK）
# 念のため確認:
grep "^import" src/backtest/credit-spread/types.ts
```

Expected: `import type { DailyEquity, PerformanceMetrics } from "../types";`

**Step 3: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし

**Step 4: コミット**

```bash
git add src/backtest/credit-spread/types.ts
git commit -m "feat: credit-spread types を移管"
```

---

## Task 8: credit-spread/config.ts を移管

**Files:**
- Create: `src/backtest/credit-spread/config.ts`

**Step 1: 抽出**

```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/us/us-credit-spread-config.ts > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/credit-spread/config.ts
```

**Step 2: import パス書換 + 名前変更**

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
sed -i '' 's|from "./us-credit-spread-types"|from "./types"|' src/backtest/credit-spread/config.ts

# 確認
grep -E "^import|^export" src/backtest/credit-spread/config.ts
```

Expected:
- `import type { USCreditSpreadBacktestConfig } from "./types";`
- `export const US_CREDIT_SPREAD_DEFAULTS`
- `export const US_CREDIT_SPREAD_PARAMETER_GRID`
- `export function generateUSCreditSpreadParameterCombinations`

**Step 3: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし

**Step 4: コミット**

```bash
git add src/backtest/credit-spread/config.ts
git commit -m "feat: credit-spread config を移管"
```

---

## Task 9: credit-spread/simulation.ts を移管

**Files:**
- Create: `src/backtest/credit-spread/simulation.ts`

**Step 1: 抽出**

```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/us/us-credit-spread-simulation.ts > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/credit-spread/simulation.ts
```

**Step 2: import パス書換**

JP 側の元 import は:
```ts
import { bsPutPrice, findStrikeForTargetDelta } from "../../core/options-pricing";
import { calculateMetrics } from "../metrics";
import type { USCreditSpreadBacktestConfig, USCreditSpreadBacktestResult, SimulatedSpread, CreditSpreadPerformanceMetrics } from "./us-credit-spread-types";
import type { SimulatedPosition, DailyEquity } from "../types";
```

これを以下に書換:
```ts
import { bsPutPrice, findStrikeForTargetDelta } from "../../lib/options-pricing";
import { calculateMetrics } from "../metrics";
import type { USCreditSpreadBacktestConfig, USCreditSpreadBacktestResult, SimulatedSpread, CreditSpreadPerformanceMetrics } from "./types";
import type { SimulatedPosition, DailyEquity } from "../types";
```

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
sed -i '' \
  -e 's|from "../../core/options-pricing"|from "../../lib/options-pricing"|' \
  -e 's|from "./us-credit-spread-types"|from "./types"|' \
  src/backtest/credit-spread/simulation.ts

# 確認
grep "^import" src/backtest/credit-spread/simulation.ts
```

**Step 3: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -20`
Expected: エラーなし。エラー出る場合は types.ts / metrics.ts のフィールド欠落の可能性 → 該当 Task に戻って補完。

**Step 4: コミット**

```bash
git add src/backtest/credit-spread/simulation.ts
git commit -m "feat: credit-spread simulation を移管"
```

---

## Task 10: data-fetcher.ts を新規実装（新スキーマ対応）

**Files:**
- Create: `src/backtest/data-fetcher.ts`
- Test: `src/backtest/__tests__/data-fetcher.test.ts`

**設計のポイント:**
- 旧 `market='US'` フィルターは廃止（schema 自体が US 専用）
- `^GSPC` / `^VIX` は `IndexDailyBar` テーブルから取得（旧設計では `StockDailyBar (market='INDEX')`）
- API 名は新リポ用に簡潔化（`fetchUSHistoricalFromDB` → `fetchHistoricalFromDB` 等）

**Step 1: failing テストを先に書く**

```bash
cat > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/__tests__/data-fetcher.test.ts <<'EOF'
import { describe, it, expect } from "vitest";
import {
  fetchSP500FromDB,
  fetchVixFromDB,
  fetchHistoricalFromDB,
} from "../data-fetcher";

describe("data-fetcher (smoke)", () => {
  it("fetchSP500FromDB returns Map<string, number> for known range", async () => {
    const result = await fetchSP500FromDB("2024-01-02", "2024-01-31");
    expect(result.size).toBeGreaterThan(0);
    // 1 月の最初の取引日は 2024-01-02
    const firstClose = result.get("2024-01-02");
    expect(firstClose).toBeGreaterThan(4000); // ^GSPC は 4000+ で推移
    expect(firstClose).toBeLessThan(8000);
  });

  it("fetchVixFromDB returns Map<string, number>", async () => {
    const result = await fetchVixFromDB("2024-01-02", "2024-01-31");
    expect(result.size).toBeGreaterThan(0);
    const firstVix = [...result.values()][0];
    expect(firstVix).toBeGreaterThan(5);
    expect(firstVix).toBeLessThan(80); // 平時の VIX 範囲
  });

  it("fetchHistoricalFromDB returns OHLCV data for given tickers", async () => {
    const result = await fetchHistoricalFromDB(["AAPL"], "2024-01-02", "2024-01-31");
    expect(result.has("AAPL")).toBe(true);
    const aaplBars = result.get("AAPL")!;
    expect(aaplBars.length).toBeGreaterThan(15); // 1月は ~21 取引日
    expect(aaplBars[0]).toMatchObject({
      date: expect.any(String),
      open: expect.any(Number),
      close: expect.any(Number),
    });
  });
});
EOF
```

**Step 2: テストを走らせて失敗を確認**

(vitest はまだ Task 11 で導入するので、ここではテストファイルのみ準備して次のタスクで実行する)

**Step 3: data-fetcher.ts を実装**

```bash
cat > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/data-fetcher.ts <<'EOF'
/**
 * バックテスト用データ取得（auto_us_stock_trader schema）
 *
 * - 個別株 OHLCV: StockDailyBar
 * - 指数 OHLCV: IndexDailyBar (^GSPC, ^VIX 等)
 * - 決算日: EarningsDate
 *
 * schema が US 専用のため market カラム不要。
 */

import dayjs from "dayjs";
import { prisma } from "../lib/prisma-client";

export interface OHLCVData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 個別株 OHLCV を一括取得（lookback 日数分も含む）
 */
export async function fetchHistoricalFromDB(
  tickerCodes: string[],
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, OHLCVData[]>> {
  const adjustedStart = dayjs(startDate)
    .subtract(lookbackDays, "day")
    .format("YYYY-MM-DD");

  const rows = await prisma.stockDailyBar.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      date: {
        gte: new Date(`${adjustedStart}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
    select: {
      tickerCode: true,
      date: true,
      open: true,
      high: true,
      low: true,
      close: true,
      volume: true,
    },
  });

  const results = new Map<string, OHLCVData[]>();
  for (const row of rows) {
    const ticker = row.tickerCode;
    if (!results.has(ticker)) results.set(ticker, []);
    results.get(ticker)!.push({
      date: dayjs(row.date).format("YYYY-MM-DD"),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: Number(row.volume),
    });
  }
  return results;
}

/**
 * 指数 close を Map<date, close> で取得
 */
export async function fetchIndexFromDB(
  tickerCode: string,
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, number>> {
  const adjustedStart = dayjs(startDate)
    .subtract(lookbackDays, "day")
    .format("YYYY-MM-DD");

  const rows = await prisma.indexDailyBar.findMany({
    where: {
      tickerCode,
      date: {
        gte: new Date(`${adjustedStart}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    orderBy: { date: "asc" },
    select: { date: true, close: true },
  });

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(dayjs(row.date).format("YYYY-MM-DD"), row.close);
  }
  return map;
}

/**
 * S&P 500 (^GSPC) の close を取得
 */
export async function fetchSP500FromDB(
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, number>> {
  return fetchIndexFromDB("^GSPC", startDate, endDate, lookbackDays);
}

/**
 * VIX (^VIX) の close を取得
 */
export async function fetchVixFromDB(
  startDate: string,
  endDate: string,
  lookbackDays = 120,
): Promise<Map<string, number>> {
  return fetchIndexFromDB("^VIX", startDate, endDate, lookbackDays);
}

/**
 * 決算日データ取得（tickerCode → Set<date>）
 */
export async function fetchEarningsFromDB(
  tickerCodes: string[],
  startDate: string,
  endDate: string,
): Promise<Map<string, Set<string>>> {
  const rows = await prisma.earningsDate.findMany({
    where: {
      tickerCode: { in: tickerCodes },
      date: {
        gte: new Date(`${startDate}T00:00:00Z`),
        lte: new Date(`${endDate}T00:00:00Z`),
      },
    },
    select: { tickerCode: true, date: true },
  });

  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!result.has(row.tickerCode)) result.set(row.tickerCode, new Set());
    result.get(row.tickerCode)!.add(dayjs(row.date).format("YYYY-MM-DD"));
  }
  return result;
}
EOF
```

**Step 4: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし

**Step 5: コミット（テストはまだ走らせない、Task 11 で）**

```bash
git add src/backtest/data-fetcher.ts src/backtest/__tests__/data-fetcher.test.ts
git commit -m "feat: data-fetcher を新スキーマ向けに実装

- StockDailyBar / IndexDailyBar の分離に対応
- market カラム廃止
- API 名を簡潔化（fetchHistoricalFromDB 等）

ユニットテストは vitest 導入後（次タスク）で実行。"
```

---

## Task 11: vitest を導入してテスト実行

**Files:**
- Modify: `package.json` （devDeps + scripts 追加）
- Create: `vitest.config.ts`

**Step 1: vitest をインストール**

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
npm install -D vitest
```

Expected: `package-lock.json` 更新、エラーなし

**Step 2: vitest.config.ts を作成**

```bash
cat > vitest.config.ts <<'EOF'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30000,
    include: ["src/**/*.test.ts"],
  },
});
EOF
```

**Step 3: package.json に test script 追加**

`package.json` の `scripts` に以下を追加:

```json
"test": "vitest run",
"test:watch": "vitest"
```

```bash
# 手動編集 or Edit ツールで package.json 修正
```

**Step 4: テスト実行**

Run: `npm test`
Expected: data-fetcher.test.ts の 3 件すべて PASS（ローカル DB に AAPL, ^GSPC, ^VIX のデータが入っている前提、KOH-446 で完了済み）

エラーが出る場合:
- "Cannot find module '@prisma/client'" → `npm install` 漏れ
- "tickerCode of undefined" → Prisma generate 漏れ → `npx prisma generate` を先に実行
- `expected size to be greater than 0` → ローカル DB の auto_us_stock_trader schema に AAPL 等のデータがない

**Step 5: コミット**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: vitest を導入してテスト実行可能に"
```

---

## Task 12: credit-spread/run.ts を移管

**Files:**
- Create: `src/backtest/credit-spread/run.ts`

**Step 1: 抽出**

```bash
cd /Users/kouheikameyama/development/auto-stock-trader
git show f1f19e08^:src/backtest/us/us-credit-spread-run.ts > /Users/kouheikameyama/development/auto-us-stock-trader/src/backtest/credit-spread/run.ts
```

**Step 2: import パス書換**

JP 側の元 import:
```ts
import { US_CREDIT_SPREAD_DEFAULTS } from "./us-credit-spread-config";
import { runUSCreditSpreadBacktest } from "./us-credit-spread-simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "./us-data-fetcher";
import type { USCreditSpreadBacktestConfig } from "./us-credit-spread-types";
```

これを以下に書換:
```ts
import { US_CREDIT_SPREAD_DEFAULTS } from "./config";
import { runUSCreditSpreadBacktest } from "./simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "../data-fetcher";
import type { USCreditSpreadBacktestConfig } from "./types";
```

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
sed -i '' \
  -e 's|from "./us-credit-spread-config"|from "./config"|' \
  -e 's|from "./us-credit-spread-simulation"|from "./simulation"|' \
  -e 's|from "./us-data-fetcher"|from "../data-fetcher"|' \
  -e 's|from "./us-credit-spread-types"|from "./types"|' \
  src/backtest/credit-spread/run.ts

# 確認
grep "^import" src/backtest/credit-spread/run.ts
```

**Step 3: 型チェック**

Run: `npx tsc --noEmit 2>&1 | grep -i error | head -10`
Expected: エラーなし

**Step 4: コミット**

```bash
git add src/backtest/credit-spread/run.ts
git commit -m "feat: credit-spread run.ts を移管（CLI エントリーポイント）"
```

---

## Task 13: Smoke run（エンドツーエンドの動作確認）

**Files:** なし（実行のみ）

**Step 1: tsx で run.ts を実行**

Run:
```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
npx tsx src/backtest/credit-spread/run.ts --start 2024-01-01 --end 2024-12-31
```

Expected output（観測値の桁感）:
- ヘッダー: `SPY Credit Spread Backtest - US (Bull Put)`
- `^GSPC: 100+ days`, `VIX: 100+ days` のロード
- `Total Spreads:` の数字（10〜30 程度を想定、2024年は穏やか）
- `Win Rate:` 60〜90% の範囲
- `Profit Factor:` 1.0〜3.0 の範囲
- `Net P&L:` $ 数値
- 最後にエラーなしで終了

**Step 2: エラー時の対処**

エラーパターン別:

| エラー | 原因 | 対処 |
|---|---|---|
| `Cannot find module './config'` | import パス書換漏れ | Task 12 を再確認 |
| `prisma.indexDailyBar.findMany is not a function` | Prisma client 未生成 | `npx prisma generate` |
| `^GSPC: 0 days` | DB に IndexDailyBar データなし | KOH-446 完了確認、ローカル DB に再投入 |
| `Type error: Property 'X' is missing` | types.ts のフィールド欠落 | Task 5 を補完 |
| `calculateMetrics is not a function` | metrics.ts の export 漏れ | Task 6 を確認 |

**Step 3: 結果が妥当ならコミット（実装変更なし、検証ログのみ）**

```bash
# 必要なら実行ログを残すコミットメッセージにする
git commit --allow-empty -m "verify: credit-spread smoke run 成功（2024年フル）

Total Spreads / Win Rate / Net P&L が妥当な範囲で出力されることを確認。"
```

---

## Task 14: data-fetcher のユニットテストを再走らせて全 PASS 確認

**Files:** なし（実行のみ）

**Step 1: テスト実行**

Run: `npm test`
Expected: すべて PASS、`Test Files  1 passed (1)`, `Tests  3 passed (3)`

**Step 2: エラー時の対処**

| エラー | 対処 |
|---|---|
| timeout | `vitest.config.ts` の `testTimeout` を増やす（DB 接続が遅い場合） |
| データなしで失敗 | KOH-446 でローカル DB に投入したデータが残っているか確認 |

**Step 3: コミットなし**（既コミット済み）

---

## Task 15: 最終チェック + Linear タスク更新

**Files:** なし（手動確認）

**Step 1: 全体構造確認**

Run:
```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
find src -type f -name "*.ts" | sort
```

Expected:
```
src/backtest/__tests__/data-fetcher.test.ts
src/backtest/credit-spread/config.ts
src/backtest/credit-spread/run.ts
src/backtest/credit-spread/simulation.ts
src/backtest/credit-spread/types.ts
src/backtest/data-fetcher.ts
src/backtest/metrics.ts
src/backtest/types.ts
src/lib/options-pricing.ts
src/lib/prisma-client.ts
```

**Step 2: 型チェック / テスト総合確認**

Run:
```bash
npx tsc --noEmit && npm test
```
Expected: 両方エラーなし

**Step 3: ロードマップに移管完了を反映**

`docs/database-schema.md` のロードマップ項目 5「📋 バックテストコード本リポへ移管」のステータス確認（必要なら更新するが、Phase 1 のみ完了であり、他戦略は移管していないので「📋」のままでよい）。

**Step 4: Linear タスク更新**

KOH-447（予定）を作成・Done にする、または既存があれば更新。

```bash
# Linear MCP 経由（claude code CLI セッションから）:
# - KOH-447 を作成して Done に。description は本プランへのリンク。
# - KOH-446 と「Phase 1 完了」を関連 issue として相互参照。
```

**Step 5: 最終コミット（プラン完了マーカー）**

```bash
git commit --allow-empty -m "chore: Phase 1 (Credit Spread BT 移管) 完了

詳細: docs/plans/2026-04-28-credit-spread-migration-plan.md
次フェーズ: KOH-448 (2007〜 backfill), KOH-449 (テール検証実装)"
```

---

## 全 Task 完了基準

- ✅ `find src -type f -name "*.ts"` で 10 ファイル存在
- ✅ `npx tsc --noEmit` がエラーなし
- ✅ `npm test` がすべて PASS（3 tests）
- ✅ `npx tsx src/backtest/credit-spread/run.ts --start 2024-01-01 --end 2024-12-31` がエラーなく完走、勝率や PnL が出力される
- ✅ git history が読みやすい（1 タスク = 1 コミット が基本）
- ✅ ロールバック手順が機能する（git history から各タスクを revert 可能）

## DRY / YAGNI 原則の確認

- 移管しないファイル（dual-momentum, gapup, mean-reversion, pead, vix-contango, wheel, momentum 等）には手をつけない
- `us-types.ts`（他戦略用、Credit Spread 不要）は移管しない
- WF スクリプトは移管しない
- BS pricing のテストは書かない（JP 側で検証済）
- E2E テストは smoke run のみ（自動化しない）

## 次フェーズへの引き継ぎ

Phase 1 完了後、以下を別プランで実装:
- **Phase 2 (KOH-448):** `scripts/data/backfill_index_long.py` で 2007〜 SPY/^GSPC/^VIX を投入
- **Phase 3 (KOH-449):** `src/backtest/tail-test/` 配下を TDD で実装、検証実行 + レポート出力

両者とも `docs/plans/2026-04-28-credit-spread-tail-test-design.md` Section 3 / 4-7 に詳細あり。
