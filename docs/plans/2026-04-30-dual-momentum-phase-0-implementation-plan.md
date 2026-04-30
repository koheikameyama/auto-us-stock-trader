# Dual Momentum Phase 0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dual Momentum (Antonacci GEM) を本リポで動作可能にし、credit-spread の tail-test framework に「手動配線」して評価レポートを生成する。framework 抽象化（Phase 1）の前段階として "実例 1 つ" を完成させる。

**Architecture:** JP リポから既に bulk migrate 済みの `src/backtest/us/us-dual-momentum-*.ts` をベースに、credit-spread と同じ pattern で純関数を `src/backtest/dual-momentum/` に抽出（TDD）。元の simulation.ts は純関数を呼ぶラッパーに置き換える。tail-test 適用は dual-momentum result を credit-spread の `SimulatedSpread[]` 互換 shape に adapt する thin wrapper を作って既存 framework に流す。

**Tech Stack:** TypeScript / vitest / Prisma / yfinance / psycopg2

**設計文書:** [docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md](2026-04-30-portfolio-strategy-evaluation-design.md)

---

## 前提条件

- JP リポからの dual-momentum コードは既に `src/backtest/us/us-dual-momentum-*.ts` に存在
- credit-spread の純関数抽出 pattern が `src/backtest/credit-spread/{dd-stop,signal-generator,spread-evaluator}.ts` に存在（参考実装）
- tail-test framework は `src/backtest/tail-test/` で credit-spread 専用に動作中
- 既存 `scripts/data/backfill_rotation_etfs.py` は SPY/EFA/AGG 等を 10 年分 backfill する
- vitest は導入済み

## Phase 0 完了基準

- [ ] `src/backtest/dual-momentum/` 配下に純関数 3 つ + テストが存在
- [ ] `us-dual-momentum-simulation.ts` がそれら純関数を呼ぶ形に refactor 済み
- [ ] rotation ETFs (SPY/EFA/AGG) が 2007-01-01〜 で local + Railway DB に存在
- [ ] `tail-test:dual-momentum` が package.json に追加され、実行可能
- [ ] `docs/reports/dual-momentum-tail-YYYY-MM-DD.md` が生成され、最低限 base metrics + DD ranking + stress windows 表が記録されている
- [ ] 全 vitest テストが PASS

---

## Task 1: 作業ディレクトリ作成と pre-flight check

**Files:**
- Create: `src/backtest/dual-momentum/__tests__/.gitkeep`（必要なら）

**Step 1: 既存テスト pass を確認**

Run: `npm run test`
Expected: 全 PASS（credit-spread 既存テスト群が通る）

**Step 2: typecheck 通過確認**

Run: `npm run typecheck`
Expected: 0 errors

**Step 3: 既存 dual-momentum backtest が動くか確認**

Run: `npx tsx src/backtest/us/us-dual-momentum-run.ts --start 2020-01-01 --end 2023-12-31`
Expected: 完走（"Results" セクションが出力される）。失敗したら原因を特定して修正してから次へ。

**Step 4: ディレクトリ作成**

Run: `mkdir -p src/backtest/dual-momentum/__tests__`

**Step 5: コミットなし**（インフラ作業のみ、次タスクと一緒にコミット）

---

## Task 2: TDD - pctReturn 純関数の抽出

**Files:**
- Create: `src/backtest/dual-momentum/momentum-calculator.ts`
- Create: `src/backtest/dual-momentum/__tests__/momentum-calculator.test.ts`

**抽出対象:** `src/backtest/us/us-dual-momentum-simulation.ts` の `pctReturn(prices, lookback)`

**Step 1: 失敗するテストを書く**

```ts
// src/backtest/dual-momentum/__tests__/momentum-calculator.test.ts
import { describe, it, expect } from "vitest";
import { pctReturn } from "../momentum-calculator";

describe("pctReturn", () => {
  it("returns positive percentage when current price is higher than lookback", () => {
    const prices = [100, 101, 102, 103, 110]; // lookback=4: (110-100)/100 * 100 = 10%
    expect(pctReturn(prices, 4)).toBeCloseTo(10, 5);
  });

  it("returns negative percentage when current price is lower than lookback", () => {
    const prices = [100, 99, 95, 92, 90]; // lookback=4: (90-100)/100 * 100 = -10%
    expect(pctReturn(prices, 4)).toBeCloseTo(-10, 5);
  });

  it("returns null when prices array is shorter than lookback+1", () => {
    expect(pctReturn([100, 101, 102], 4)).toBeNull();
  });

  it("returns null when past price is zero or negative", () => {
    expect(pctReturn([0, 100, 110], 2)).toBeNull();
    expect(pctReturn([-1, 100, 110], 2)).toBeNull();
  });

  it("uses the most recent price as numerator", () => {
    const prices = [50, 60, 70, 80, 100, 120];
    // lookback=5: (120-50)/50 * 100 = 140
    expect(pctReturn(prices, 5)).toBeCloseTo(140, 5);
  });
});
```

**Step 2: テストを走らせて失敗を確認**

Run: `npx vitest run src/backtest/dual-momentum/__tests__/momentum-calculator.test.ts`
Expected: FAIL（モジュールが存在しない）

**Step 3: 最小実装**

```ts
// src/backtest/dual-momentum/momentum-calculator.ts
/**
 * lookback 営業日前 → 直近のパーセントリターン（%）
 * データ不足や past price ≤ 0 の場合は null
 */
export function pctReturn(prices: number[], lookback: number): number | null {
  if (prices.length < lookback + 1) return null;
  const recent = prices[prices.length - 1];
  const past = prices[prices.length - 1 - lookback];
  if (past <= 0) return null;
  return ((recent - past) / past) * 100;
}
```

**Step 4: テスト pass を確認**

Run: `npx vitest run src/backtest/dual-momentum/__tests__/momentum-calculator.test.ts`
Expected: 5/5 PASS

**Step 5: コミット**

```bash
git add src/backtest/dual-momentum/momentum-calculator.ts src/backtest/dual-momentum/__tests__/momentum-calculator.test.ts
git commit -m "feat(dual-momentum): pctReturn を純関数として TDD 抽出"
```

---

## Task 3: TDD - selectMomentumAsset 純関数

**Files:**
- Create: `src/backtest/dual-momentum/asset-selector.ts`
- Create: `src/backtest/dual-momentum/__tests__/asset-selector.test.ts`

**抽出対象:** `us-dual-momentum-simulation.ts` の rankings ソート + best_equity / risk_off 判定ロジック。

**Step 1: 失敗するテストを書く**

```ts
// src/backtest/dual-momentum/__tests__/asset-selector.test.ts
import { describe, it, expect } from "vitest";
import { selectMomentumAsset } from "../asset-selector";

describe("selectMomentumAsset", () => {
  const riskOff = "AGG";

  it("selects highest-momentum equity when above threshold", () => {
    const result = selectMomentumAsset(
      [
        { ticker: "SPY", momentum: 12.0 },
        { ticker: "EFA", momentum: 8.0 },
      ],
      0,
      riskOff
    );
    expect(result.selected).toBe("SPY");
    expect(result.reason).toBe("best_equity");
    expect(result.sortedRankings[0].ticker).toBe("SPY");
  });

  it("selects risk-off when all equities below threshold", () => {
    const result = selectMomentumAsset(
      [
        { ticker: "SPY", momentum: -5.0 },
        { ticker: "EFA", momentum: -3.0 },
      ],
      0,
      riskOff
    );
    expect(result.selected).toBe("AGG");
    expect(result.reason).toBe("risk_off");
  });

  it("selects risk-off when rankings array is empty", () => {
    const result = selectMomentumAsset([], 0, riskOff);
    expect(result.selected).toBe("AGG");
    expect(result.reason).toBe("risk_off");
    expect(result.sortedRankings).toEqual([]);
  });

  it("respects positive threshold (e.g., +5%)", () => {
    const result = selectMomentumAsset(
      [{ ticker: "SPY", momentum: 3.0 }],
      5,
      riskOff
    );
    expect(result.selected).toBe("AGG");
    expect(result.reason).toBe("risk_off");
  });

  it("sorts rankings descending by momentum", () => {
    const result = selectMomentumAsset(
      [
        { ticker: "EFA", momentum: 5.0 },
        { ticker: "SPY", momentum: 12.0 },
        { ticker: "QQQ", momentum: 8.0 },
      ],
      0,
      riskOff
    );
    expect(result.sortedRankings.map((r) => r.ticker)).toEqual(["SPY", "QQQ", "EFA"]);
  });
});
```

**Step 2: テストを走らせて失敗を確認**

Run: `npx vitest run src/backtest/dual-momentum/__tests__/asset-selector.test.ts`
Expected: FAIL

**Step 3: 最小実装**

```ts
// src/backtest/dual-momentum/asset-selector.ts
export interface MomentumRanking {
  ticker: string;
  momentum: number;
}

export interface AssetSelectionResult {
  selected: string;
  reason: "best_equity" | "risk_off";
  sortedRankings: MomentumRanking[];
}

/**
 * モメンタムランキングと絶対モメンタム閾値から保有資産を選択。
 * 最高モメンタムが閾値を超えていれば株式、そうでなければ risk-off へ退避。
 */
export function selectMomentumAsset(
  rankings: MomentumRanking[],
  absoluteMomentumThreshold: number,
  riskOffAsset: string
): AssetSelectionResult {
  const sorted = [...rankings].sort((a, b) => b.momentum - a.momentum);

  if (sorted.length > 0 && sorted[0].momentum > absoluteMomentumThreshold) {
    return { selected: sorted[0].ticker, reason: "best_equity", sortedRankings: sorted };
  }
  return { selected: riskOffAsset, reason: "risk_off", sortedRankings: sorted };
}
```

**Step 4: テスト pass を確認**

Run: `npx vitest run src/backtest/dual-momentum/__tests__/asset-selector.test.ts`
Expected: 5/5 PASS

**Step 5: コミット**

```bash
git add src/backtest/dual-momentum/asset-selector.ts src/backtest/dual-momentum/__tests__/asset-selector.test.ts
git commit -m "feat(dual-momentum): selectMomentumAsset を純関数として TDD 抽出"
```

---

## Task 4: TDD - calculateRebalanceOrder 純関数

**Files:**
- Create: `src/backtest/dual-momentum/order-calculator.ts`
- Create: `src/backtest/dual-momentum/__tests__/order-calculator.test.ts`

**抽出対象:** `us-dual-momentum-simulation.ts` の cash → shares 変換 (買い) と shares → cash 変換 (売り)。slippage と commission を含む。

**Step 1: 失敗するテストを書く**

```ts
// src/backtest/dual-momentum/__tests__/order-calculator.test.ts
import { describe, it, expect } from "vitest";
import { calculateBuyOrder, calculateSellOrder } from "../order-calculator";

describe("calculateBuyOrder", () => {
  it("calculates shares with slippage and commission deducted", () => {
    // cash=10000, price=100, slip=0.05% (=5), commission=1
    // usableCash = 10000 - 1 - 5 = 9994
    // shares = floor(9994 / 100) = 99
    // cashRemaining = 10000 - 99*100 - 1 - 5 = 99
    const result = calculateBuyOrder(10000, 100, 0.05, 1);
    expect(result.shares).toBe(99);
    expect(result.slippage).toBeCloseTo(5, 5);
    expect(result.commission).toBe(1);
    expect(result.cashRemaining).toBeCloseTo(94, 5);
  });

  it("returns 0 shares when cash is insufficient even for one share", () => {
    const result = calculateBuyOrder(50, 100, 0.05, 1);
    expect(result.shares).toBe(0);
  });

  it("uses floor for fractional shares", () => {
    const result = calculateBuyOrder(1000, 99, 0.0, 0);
    // floor(1000 / 99) = 10 (NOT 10.1)
    expect(result.shares).toBe(10);
  });

  it("zero slippage and zero commission edge case", () => {
    const result = calculateBuyOrder(1000, 100, 0, 0);
    expect(result.shares).toBe(10);
    expect(result.cashRemaining).toBeCloseTo(0, 5);
  });
});

describe("calculateSellOrder", () => {
  it("calculates net cash received with slippage and commission deducted", () => {
    // shares=100, price=110, slip=0.05% (5.5), commission=1
    // proceeds = 100*110 = 11000
    // cashReceived = 11000 - 1 - 5.5 = 10993.5
    const result = calculateSellOrder(100, 110, 0.05, 1);
    expect(result.proceeds).toBe(11000);
    expect(result.slippage).toBeCloseTo(5.5, 5);
    expect(result.commission).toBe(1);
    expect(result.cashReceived).toBeCloseTo(10993.5, 5);
  });

  it("zero shares returns zero across all fields", () => {
    const result = calculateSellOrder(0, 100, 0.05, 1);
    expect(result.proceeds).toBe(0);
    expect(result.cashReceived).toBeCloseTo(-1, 5); // commission still subtracted
    // Note: design choice — 0 shares should likely skip the order entirely upstream.
    // We document the math but caller must guard against 0-share calls.
  });
});
```

**Step 2: テストを走らせて失敗を確認**

Run: `npx vitest run src/backtest/dual-momentum/__tests__/order-calculator.test.ts`
Expected: FAIL

**Step 3: 最小実装**

```ts
// src/backtest/dual-momentum/order-calculator.ts
export interface BuyOrderResult {
  shares: number;
  slippage: number;
  commission: number;
  cashRemaining: number;
}

export interface SellOrderResult {
  proceeds: number;
  slippage: number;
  commission: number;
  cashReceived: number;
}

/**
 * cash と price から購入株数を計算（slippage % と commission $ を控除）。
 * 端数は切り捨て（floor）。
 */
export function calculateBuyOrder(
  cash: number,
  price: number,
  slippagePct: number,
  commission: number
): BuyOrderResult {
  const slippage = cash * (slippagePct / 100);
  const usableCash = cash - commission - slippage;
  const shares = Math.max(0, Math.floor(usableCash / price));
  const cashRemaining = cash - shares * price - commission - slippage;
  return { shares, slippage, commission, cashRemaining };
}

/**
 * shares と price から売却で受け取る cash を計算（slippage % と commission $ を控除）。
 */
export function calculateSellOrder(
  shares: number,
  price: number,
  slippagePct: number,
  commission: number
): SellOrderResult {
  const proceeds = shares * price;
  const slippage = proceeds * (slippagePct / 100);
  const cashReceived = proceeds - commission - slippage;
  return { proceeds, slippage, commission, cashReceived };
}
```

**Step 4: テスト pass を確認**

Run: `npx vitest run src/backtest/dual-momentum/__tests__/order-calculator.test.ts`
Expected: 6/6 PASS

**Step 5: コミット**

```bash
git add src/backtest/dual-momentum/order-calculator.ts src/backtest/dual-momentum/__tests__/order-calculator.test.ts
git commit -m "feat(dual-momentum): calculateBuyOrder / calculateSellOrder を純関数として TDD 抽出"
```

---

## Task 5: us-dual-momentum-simulation.ts を純関数を呼ぶラッパーに refactor

**Files:**
- Modify: `src/backtest/us/us-dual-momentum-simulation.ts`

**Step 1: refactor 前のベースライン記録**

Run: `npx tsx src/backtest/us/us-dual-momentum-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/dm-before.txt`
内容を確認し、Closed Positions / Win Rate / Profit Factor / Net Return / Max Drawdown を記憶（comparison のため）。

**Step 2: simulation.ts の `pctReturn` 関数を削除**

`src/backtest/us/us-dual-momentum-simulation.ts` の局所関数 `pctReturn` を削除し、import に置き換え:

```ts
import { pctReturn } from "../../dual-momentum/momentum-calculator";
```

**Step 3: rankings 計算とソート + 選択ロジックを置換**

該当箇所:

```ts
// ─ before ─
const rankings: Array<{ ticker: string; momentum: number }> = [];
for (const ticker of config.equityUniverse) {
  const prices = getPrices(ticker, today);
  const ret = pctReturn(prices, config.lookbackDays);
  if (ret != null) rankings.push({ ticker, momentum: ret });
}
rankings.sort((a, b) => b.momentum - a.momentum);

let selected: string;
let reason: "best_equity" | "risk_off";

if (rankings.length > 0 && rankings[0].momentum > config.absoluteMomentumThreshold) {
  selected = rankings[0].ticker;
  reason = "best_equity";
} else {
  selected = config.riskOffAsset;
  reason = "risk_off";
}
```

を以下に置換:

```ts
// ─ after ─
import { selectMomentumAsset } from "../../dual-momentum/asset-selector";

// (ループ内)
const rankings: Array<{ ticker: string; momentum: number }> = [];
for (const ticker of config.equityUniverse) {
  const prices = getPrices(ticker, today);
  const ret = pctReturn(prices, config.lookbackDays);
  if (ret != null) rankings.push({ ticker, momentum: ret });
}
const selection = selectMomentumAsset(
  rankings,
  config.absoluteMomentumThreshold,
  config.riskOffAsset
);
const selected = selection.selected;
const reason = selection.reason;
const sortedRankings = selection.sortedRankings;
```

`rebalances.push({ ..., rankings, ... })` の `rankings` を `sortedRankings` に変更（既にソート済みのものを記録）。

**Step 4: 売却ロジックを calculateSellOrder に置換**

該当箇所（既存ポジ売却部分）:

```ts
// ─ before ─
if (currentTicker && currentShares > 0) {
  const closeM = closeByDate.get(currentTicker)!;
  const exitPrice = closeM.get(today)!;
  const proceeds = currentShares * exitPrice;
  const slippage = proceeds * (config.slippagePct / 100);
  cash += proceeds - config.commissionPerTrade - slippage;
  // ...lastPos 更新...
}
```

を以下に置換:

```ts
// ─ after ─
import { calculateSellOrder, calculateBuyOrder } from "../../dual-momentum/order-calculator";

if (currentTicker && currentShares > 0) {
  const closeM = closeByDate.get(currentTicker)!;
  const exitPrice = closeM.get(today)!;
  const sell = calculateSellOrder(currentShares, exitPrice, config.slippagePct, config.commissionPerTrade);
  cash += sell.cashReceived;
  // ...lastPos 更新（exit 計算は既存ロジック）...
}
```

**Step 5: 購入ロジックを calculateBuyOrder に置換**

該当箇所（新規ポジ購入部分）:

```ts
// ─ before ─
const newPriceM = closeByDate.get(selected)!;
const newPrice = newPriceM.get(today)!;
const slippage = cash * (config.slippagePct / 100);
const usableCash = cash - config.commissionPerTrade - slippage;
const shares = Math.floor(usableCash / newPrice);
if (shares > 0) {
  cash -= shares * newPrice + config.commissionPerTrade + slippage;
  currentTicker = selected;
  currentShares = shares;
  positions.push({ ... });
}
```

を以下に置換:

```ts
// ─ after ─
const newPriceM = closeByDate.get(selected)!;
const newPrice = newPriceM.get(today)!;
const buy = calculateBuyOrder(cash, newPrice, config.slippagePct, config.commissionPerTrade);
if (buy.shares > 0) {
  cash = buy.cashRemaining;
  currentTicker = selected;
  currentShares = buy.shares;
  positions.push({
    ticker: selected,
    entryDate: today,
    entryPrice: newPrice,
    shares: buy.shares,
  });
}
```

**Step 6: typecheck 通過確認**

Run: `npm run typecheck`
Expected: 0 errors

**Step 7: 既存テストが引き続き pass することを確認**

Run: `npm run test`
Expected: 全 PASS（dual-momentum 純関数 3 ファイル + credit-spread 既存）

**Step 8: refactor 後のベースラインと一致を確認**

Run: `npx tsx src/backtest/us/us-dual-momentum-run.ts --start 2020-01-01 --end 2023-12-31 > /tmp/dm-after.txt`

Run: `diff /tmp/dm-before.txt /tmp/dm-after.txt`
Expected: **完全一致** または floating point の最終桁差のみ。Closed Positions 数 / Win Rate / Profit Factor / Net Return が一致すること。一致しない場合は refactor のロジックエラー、原因特定して修正。

**Step 9: コミット**

```bash
git add src/backtest/us/us-dual-momentum-simulation.ts
git commit -m "refactor(dual-momentum): simulation を純関数を呼ぶラッパー化"
```

---

## Task 6: rotation ETF データの 2007〜 backfill (local DB)

**Files:**
- Modify: `scripts/data/backfill_rotation_etfs.py`

**Step 1: 現状データ範囲を確認**

Run:
```bash
psql $LOCAL_DATABASE_URL -c "SELECT \"tickerCode\", MIN(date), MAX(date), COUNT(*) FROM auto_us_stock_trader.\"StockDailyBar\" WHERE \"tickerCode\" IN ('SPY','EFA','AGG') GROUP BY \"tickerCode\" ORDER BY \"tickerCode\";"
```

期待: SPY/EFA/AGG の MIN(date) と件数を記録。MIN > 2007-01-03 のものは backfill 対象。

**Step 2: backfill スクリプトに `--start` オプションを追加**

`scripts/data/backfill_rotation_etfs.py` を修正し、`PERIOD = "10y"` を `--start` 引数で上書き可能にする:

```python
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--start", default=None, help="Start date YYYY-MM-DD (overrides PERIOD)")
parser.add_argument("--tickers", default=None, help="Comma-separated tickers (overrides default list)")
args = parser.parse_args()

TICKERS = args.tickers.split(",") if args.tickers else ["SPY", "EFA", "AGG", "QQQ", "IWM", "TLT", "GLD", "BND"]

# yf.download 呼び出し変更:
if args.start:
    df = yf.download(ticker, start=args.start, progress=False, auto_adjust=False)
else:
    df = yf.download(ticker, period=PERIOD, progress=False, auto_adjust=False)
```

**Step 3: local DB に対して 2007〜 で実行**

Run:
```bash
DATABASE_URL=$LOCAL_DATABASE_URL python scripts/data/backfill_rotation_etfs.py --start 2007-01-01 --tickers SPY,EFA,AGG
```

Expected: 各 ticker で約 4800〜5000 行 INSERT が表示される。

**Step 4: spot check (Lehman, COVID, Volmageddon)**

Run:
```bash
psql $LOCAL_DATABASE_URL -c "SELECT \"tickerCode\", date, close FROM auto_us_stock_trader.\"StockDailyBar\" WHERE \"tickerCode\" IN ('SPY','EFA','AGG') AND date IN ('2008-09-15','2020-03-16','2018-02-05') ORDER BY date, \"tickerCode\";"
```

Expected: 9 行返る（3 ticker × 3 日付）。SPY 2008-09-15 が 100〜130 の範囲、SPY 2020-03-16 が 200〜250 の範囲、SPY 2018-02-05 が 260〜280 の範囲にあれば OK。

**Step 5: コミット**

```bash
git add scripts/data/backfill_rotation_etfs.py
git commit -m "feat(data): backfill_rotation_etfs.py に --start / --tickers オプション追加"
```

---

## Task 7: Railway DB へ反映

**Step 1: Railway DB に対して同コマンドを実行**

Run:
```bash
DATABASE_URL=$RAILWAY_DATABASE_URL python scripts/data/backfill_rotation_etfs.py --start 2007-01-01 --tickers SPY,EFA,AGG
```

Expected: ON CONFLICT で既存データはスキップ、不足分のみ INSERT。

**Step 2: Railway 側 spot check**

同じ SQL を Railway DB に対して実行:

```bash
psql $RAILWAY_DATABASE_URL -c "SELECT \"tickerCode\", MIN(date), COUNT(*) FROM auto_us_stock_trader.\"StockDailyBar\" WHERE \"tickerCode\" IN ('SPY','EFA','AGG') GROUP BY \"tickerCode\";"
```

Expected: 各 ticker で MIN ≤ 2007-01-03、COUNT ≥ 4500。

**Step 3: コミットなし**（DB 操作のみ）

---

## Task 8: dual-momentum thresholds 定義

**Files:**
- Create: `src/backtest/dual-momentum/tail-test-thresholds.ts`

**Step 1: thresholds 定義を作成**

```ts
// src/backtest/dual-momentum/tail-test-thresholds.ts
import type { Thresholds } from "../tail-test/pass-fail";

/**
 * Dual Momentum 用 tail-test 閾値（暫定値）。
 * - winRate / cvar5Multiplier は月次 rotation 戦略では概念が薄いため null（スキップ）
 * - drawdown は credit-spread より緩めに設定（rotation 性質上 GFC 等で大きな DD を許容）
 */
export const DUAL_MOMENTUM_THRESHOLDS = {
  winRate: null as number | null,
  profitFactor: 1.0,
  cagr: 0.07,
  maxDrawdown: 0.30,
  cvar5Multiplier: null as number | null,
  worstWindowDD: 0.35,
  worstWindowPnlPct: -0.40,
};
```

注: 既存 `tail-test/pass-fail.ts` の `Thresholds` interface に `null` 許容が無い場合、Task 9 で対応。

**Step 2: コミットなし**（次タスクで一緒に）

---

## Task 9: pass-fail.ts に "skip" (null threshold) サポートを追加

**Files:**
- Modify: `src/backtest/tail-test/pass-fail.ts`
- Modify: `src/backtest/tail-test/__tests__/pass-fail.test.ts`（テスト追加）

**現状確認:**

Run: `cat src/backtest/tail-test/pass-fail.ts`

各閾値の `evaluate*` 関数で `threshold` を見ている。`threshold === null` のときは `pass: null, comment: "skipped"` を返すように変更。

**Step 1: 既存テストでのリグレッション無しを確認した上で、skip テストを追加**

```ts
// __tests__/pass-fail.test.ts に追記
describe("evaluateThresholds (skip support)", () => {
  it("returns pass=null for thresholds set to null", () => {
    const verdict = evaluateThresholds({
      winRate: 0.5,
      profitFactor: 1.5,
      cagr: 0.08,
      maxDrawdown: 0.25,
      cvar5: -100,
      worstWindowDD: 0.2,
      worstWindowPnlPct: -0.1,
      maxLossDollar: 1000,
      thresholds: {
        ...DEFAULT_THRESHOLDS,
        winRate: null,
        cvar5Multiplier: null,
      },
    });
    const winRateCheck = verdict.checks.find((c) => c.name.includes("Win Rate"));
    expect(winRateCheck?.pass).toBeNull();
  });
});
```

**Step 2: テスト失敗を確認**

Run: `npx vitest run src/backtest/tail-test/__tests__/pass-fail.test.ts`
Expected: skip テストが FAIL（既存テストは PASS）

**Step 3: pass-fail.ts を修正**

`Thresholds` interface で各閾値を `number | null` に変更。各 evaluate 関数の冒頭で `if (threshold === null) return { ..., pass: null, comment: "skipped" }`。

**Step 4: テスト全件 pass を確認**

Run: `npm run test`
Expected: 全 PASS、既存リグレッション無し

**Step 5: コミット**

```bash
git add src/backtest/tail-test/pass-fail.ts src/backtest/tail-test/__tests__/pass-fail.test.ts src/backtest/dual-momentum/tail-test-thresholds.ts
git commit -m "feat(tail-test): null 閾値で skip 判定をサポート（dual-momentum 用）"
```

---

## Task 10: dual-momentum 用 tail-test 実行スクリプト

**Files:**
- Create: `src/backtest/dual-momentum/run-tail-test.ts`
- Create: `src/backtest/tail-test/dual-momentum-adapter.ts`（dual-momentum result → 共通入力 への変換）

**設計判断:** 既存 tail-test framework は credit-spread の `SimulatedSpread[]` を受け取る。dual-momentum の `SimulatedRotationPosition[]` をそれ互換に adapt する thin wrapper を作る。Phase 1 で framework 抽象化が入った段階で削除予定の "踏み台コード"。

**Step 1: adapter を作成**

```ts
// src/backtest/tail-test/dual-momentum-adapter.ts
import type { SimulatedRotationPosition } from "../us/us-dual-momentum-types";
import type { SimulatedSpread } from "../us/us-credit-spread-types";

/**
 * Dual Momentum の rotation positions を tail-test framework が期待する
 * SimulatedSpread 互換 shape に変換する踏み台 adapter。
 * Phase 1 (framework 抽象化) で削除予定。
 *
 * 注: spread 固有フィールド (shortStrike, creditReceived 等) はダミー値で埋める。
 *     tail-test の DD/window/CVaR 計算は entryDate, exitDate, pnl ベースで動くため影響なし。
 */
export function rotationPositionsToSpreads(
  positions: SimulatedRotationPosition[]
): SimulatedSpread[] {
  return positions
    .filter((p) => p.exitReason === "rotation_exit") // closed only
    .map((p) => ({
      underlyingSymbol: p.ticker,
      entryDate: p.entryDate,
      expirationDate: p.exitDate ?? p.entryDate,
      entrySpotPrice: p.entryPrice,
      entryIV: 0,
      shortStrike: 0,
      longStrike: 0,
      shortDeltaAtEntry: 0,
      creditReceived: 0,
      contracts: p.shares,
      state: "CLOSED",
      totalCommissions: 0,
      exitDate: p.exitDate ?? null,
      exitSpotPrice: p.exitPrice ?? null,
      exitReason: "expired_worthless", // dummy
      finalValue: 0,
      netPnl: p.netPnl ?? 0,
      pnlPct: p.pnlPct ?? 0,
      holdingDays: p.holdingDays ?? 0,
    } as unknown as SimulatedSpread));
}
```

注: SimulatedSpread の正確な field 名・型は `src/backtest/us/us-credit-spread-types.ts` を確認して合わせる。コンパイルが通る最小限の dummy 値で OK。

**Step 2: run-tail-test.ts を作成**

```ts
// src/backtest/dual-momentum/run-tail-test.ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_DUAL_MOMENTUM_DEFAULTS } from "../us/us-dual-momentum-config";
import { runUSDualMomentumBacktest } from "../us/us-dual-momentum-simulation";
import { fetchUSHistoricalFromDB } from "../us/us-data-fetcher";
import type { USDualMomentumBacktestConfig } from "../us/us-dual-momentum-types";
import { extractDDPeriods } from "../tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../tail-test/window-analyzer";
import { calculateTailMetrics } from "../tail-test/tail-metrics";
import { evaluateThresholds } from "../tail-test/pass-fail";
import { generateMarkdownReport } from "../tail-test/report";
import { STRESS_WINDOWS } from "../tail-test/stress-windows";
import { rotationPositionsToSpreads } from "../tail-test/dual-momentum-adapter";
import { DUAL_MOMENTUM_THRESHOLDS } from "./tail-test-thresholds";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const startDate = getArg("start") ?? "2007-01-03";
  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");

  const config: USDualMomentumBacktestConfig = {
    ...US_DUAL_MOMENTUM_DEFAULTS,
    startDate,
    endDate,
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("Dual Momentum Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);

  const allTickers = [...config.equityUniverse, config.riskOffAsset];
  const dataStart = dayjs(startDate).subtract(config.lookbackDays + 30, "day").format("YYYY-MM-DD");
  const etfMap = await fetchUSHistoricalFromDB(allTickers, dataStart, endDate, 0);

  console.log("\nRunning simulation...");
  const result = runUSDualMomentumBacktest(config, etfMap);

  // Adapter
  const spreads = rotationPositionsToSpreads(result.positions);

  // tail-test 共通処理
  const ddPeriods = extractDDPeriods(result.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) => analyzeWindow(w, result.equityCurve, spreads));
  const tailMetrics = calculateTailMetrics(spreads, result.equityCurve);

  const initial = config.initialBudget;
  const finalEq = result.equityCurve[result.equityCurve.length - 1]?.totalEquity ?? initial;
  const years = result.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;

  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD = available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct = available.length === 0 ? null : Math.min(...available.map((w) => w.pnlPct));

  const verdict = evaluateThresholds({
    winRate: result.metrics.winRate / 100,
    profitFactor: result.metrics.profitFactor,
    cagr,
    maxDrawdown: result.metrics.maxDrawdown / 100,
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    maxLossDollar: initial, // dual-momentum は spreadWidth 概念がないので initialBudget を使う
    thresholds: DUAL_MOMENTUM_THRESHOLDS,
  });

  // VIX bucket は dual-momentum で意味が薄いため省略（null 渡しか empty array）
  const tailTestResult = {
    configSummary: { strategy: "dual-momentum", ...config },
    startDate,
    endDate,
    totalSpreads: spreads.length,
    baseMetrics: {
      winRate: result.metrics.winRate / 100,
      profitFactor: result.metrics.profitFactor,
      cagr,
      maxDrawdown: result.metrics.maxDrawdown / 100,
      netReturnPct: result.metrics.netReturnPct,
    },
    ddRanking: taggedDDs,
    stressWindows: stressAnalyses,
    tailMetrics,
    vixBuckets: [],
    verdict,
  };

  // ターミナル出力
  console.log(`\nTotal closed positions: ${spreads.length}`);
  console.log(`Win rate: ${(result.metrics.winRate).toFixed(1)}%`);
  console.log(`CAGR: ${(cagr * 100).toFixed(1)}%`);
  console.log(`Max DD: ${result.metrics.maxDrawdown.toFixed(1)}%`);
  console.log(`Verdict: ${verdict.summary}`);

  // Markdown レポート出力
  const today = dayjs().format("YYYY-MM-DD");
  const reportDir = path.join(process.cwd(), "docs/reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `dual-momentum-tail-${today}.md`);
  const md = generateMarkdownReport(tailTestResult as any, "Dual Momentum");
  fs.writeFileSync(reportPath, md);
  console.log(`\nReport: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

注: `generateMarkdownReport` のシグネチャに `strategyName` 引数が無ければ Task 11 で追加。

**Step 3: typecheck**

Run: `npm run typecheck`
Expected: 0 errors（adapter の `as unknown as SimulatedSpread` で押し通している箇所のみ確認）

**Step 4: コミット**

```bash
git add src/backtest/dual-momentum/run-tail-test.ts src/backtest/tail-test/dual-momentum-adapter.ts
git commit -m "feat(dual-momentum): tail-test 適用用の run-tail-test と adapter 追加"
```

---

## Task 11: report.ts に strategyName 引数を追加（必要なら）

**Files:**
- Modify: `src/backtest/tail-test/report.ts`（必要なら）

**Step 1: 既存シグネチャ確認**

Run: `grep -n "export function generateMarkdownReport" src/backtest/tail-test/report.ts`

`generateMarkdownReport(result: TailTestResult)` のみで strategyName 引数が無い場合:

**Step 2: signature を変更（後方互換維持）**

```ts
export function generateMarkdownReport(
  result: TailTestResult,
  strategyName: string = "SPY Credit Spread"
): string {
  // タイトル行を strategyName を使う形に変更
  // 例: `# ${strategyName} テール耐性検証レポート — ${today}`
}
```

**Step 3: credit-spread の既存呼び出しは無引数のまま動くか確認**

Run: `grep -rn "generateMarkdownReport" src/backtest/`

呼び出し側で 2 引数版を使うのは dual-momentum のみ、credit-spread は既存のまま。

**Step 4: テスト確認**

Run: `npm run test`
Expected: 全 PASS

**Step 5: コミット**（変更があった場合のみ）

```bash
git add src/backtest/tail-test/report.ts
git commit -m "feat(tail-test): generateMarkdownReport に strategyName 引数追加"
```

---

## Task 12: package.json に tail-test:dual-momentum スクリプト追加

**Files:**
- Modify: `package.json`

**Step 1: scripts に追加**

```json
"tail-test:dual-momentum": "tsx src/backtest/dual-momentum/run-tail-test.ts",
```

`tail-test:credit-spread` の隣に配置。

**Step 2: 動作確認（短期間で smoke）**

Run: `npm run tail-test:dual-momentum -- --start 2020-01-01 --end 2023-12-31`
Expected: 完走、`docs/reports/dual-momentum-tail-YYYY-MM-DD.md` が生成される。

**Step 3: 生成レポートを確認**

Run: `head -50 docs/reports/dual-momentum-tail-*.md`
Expected: タイトル / 設定 / 平時メトリクス / DD 上位 / stress windows のセクションが存在。

**Step 4: コミット**

```bash
git add package.json
git commit -m "chore(scripts): tail-test:dual-momentum を追加"
```

---

## Task 13: 全期間 tail-test 実行 + レポート確定

**Step 1: 2007-01-03〜 で本実行**

Run: `npm run tail-test:dual-momentum -- --start 2007-01-03`
Expected: 完走（数十秒〜数分）。

**Step 2: 生成された Markdown レポートを確認**

Run: `cat docs/reports/dual-momentum-tail-$(date +%Y-%m-%d).md`

Expected:
- ヘッダーに "Dual Momentum テール耐性検証"
- 平時メトリクス: CAGR, Max DD, Profit Factor が表示
- DD 上位 5 期間表
- 9 個の stress window 表（COVID, Lehman, Volmageddon 等が表示、データ範囲外のものは "N/A"）
- VIX bucket は空 or 未表示（dual-momentum では skip）
- Verdict: PASS/FAIL の表示

**Step 3: 結果の sanity check**

Lehman 期間（2008-09〜2009-03）の DD が GFC で深く、COVID 期間（2020-02〜04）の DD が比較的浅い、という Antonacci GEM の知見と整合するか確認。違和感があれば、ロジックエラー or データ問題の可能性。

**Step 4: レポートをコミット**

```bash
git add docs/reports/dual-momentum-tail-*.md
git commit -m "report(dual-momentum): 2007-01-03〜 tail-test レポート生成"
```

---

## Task 14: 最終 smoke + ドキュメント

**Step 1: 全テスト pass を確認**

Run: `npm run test`
Expected: 全 PASS

Run: `npm run typecheck`
Expected: 0 errors

**Step 2: design doc に Phase 0 完了を記録**

`docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md` の末尾に追記:

```markdown
## 進捗

### Phase 0: Dual Momentum (2026-XX-XX 完了)

- 純関数抽出: `momentum-calculator.ts`, `asset-selector.ts`, `order-calculator.ts`
- レポート: [docs/reports/dual-momentum-tail-YYYY-MM-DD.md](../reports/dual-momentum-tail-YYYY-MM-DD.md)
- 主要結果: CAGR XX%, Max DD XX%, GFC 期間 DD XX%, COVID 期間 DD XX%
- Verdict: PASS / FAIL
- 次のフェーズへの判断: Phase 1 (framework 抽象化) に進む / 戦略 scope 外判断
```

**Step 3: コミット**

```bash
git add docs/plans/2026-04-30-portfolio-strategy-evaluation-design.md
git commit -m "docs: Phase 0 (Dual Momentum) 完了報告を design doc に追記"
```

---

## Phase 0 完了確認チェックリスト

- [ ] Task 2-4: 純関数 3 つの TDD 完了、5/5/6 テスト PASS
- [ ] Task 5: simulation refactor 後の数値が refactor 前と一致
- [ ] Task 6-7: SPY/EFA/AGG が 2007〜 で local + Railway DB に存在
- [ ] Task 8-9: dual-momentum thresholds 定義 + null 閾値 skip サポート
- [ ] Task 10-12: `npm run tail-test:dual-momentum` で完走、Markdown レポート生成
- [ ] Task 13: 2007〜 全期間 tail-test レポートが docs/reports/ に保存
- [ ] Task 14: 全 vitest テスト PASS、typecheck 0 errors、design doc に進捗追記

## Phase 1 への引き継ぎ事項

Phase 0 で残された "踏み台コード"（Phase 1 で抽象化リファクタする対象）:

1. `src/backtest/tail-test/dual-momentum-adapter.ts` — `SimulatedSpread` 互換 shape に変換する adapter。Phase 1 で `StrategyResult` interface を導入したら削除。
2. `src/backtest/dual-momentum/run-tail-test.ts` の adapter 呼び出し部分 — Phase 1 で共通化。
3. `tail-test/` ディレクトリ位置 — Phase 1 で `framework/tail-test/` に移動。

これらは Phase 1 の design doc / plan で扱う。

---

## YAGNI（Phase 0 で採用しないもの）

- Walk-Forward analysis（JP リポにあった `walk-forward-us-dual-momentum.ts` は移管しない）
- Parameter grid search（`generateUSDualMomentumParameterCombinations` は移管しない）
- VIX bucket 分析（dual-momentum では概念が薄い）
- データ層 unit test（data-fetcher の動作確認は smoke のみ）
- adapter の TDD（薄い踏み台コードのため、Phase 1 抽象化時にまとめてテスト）

