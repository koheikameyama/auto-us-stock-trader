# Paper Trading Phase C: 発注 + 状態管理 実装プラン

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** IBKR Paper Trading で SPY Bull Put Credit Spread の発注 → 約定確認 → DB 記録 → 状態同期 までを完結するフローを実装。Phase B のリードオンリー API に発注ロジックを追加し、`daily-runner.ts` を cron 起動できる形にする。

**Architecture:** 5 つの DB テーブル（TradingOrder, Position, DailyEquitySnapshot, SignalLog, ErrorLog）を Prisma migration で追加。`order-manager.ts` で Combo Order 構築 + 二重発注検知、`position-syncer.ts` で IBKR ↔ DB 同期、`daily-runner.ts` が Phase A の純関数（generateEntrySignal / evaluateSpread / calcDDStopState）と Phase B の `IBKRClient` を連携する。kill switch ファイル + dry-run フラグで安全装置を二重化。

**Tech Stack:** TypeScript 6, Prisma 6.19.3, @stoqey/ib v1.5.3, tsx, vitest

**前提:**
- KOH-453 完了（Phase B、IBKR リードオンリー接続）
- 信号ロジック純関数が `src/backtest/credit-spread/` で利用可能（KOH-452）
- TWS Paper にログイン済み、port 7497 開放
- Paper account の Net Liquidation: ~$100,000、Buying Power: ~$400,000

**スコープ外（別 Phase）:**
- Slack 通知（Phase D）
- リトライ・エラーハンドリング統合（Phase E）
- 90 日観察（Phase F）

**設計参照:** [`docs/plans/2026-04-30-paper-trading-design.md`](2026-04-30-paper-trading-design.md) (Phase C セクション)

---

## ロールバック方法

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
git status

# 全変更を破棄
git restore --staged .
git checkout -- prisma/schema.prisma src/paper-trading/
rm -f src/paper-trading/{kill-switch,order-manager,position-syncer,daily-runner}.ts
rm -rf prisma/migrations/<最新の paper-trading migration>/

# 既コミット済みの場合
git log --oneline | head -15
git revert <SHA range>

# DB migration を巻き戻す場合（要注意：Prisma は down-migration 自動生成しない）
# ローカル: npx prisma migrate reset（全 DB ワイプ）
# Railway: 手動で DROP TABLE
```

---

## Task 1: Prisma migration — 5 テーブル追加

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_paper_trading_tables/migration.sql`（自動生成）

### Step 1: schema.prisma に 5 model 追加

`prisma/schema.prisma` の最後に追加:

```prisma
model TradingOrder {
  id              String   @id @default(cuid())
  ibkrOrderId     Int      @unique
  symbol          String
  orderType       String   // "ENTRY" | "EXIT"
  shortStrike     Float
  longStrike      Float
  expiry          DateTime @db.Date
  quantity        Int
  limitPrice      Float    // negative = credit (NET_CREDIT)
  status          String   // "SUBMITTED" | "FILLED" | "CANCELLED" | "REJECTED" | "TIMEOUT"
  submittedAt     DateTime
  filledAt        DateTime?
  filledPrice     Float?
  commission      Float?
  createdAt       DateTime @default(now())

  position        Position? @relation(fields: [positionId], references: [id])
  positionId      String?

  @@unique([symbol, shortStrike, longStrike, expiry, submittedAt])  // 二重発注 DB 制約
  @@index([status])
  @@index([submittedAt])
  @@schema("auto_us_stock_trader")
}

model Position {
  id              String   @id @default(cuid())
  symbol          String
  shortStrike     Float
  longStrike      Float
  expiry          DateTime @db.Date
  contracts       Int
  creditReceived  Float
  entryDate       DateTime
  state           String   // "OPEN" | "CLOSED"
  closeDate       DateTime?
  closeReason     String?  // "profit_target" | "stop_loss" | "expired_worthless" | "expired_max_loss" | "expired_partial"
  closeSpreadPrice Float?
  netPnl          Float?
  totalCommission Float?

  orders          TradingOrder[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([state])
  @@index([entryDate])
  @@schema("auto_us_stock_trader")
}

model DailyEquitySnapshot {
  id                String   @id @default(cuid())
  date              DateTime @db.Date  @unique
  cash              Float
  positionsValue    Float
  totalEquity       Float
  openPositionCount Int
  ddStopActive      Boolean
  runningPeak       Float
  ddStopActivatedDate DateTime? @db.Date
  createdAt         DateTime @default(now())

  @@index([date])
  @@schema("auto_us_stock_trader")
}

model SignalLog {
  id              String   @id @default(cuid())
  date            DateTime @db.Date
  signalType      String   // "ENTRY" | "CLOSE"
  reason          String   // "ENTERED" | "SKIP_VIX_CAP" | "profit_target" | etc.
  details         Json?    // strike, vix, sma, etc.
  createdAt       DateTime @default(now())

  @@index([date])
  @@index([signalType])
  @@schema("auto_us_stock_trader")
}

model ErrorLog {
  id              String   @id @default(cuid())
  occurredAt      DateTime @default(now())
  category        String   // "IBKR_CONNECTION" | "ORDER_FAILED" | "DB" | "UNHANDLED"
  message         String
  context         Json?
  resolved        Boolean  @default(false)

  @@index([occurredAt])
  @@index([category])
  @@schema("auto_us_stock_trader")
}
```

### Step 2: ローカル migrate

Run:
```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
DATABASE_URL="postgresql://kouheikameyama@localhost:5432/auto_stock_trader?schema=auto_us_stock_trader" \
  npx prisma migrate dev --name add_paper_trading_tables 2>&1 | tail -15
```

Expected:
- 新しい migration ディレクトリが作成される
- `Database is in sync with your schema`
- `✔ Generated Prisma Client`

### Step 3: ローカル DB に 5 テーブルが追加されたか確認

Run:
```bash
psql -U kouheikameyama -h localhost -d auto_stock_trader -c "\dt auto_us_stock_trader.*" | grep -E "TradingOrder|Position|DailyEquitySnapshot|SignalLog|ErrorLog"
```

Expected: 5 つすべてリストされる。

### Step 4: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし（Prisma client 再生成で型は最新）

### Step 5: コミット

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(paper-trading): Prisma migration で 5 テーブル追加

Phase C で Paper Trading の状態を永続化するためのテーブル:
- TradingOrder: IBKR 注文履歴 (二重発注防止 unique 制約)
- Position: Spread の保有 + クローズ履歴
- DailyEquitySnapshot: 日次 EOD の equity / DD 状態
- SignalLog: 信号生成結果（ENTERED / SKIP_*）
- ErrorLog: 接続エラー / 約定失敗 / 想定外例外

Refs: KOH-454 (予定)"
```

---

## Task 2: Railway へ migrate deploy

**Files:** なし（実行のみ）

### Step 1: 本番 migrate deploy

Run:
```bash
DATABASE_URL='postgresql://postgres:HZSVgekgIrABuLKHmmzMXhvRQecbapnT@shinkansen.proxy.rlwy.net:45444/railway?schema=auto_us_stock_trader' \
  npx prisma migrate deploy 2>&1 | tail -10
```

Expected:
- `Applying migration `<timestamp>_add_paper_trading_tables``
- `All migrations have been successfully applied`

### Step 2: Railway 上の確認

Run:
```bash
PROD_URL='postgresql://postgres:HZSVgekgIrABuLKHmmzMXhvRQecbapnT@shinkansen.proxy.rlwy.net:45444/railway'
psql "$PROD_URL" -c "\dt auto_us_stock_trader.*" | grep -E "TradingOrder|Position|DailyEquitySnapshot|SignalLog|ErrorLog"
```

Expected: 5 つすべてリストされる。

### Step 3: 検証コミット（empty commit）

```bash
git commit --allow-empty -m "verify(paper-trading): Railway に paper-trading migration を deploy

5 テーブル（TradingOrder/Position/DailyEquitySnapshot/SignalLog/ErrorLog）
が auto_us_stock_trader schema に作成されたことを確認。

Refs: KOH-454"
```

---

## Task 3: kill-switch.ts 実装

**Files:**
- Create: `src/paper-trading/kill-switch.ts`
- Modify: `.gitignore`

### Step 1: kill-switch.ts 作成

```typescript
// src/paper-trading/kill-switch.ts
import * as fs from "fs";
import * as path from "path";

const KILL_SWITCH_FILE = path.resolve(".paper-trading-stop");

export function isKillSwitchActive(): boolean {
  return fs.existsSync(KILL_SWITCH_FILE);
}

export function getKillSwitchInfo(): { active: boolean; reason?: string; createdAt?: Date } {
  if (!fs.existsSync(KILL_SWITCH_FILE)) return { active: false };
  const stat = fs.statSync(KILL_SWITCH_FILE);
  const reason = fs.readFileSync(KILL_SWITCH_FILE, "utf-8").trim() || "(no reason)";
  return { active: true, reason, createdAt: stat.birthtime };
}
```

### Step 2: .gitignore に kill switch ファイル追加

`.gitignore` に以下を追加（重複しないこと）:

```
# Paper trading kill switch
.paper-trading-stop
```

### Step 3: ユニットテスト

Create `src/paper-trading/__tests__/kill-switch.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { isKillSwitchActive, getKillSwitchInfo } from "../kill-switch";

const KILL_SWITCH_FILE = path.resolve(".paper-trading-stop");

describe("kill-switch", () => {
  afterEach(() => {
    if (fs.existsSync(KILL_SWITCH_FILE)) fs.unlinkSync(KILL_SWITCH_FILE);
  });

  it("returns false when kill switch file does not exist", () => {
    expect(isKillSwitchActive()).toBe(false);
    expect(getKillSwitchInfo().active).toBe(false);
  });

  it("returns true when kill switch file exists", () => {
    fs.writeFileSync(KILL_SWITCH_FILE, "メンテナンス中");
    expect(isKillSwitchActive()).toBe(true);
    const info = getKillSwitchInfo();
    expect(info.active).toBe(true);
    expect(info.reason).toBe("メンテナンス中");
  });

  it("returns '(no reason)' when file exists but is empty", () => {
    fs.writeFileSync(KILL_SWITCH_FILE, "");
    expect(getKillSwitchInfo().reason).toBe("(no reason)");
  });
});
```

### Step 4: テスト実行

Run: `npm test -- kill-switch 2>&1 | tail -10`
Expected: 3 passed

### Step 5: コミット

```bash
git add src/paper-trading/kill-switch.ts src/paper-trading/__tests__/kill-switch.test.ts .gitignore
git commit -m "feat(paper-trading): kill-switch ファイル方式の実装

.paper-trading-stop ファイルが存在すれば daily-runner は entry を
出さず即座に exit する。緊急停止プロトコルとして使用。

- isKillSwitchActive(): boolean
- getKillSwitchInfo(): { active, reason, createdAt }

ユニットテスト 3 件で境界条件をカバー（不在 / 存在 / 空ファイル）。
.gitignore に .paper-trading-stop を追加。

利用例:
  echo 'メンテナンス中' > .paper-trading-stop  # 停止
  rm .paper-trading-stop                         # 解除

Refs: KOH-454"
```

---

## Task 4: IBKRClient に発注メソッド追加

**Files:**
- Modify: `src/paper-trading/ibkr-client.ts`

### Step 1: 型定義 + メソッド追加

`src/paper-trading/ibkr-client.ts` に追加:

```typescript
// 既存 import に Contract, Order, OrderStatus 等が必要なら追加
// (実型は @stoqey/ib の export を確認)

export interface OptionLeg {
  conId: number;
  action: "BUY" | "SELL";
  ratio: number;  // 通常 1
}

export interface ComboOrderRequest {
  underlying: string;       // "SPY"
  legs: OptionLeg[];        // 2 leg (short put, long put)
  totalQuantity: number;    // contracts
  limitPrice: number;       // 負の値 = NET CREDIT
  tif: "DAY" | "GTC";
}

export interface OrderResult {
  ibkrOrderId: number;
  status: "SUBMITTED" | "FILLED" | "CANCELLED" | "REJECTED" | "TIMEOUT";
  filledPrice?: number;
  commission?: number;
  message?: string;         // reject 時のエラー
}

// IBKRClient class 内に追加:

  /** 単一 OPT contract の conId を取得（Combo Order の構築用）*/
  async qualifyOptionContract(
    underlying: string,
    expiry: string,        // YYYYMMDD
    strike: number,
    right: "P" | "C",
  ): Promise<number> {
    if (!this.connected) throw new Error("Not connected");
    const contract = {
      symbol: underlying,
      secType: "OPT",
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: expiry,
      strike,
      right,
      multiplier: "100",
    };
    return new Promise<number>((resolve, reject) => {
      let conId: number | null = null;
      const sub = this.api.getContractDetails(contract as any).subscribe({
        next: (details) => {
          // details はバージョンによって型が異なる、配列で詳細が来る
          const arr = Array.isArray(details) ? details : (details as any).all ?? [];
          for (const d of arr) {
            const c = (d as any).contract ?? d;
            if (c.conId != null) conId = c.conId;
          }
        },
        error: (e) => {
          sub.unsubscribe();
          reject(e);
        },
        complete: () => {
          sub.unsubscribe();
          if (conId != null) resolve(conId);
          else reject(new Error(`Contract not found: ${underlying} ${expiry} ${strike}${right}`));
        },
      });
      setTimeout(() => {
        sub.unsubscribe();
        if (conId != null) resolve(conId);
        else reject(new Error("qualifyOptionContract timeout (10s)"));
      }, 10_000);
    });
  }

  /** Combo Order を発注、約定または timeout まで待つ */
  async placeComboOrder(req: ComboOrderRequest): Promise<OrderResult> {
    if (!this.connected) throw new Error("Not connected");

    const combo: any = {
      symbol: req.underlying,
      secType: "BAG",
      currency: "USD",
      exchange: "SMART",
      comboLegs: req.legs.map((leg) => ({
        conId: leg.conId,
        ratio: leg.ratio,
        action: leg.action,
        exchange: "SMART",
      })),
    };

    const order: any = {
      action: req.limitPrice < 0 ? "BUY" : "SELL",  // NET_CREDIT は BUY に -lmtPrice、NET_DEBIT は SELL
      orderType: "LMT",
      totalQuantity: req.totalQuantity,
      lmtPrice: Math.abs(req.limitPrice) * (req.limitPrice < 0 ? -1 : 1),
      tif: req.tif,
      transmit: true,
    };

    return new Promise<OrderResult>((resolve, reject) => {
      let ibkrOrderId: number | null = null;
      const sub = this.api.placeNewOrder(combo, order).subscribe({
        next: (update: any) => {
          // OrderStatus update を見る
          if (update.orderId != null) ibkrOrderId = update.orderId;
          if (update.status === "Filled" || update.status === "ApiCancelled" || update.status === "Cancelled") {
            sub.unsubscribe();
            resolve({
              ibkrOrderId: ibkrOrderId ?? 0,
              status:
                update.status === "Filled" ? "FILLED" :
                update.status === "ApiCancelled" ? "CANCELLED" : "CANCELLED",
              filledPrice: update.avgFillPrice,
              commission: update.commission,
            });
          }
        },
        error: (e) => {
          sub.unsubscribe();
          reject(e);
        },
      });
      // 5 分で打ち切り
      setTimeout(() => {
        sub.unsubscribe();
        resolve({
          ibkrOrderId: ibkrOrderId ?? 0,
          status: "TIMEOUT",
          message: "Order fill confirmation timed out (5 min)",
        });
      }, 5 * 60 * 1000);
    });
  }
```

**注意**: `@stoqey/ib` の placeNewOrder API は version で signature が異なる可能性。実装中に型エラーが出たら以下を inspect:

```bash
ls node_modules/@stoqey/ib/dist/api-next/
grep -r "placeNewOrder\|placeOrder" node_modules/@stoqey/ib/dist/api-next/ | head -10
```

### Step 2: typecheck

Run: `npm run typecheck 2>&1 | tail -10`
Expected: エラーなし（あれば `as any` キャストや signature 調整）

### Step 3: コミット（実発注テストは Task 11 で）

```bash
git add src/paper-trading/ibkr-client.ts
git commit -m "feat(paper-trading): IBKRClient に Combo Order 発注メソッド追加

- qualifyOptionContract: OPT contract の conId 取得
- placeComboOrder: Combo Order 構築 + 発注 + 約定待ち (5分タイムアウト)

NET_CREDIT order として limit price 負値で構築。
発注後は OrderStatus update を Observable で監視し、
Filled / Cancelled / Rejected / Timeout のいずれかで resolve。

実発注テストは Task 11 (NY 取引時間中) で行う。

Refs: KOH-454"
```

---

## Task 5: order-manager.ts 実装

**Files:**
- Create: `src/paper-trading/order-manager.ts`
- Create: `src/paper-trading/__tests__/order-manager.test.ts`

### Step 1: 実装

```typescript
// src/paper-trading/order-manager.ts
import { PrismaClient } from "@prisma/client";
import dayjs from "dayjs";
import type { IBKRClient, ComboOrderRequest, OrderResult } from "./ibkr-client";

export interface NewSpreadOrderInput {
  underlying: string;        // "SPY"
  shortStrike: number;
  longStrike: number;
  expiry: string;            // YYYYMMDD
  contracts: number;
  estimatedCredit: number;   // mid から決定した limit (positive)
}

export interface PlacedSpread {
  ibkrOrderId: number;
  status: OrderResult["status"];
  filledCredit: number | null;  // 実約定の credit (positive、約定時のみ)
  positionId: string | null;     // Position レコード ID（FILLED 時のみ）
}

/** 同日に同じ symbol/strikes/expiry で entry 注文が DB にあるか確認（二重発注防止）*/
export async function isDuplicateOrder(
  prisma: PrismaClient,
  underlying: string,
  shortStrike: number,
  longStrike: number,
  expiry: string,
): Promise<boolean> {
  const today = dayjs().format("YYYY-MM-DD");
  const existing = await prisma.tradingOrder.findFirst({
    where: {
      symbol: underlying,
      shortStrike,
      longStrike,
      expiry: new Date(expiry.slice(0, 4) + "-" + expiry.slice(4, 6) + "-" + expiry.slice(6, 8)),
      submittedAt: { gte: new Date(`${today}T00:00:00Z`) },
      orderType: "ENTRY",
    },
  });
  return existing != null;
}

/**
 * Combo Order を発注し、結果を DB の TradingOrder + Position に記録。
 *
 * @param dryRun true なら IBKR 発注をスキップして DB に SUBMITTED のみ記録
 */
export async function placeNewSpreadOrder(
  ibkr: IBKRClient,
  prisma: PrismaClient,
  input: NewSpreadOrderInput,
  options: { dryRun?: boolean } = {},
): Promise<PlacedSpread> {
  const { underlying, shortStrike, longStrike, expiry, contracts, estimatedCredit } = input;

  // 1. 二重発注チェック
  if (await isDuplicateOrder(prisma, underlying, shortStrike, longStrike, expiry)) {
    throw new Error(`Duplicate entry order detected: ${underlying} ${expiry} ${shortStrike}/${longStrike}`);
  }

  // 2. dry-run の場合: DB だけ書いて終了
  if (options.dryRun) {
    const order = await prisma.tradingOrder.create({
      data: {
        ibkrOrderId: 0,
        symbol: underlying,
        orderType: "ENTRY",
        shortStrike,
        longStrike,
        expiry: new Date(expiry.slice(0, 4) + "-" + expiry.slice(4, 6) + "-" + expiry.slice(6, 8)),
        quantity: contracts,
        limitPrice: -estimatedCredit,
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    });
    return { ibkrOrderId: 0, status: "SUBMITTED", filledCredit: null, positionId: null };
  }

  // 3. conId 取得
  const shortConId = await ibkr.qualifyOptionContract(underlying, expiry, shortStrike, "P");
  const longConId = await ibkr.qualifyOptionContract(underlying, expiry, longStrike, "P");

  // 4. Combo Order 発注
  const req: ComboOrderRequest = {
    underlying,
    legs: [
      { conId: shortConId, action: "SELL", ratio: 1 },
      { conId: longConId, action: "BUY", ratio: 1 },
    ],
    totalQuantity: contracts,
    limitPrice: -estimatedCredit,  // NET_CREDIT
    tif: "DAY",
  };

  const result = await ibkr.placeComboOrder(req);

  // 5. TradingOrder を DB に記録
  const order = await prisma.tradingOrder.create({
    data: {
      ibkrOrderId: result.ibkrOrderId,
      symbol: underlying,
      orderType: "ENTRY",
      shortStrike,
      longStrike,
      expiry: new Date(expiry.slice(0, 4) + "-" + expiry.slice(4, 6) + "-" + expiry.slice(6, 8)),
      quantity: contracts,
      limitPrice: -estimatedCredit,
      status: result.status,
      submittedAt: new Date(),
      filledAt: result.status === "FILLED" ? new Date() : null,
      filledPrice: result.filledPrice,
      commission: result.commission,
    },
  });

  // 6. FILLED なら Position も作成
  let positionId: string | null = null;
  let filledCredit: number | null = null;
  if (result.status === "FILLED" && result.filledPrice != null) {
    filledCredit = -result.filledPrice;  // NET_CREDIT なので約定価格は負、credit は反転
    const position = await prisma.position.create({
      data: {
        symbol: underlying,
        shortStrike,
        longStrike,
        expiry: new Date(expiry.slice(0, 4) + "-" + expiry.slice(4, 6) + "-" + expiry.slice(6, 8)),
        contracts,
        creditReceived: filledCredit,
        entryDate: new Date(),
        state: "OPEN",
        totalCommission: result.commission ?? 0,
      },
    });
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { positionId: position.id },
    });
    positionId = position.id;
  }

  return {
    ibkrOrderId: result.ibkrOrderId,
    status: result.status,
    filledCredit,
    positionId,
  };
}
```

### Step 2: ユニットテスト（dry-run + duplicate detection）

`src/paper-trading/__tests__/order-manager.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { placeNewSpreadOrder, isDuplicateOrder } from "../order-manager";

const prisma = new PrismaClient();

describe("order-manager", () => {
  beforeEach(async () => {
    await prisma.tradingOrder.deleteMany({});
    await prisma.position.deleteMany({});
  });
  afterEach(async () => {
    await prisma.tradingOrder.deleteMany({});
    await prisma.position.deleteMany({});
  });

  it("dry-run mode creates TradingOrder without IBKR call", async () => {
    const fakeIbkr = {} as any;  // dry-run では使われない
    const result = await placeNewSpreadOrder(
      fakeIbkr,
      prisma,
      {
        underlying: "SPY",
        shortStrike: 450,
        longStrike: 445,
        expiry: "20260619",
        contracts: 1,
        estimatedCredit: 0.85,
      },
      { dryRun: true },
    );
    expect(result.status).toBe("SUBMITTED");
    expect(result.positionId).toBeNull();

    const orders = await prisma.tradingOrder.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0].symbol).toBe("SPY");
    expect(orders[0].limitPrice).toBe(-0.85);
  });

  it("isDuplicateOrder returns true for same-day duplicate", async () => {
    const fakeIbkr = {} as any;
    await placeNewSpreadOrder(
      fakeIbkr,
      prisma,
      { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
      { dryRun: true },
    );
    const dup = await isDuplicateOrder(prisma, "SPY", 450, 445, "20260619");
    expect(dup).toBe(true);
  });

  it("placeNewSpreadOrder throws on duplicate", async () => {
    const fakeIbkr = {} as any;
    await placeNewSpreadOrder(
      fakeIbkr,
      prisma,
      { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
      { dryRun: true },
    );
    await expect(
      placeNewSpreadOrder(
        fakeIbkr,
        prisma,
        { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
        { dryRun: true },
      ),
    ).rejects.toThrow(/Duplicate/);
  });
});
```

**注意**: このテストはローカル DB を使う integration test。DB 接続が前提。CI で動かすなら別 setup が必要。

### Step 3: テスト実行

Run: `npm test -- order-manager 2>&1 | tail -10`
Expected: 3 passed

### Step 4: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 5: コミット

```bash
git add src/paper-trading/order-manager.ts src/paper-trading/__tests__/order-manager.test.ts
git commit -m "feat(paper-trading): order-manager 実装（Combo Order 発注 + 二重発注防止）

placeNewSpreadOrder():
- 二重発注チェック (DB 検索 + unique 制約の二重防御)
- IBKR で qualifyOptionContract → conId 取得
- Combo Order を NET_CREDIT で発注
- 結果を TradingOrder に記録、FILLED なら Position も作成
- dry-run mode: IBKR 発注をスキップして DB に SUBMITTED のみ記録

ユニットテスト 3 件: dry-run / duplicate detection / duplicate throws。
ローカル DB 接続が前提（vitest 内で Prisma 直接利用）。

Refs: KOH-454"
```

---

## Task 6: position-syncer.ts 実装

**Files:**
- Create: `src/paper-trading/position-syncer.ts`

### Step 1: 実装

```typescript
// src/paper-trading/position-syncer.ts
import { PrismaClient } from "@prisma/client";
import type { IBKRPosition, IBKRClient } from "./ibkr-client";

export interface PositionMismatch {
  type: "DB_NOT_IN_IBKR" | "IBKR_NOT_IN_DB";
  symbol: string;
  shortStrike?: number;
  longStrike?: number;
  expiry?: string;
}

/** IBKR の qty=0 を除外、option 側のレッグだけ抽出 */
export function filterActivePutSpreadLegs(positions: IBKRPosition[]): IBKRPosition[] {
  return positions.filter(
    (p) => p.quantity !== 0 && p.secType === "OPT" && p.right === "P",
  );
}

/**
 * IBKR の保有 option position と DB の OPEN Position を突き合わせる。
 *
 * Bull Put Credit Spread 1 件 = 2 leg (short put + long put)。
 * IBKR の各 leg を spread として再構築できないため、
 * 「DB に OPEN な Position が IBKR に存在するか」のチェックに留める。
 */
export async function reconcilePositions(
  ibkr: IBKRClient,
  prisma: PrismaClient,
): Promise<{ mismatches: PositionMismatch[]; ibkrLegs: IBKRPosition[]; dbOpenPositions: number }> {
  const ibkrPositions = await ibkr.getPositions();
  const ibkrLegs = filterActivePutSpreadLegs(ibkrPositions);

  const dbOpen = await prisma.position.findMany({ where: { state: "OPEN" } });

  const mismatches: PositionMismatch[] = [];

  // 各 DB の OPEN Position について、対応する short / long leg が IBKR にあるか確認
  for (const pos of dbOpen) {
    const expiryStr = pos.expiry.toISOString().slice(0, 10).replace(/-/g, "");
    const shortLeg = ibkrLegs.find(
      (l) => l.symbol === pos.symbol && l.strike === pos.shortStrike && l.expiry === expiryStr && l.quantity < 0,
    );
    const longLeg = ibkrLegs.find(
      (l) => l.symbol === pos.symbol && l.strike === pos.longStrike && l.expiry === expiryStr && l.quantity > 0,
    );

    if (!shortLeg || !longLeg) {
      mismatches.push({
        type: "DB_NOT_IN_IBKR",
        symbol: pos.symbol,
        shortStrike: pos.shortStrike,
        longStrike: pos.longStrike,
        expiry: expiryStr,
      });
    }
  }

  return { mismatches, ibkrLegs, dbOpenPositions: dbOpen.length };
}
```

### Step 2: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 3: コミット（テストは integration test 寄りで Task 11 で実検証）

```bash
git add src/paper-trading/position-syncer.ts
git commit -m "feat(paper-trading): position-syncer 実装（IBKR ↔ DB 同期）

reconcilePositions():
- IBKR の qty=0 (paper の残骸) を除外、OPT/P のみ抽出
- DB の state='OPEN' な Position を取得
- 各 DB Position について short/long leg が IBKR に存在するか確認
- 不一致は PositionMismatch[] で返す

実検証は Task 11 で daily-runner 経由で行う。

Refs: KOH-454"
```

---

## Task 7: daily-runner.ts スケルトン（ステップ 1-3）

**Files:**
- Create: `src/paper-trading/daily-runner.ts`

### Step 1: 最小スケルトン実装

```typescript
// src/paper-trading/daily-runner.ts
/**
 * IBKR Paper Trading 日次実行
 *
 * Usage:
 *   npx tsx src/paper-trading/daily-runner.ts                 # 通常実行
 *   npx tsx src/paper-trading/daily-runner.ts --dry-run        # 発注スキップ
 */

import { PrismaClient } from "@prisma/client";
import { IBKRClient } from "./ibkr-client";
import { isKillSwitchActive, getKillSwitchInfo } from "./kill-switch";
import { reconcilePositions, filterActivePutSpreadLegs } from "./position-syncer";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Daily runner start (dry-run=${DRY_RUN})`);

  // ── 1. kill switch チェック ──
  if (isKillSwitchActive()) {
    const info = getKillSwitchInfo();
    console.log(`⏸ Kill switch active: ${info.reason} (since ${info.createdAt?.toISOString()})`);
    process.exit(0);
  }

  const prisma = new PrismaClient();
  const ibkr = new IBKRClient({ clientId: 100 });

  // ── 2. IBKR 接続 + アカウント情報 ──
  console.log("Connecting to IBKR TWS...");
  await ibkr.connect();
  const accountSummary = await ibkr.getAccountSummary();
  console.log(`Account: NetLiq=$${accountSummary.netLiquidation.toLocaleString()}, BP=$${accountSummary.buyingPower.toLocaleString()}`);

  // ── 3. 既存ポジション同期 ──
  console.log("Reconciling positions...");
  const { mismatches, ibkrLegs, dbOpenPositions } = await reconcilePositions(ibkr, prisma);
  console.log(`  IBKR active legs: ${ibkrLegs.length}`);
  console.log(`  DB OPEN positions: ${dbOpenPositions}`);
  if (mismatches.length > 0) {
    console.error(`⚠ ${mismatches.length} position mismatches detected:`);
    for (const m of mismatches) {
      console.error(`  ${m.type}: ${m.symbol} ${m.shortStrike}/${m.longStrike} ${m.expiry}`);
    }
    // Phase E でこれを致命的扱いにする予定。Phase C では log のみ。
  }

  // TODO: ステップ 4-9 を後続タスクで追加

  await ibkr.disconnect();
  await prisma.$disconnect();

  const elapsed = Date.now() - startTime.getTime();
  console.log(`[${new Date().toISOString()}] Daily runner end (elapsed ${elapsed}ms)`);
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("❌ Daily runner failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
```

### Step 2: 動作確認（手動、port 7497 開放前提）

事前確認:
```bash
nc -zv 127.0.0.1 7497 2>&1 | head -1
```
Expected: `succeeded!`

NG なら TWS を起動。

Run:
```bash
npx tsx src/paper-trading/daily-runner.ts --dry-run 2>&1 | tail -15
```

Expected:
- `Daily runner start`
- `Account: NetLiq=$100,000` 等
- `IBKR active legs: 0` (no actual options held)
- `DB OPEN positions: 0`
- `Daily runner end`

エラー出る場合: TWS 起動確認、または `clientId` 衝突なら別の値に変更。

### Step 3: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 4: コミット

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): daily-runner.ts スケルトン (ステップ 1-3)

9 ステップ日次サイクルのうち 1-3 を実装:
- 1. kill switch チェック (.paper-trading-stop で即終了)
- 2. IBKR 接続 + アカウント情報取得
- 3. 既存ポジション同期 (IBKR ↔ DB)、不一致は console.error

ステップ 4-9 (close 評価 / DD stop / entry / DB 記録) は次タスクで追加。

--dry-run フラグで発注をスキップ可能（後続タスクで使用）。

Refs: KOH-454"
```

---

## Task 8: daily-runner.ts ステップ 4-5（close 評価 + DD stop）

**Files:**
- Modify: `src/paper-trading/daily-runner.ts`

### Step 1: ロジック追加

ステップ 3 の後、`// TODO` のところに以下を挿入:

```typescript
import dayjs from "dayjs";
import { evaluateSpread } from "../backtest/credit-spread/spread-evaluator";
import { calcDDStopState } from "../backtest/credit-spread/dd-stop";
import { US_CREDIT_SPREAD_DEFAULTS } from "../backtest/us/us-credit-spread-config";
import type { SimulatedSpread } from "../backtest/us/us-credit-spread-types";

// ... main 関数の中で、ステップ 3 の後に追加 ...

  // ── 4. live data 取得 (SPY / VIX) ──
  console.log("Fetching market data...");
  const spy = await ibkr.getMarketPrice("SPY");
  if (spy.last == null) {
    console.error("⚠ SPY price unavailable, skipping today's cycle");
    await ibkr.disconnect();
    await prisma.$disconnect();
    return;
  }
  let vix: number;
  try {
    vix = await ibkr.getVIX();
  } catch {
    console.error("⚠ VIX unavailable, skipping today's cycle");
    await ibkr.disconnect();
    await prisma.$disconnect();
    return;
  }
  const spotSpy = spy.last;
  const gspc = spotSpy * 10;
  console.log(`  SPY=${spotSpy}, VIX=${vix.toFixed(2)}, gspc=${gspc}`);

  // ── 5. 既存スプレッドの evaluateSpread ──
  const today = dayjs().format("YYYY-MM-DD");
  const dbOpenSpreads = await prisma.position.findMany({ where: { state: "OPEN" } });
  console.log(`Evaluating ${dbOpenSpreads.length} open spread(s)...`);

  for (const dbPos of dbOpenSpreads) {
    const expiryStr = dbPos.expiry.toISOString().slice(0, 10);
    const sp: SimulatedSpread = {
      underlyingSymbol: dbPos.symbol,
      entryDate: dbPos.entryDate.toISOString().slice(0, 10),
      expirationDate: expiryStr,
      entrySpotPrice: 0,           // 評価時は不要
      entryIV: 0,
      shortStrike: dbPos.shortStrike,
      longStrike: dbPos.longStrike,
      shortDeltaAtEntry: 0,
      creditReceived: dbPos.creditReceived,
      contracts: dbPos.contracts,
      state: "OPEN",
      totalCommissions: dbPos.totalCommission ?? 0,
    };

    const action = evaluateSpread(sp, {
      today,
      spotSpy,
      vix,
      config: US_CREDIT_SPREAD_DEFAULTS as any,
    });

    console.log(`  ${dbPos.symbol} ${dbPos.shortStrike}/${dbPos.longStrike}: ${action.action}${action.action !== "HOLD" ? `/${action.reason}` : ""}`);

    if (action.action === "CLOSE" || action.action === "EXPIRE") {
      // TODO: クローズ実発注（次タスク or Task 9）
      // 仮で SignalLog だけ記録
      await prisma.signalLog.create({
        data: {
          date: new Date(today),
          signalType: "CLOSE",
          reason: action.reason,
          details: { shortStrike: dbPos.shortStrike, longStrike: dbPos.longStrike, currentValue: (action as any).currentValue ?? null },
        },
      });
    }
  }

  // ── 6. equity 計算 + DD stop 状態遷移 ──
  // 簡易: cash = NetLiq - positionsValue（IBKR の値を使う）
  const netLiq = accountSummary.netLiquidation;
  const positionsValue = 0;  // 詳細計算は Phase C には不要、後続で
  const totalEquity = netLiq;

  // 直前の DailyEquitySnapshot から prevState を取得
  const lastSnapshot = await prisma.dailyEquitySnapshot.findFirst({
    orderBy: { date: "desc" },
  });
  const prevState = {
    runningPeak: lastSnapshot?.runningPeak ?? totalEquity,
    ddStopActive: lastSnapshot?.ddStopActive ?? false,
    ddStopActivatedDate: lastSnapshot?.ddStopActivatedDate?.toISOString().slice(0, 10) ?? null,
  };
  const ddState = calcDDStopState({
    today,
    totalEquity,
    prevState,
    config: US_CREDIT_SPREAD_DEFAULTS,
  });
  console.log(`DD stop: active=${ddState.ddStopActive} (transition=${ddState.transition}), peak=$${ddState.runningPeak.toLocaleString()}`);
```

### Step 2: 動作確認

Run: `npx tsx src/paper-trading/daily-runner.ts --dry-run 2>&1 | tail -25`

Expected:
- SPY/VIX 取得（取引時間中なら数値、時間外なら "skipping today's cycle"）
- DD stop の状態が表示される

### Step 3: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 4: コミット

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): daily-runner ステップ 4-5 追加 (live data + close 評価)

- 4. live data 取得 (SPY / VIX、null なら早期 exit)
- 5. 既存 OPEN spread を evaluateSpread で HOLD/CLOSE/EXPIRE 判定
  - CLOSE/EXPIRE は SignalLog に記録 (実発注は次タスク)
- 6. DailyEquitySnapshot から prev state 復元 → calcDDStopState

クローズ実発注はまだ未実装。次タスクで追加。

Refs: KOH-454"
```

---

## Task 9: daily-runner.ts ステップ 6-7（信号生成 + 新規発注）

**Files:**
- Modify: `src/paper-trading/daily-runner.ts`

### Step 1: 信号生成 + 発注ロジック追加

`// ── 6. equity 計算 + DD stop` ブロックの後に追加:

```typescript
import { generateEntrySignal } from "../backtest/credit-spread/signal-generator";
import { fetchSP500FromDB } from "../backtest/data-fetcher";
import { placeNewSpreadOrder } from "./order-manager";

// ... main 関数の中で、ステップ 6 の後に追加 ...

  // ── 7. 新規エントリー判定 ──
  // SMA50 計算: DB の ^GSPC 過去 50 日 close から
  const lookbackEnd = today;
  const lookbackStart = dayjs(today).subtract(75, "day").format("YYYY-MM-DD");  // 余裕を持って
  const gspcHistorical = await fetchSP500FromDB(lookbackStart, lookbackEnd, 0);
  const sortedDates = [...gspcHistorical.keys()].sort().slice(-50);  // 直近 50 日
  const sma50 = sortedDates.length === 50
    ? sortedDates.reduce((sum, d) => sum + (gspcHistorical.get(d) ?? 0), 0) / 50
    : null;
  console.log(`SMA50(GSPC) = ${sma50?.toFixed(2) ?? "(unavailable)"}`);

  // tradingDays は将来の expiry 候補が必要、簡易にカレンダー日を生成
  const tradingDays: string[] = [];
  for (let i = 0; i < 100; i++) {
    const d = dayjs(today).add(i, "day");
    const dow = d.day();
    if (dow !== 0 && dow !== 6) tradingDays.push(d.format("YYYY-MM-DD"));  // weekday only (荒い、祝日は無視)
  }

  // 信号生成
  const signal = generateEntrySignal({
    today,
    gspc,
    spotSpy,
    vix,
    smaGspc: sma50,
    cash: netLiq,
    openPositionCount: dbOpenSpreads.length,
    ddStopActive: ddState.ddStopActive,
    tradingDays,
    config: US_CREDIT_SPREAD_DEFAULTS,
  });

  console.log(`Entry signal: ${signal.reason}`);
  await prisma.signalLog.create({
    data: {
      date: new Date(today),
      signalType: "ENTRY",
      reason: signal.reason,
      details: {
        spy: spotSpy,
        vix,
        sma50,
        gspc,
        ddStopActive: ddState.ddStopActive,
        ...(signal.reason === "ENTERED" ? {
          shortStrike: signal.shortStrike,
          longStrike: signal.longStrike,
          expirationDate: signal.expirationDate,
          estimatedCredit: signal.estimatedCredit,
        } : {}),
      },
    },
  });

  if (signal.reason === "ENTERED") {
    console.log(`Placing order: SPY ${signal.expirationDate} P ${signal.shortStrike}/${signal.longStrike}, credit ~$${signal.estimatedCredit.toFixed(2)}`);
    const expiryYYYYMMDD = signal.expirationDate.replace(/-/g, "");
    try {
      const placed = await placeNewSpreadOrder(
        ibkr,
        prisma,
        {
          underlying: "SPY",
          shortStrike: signal.shortStrike,
          longStrike: signal.longStrike,
          expiry: expiryYYYYMMDD,
          contracts: US_CREDIT_SPREAD_DEFAULTS.contractsPerSpread,
          estimatedCredit: signal.estimatedCredit,
        },
        { dryRun: DRY_RUN },
      );
      console.log(`  Order: ibkrOrderId=${placed.ibkrOrderId}, status=${placed.status}, filledCredit=${placed.filledCredit ?? "-"}`);
    } catch (e: any) {
      console.error(`  ❌ Order failed: ${e.message}`);
      await prisma.errorLog.create({
        data: {
          category: "ORDER_FAILED",
          message: e.message,
          context: { signal },
        },
      });
    }
  }
```

### Step 2: 動作確認 (dry-run)

Run: `npx tsx src/paper-trading/daily-runner.ts --dry-run 2>&1 | tail -30`

Expected:
- SMA50 計算 (取得できれば数値)
- Entry signal: SKIP_* または ENTERED
- ENTERED の場合は dry-run で SUBMITTED が DB に記録される（IBKR 発注はスキップ）

### Step 3: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 4: コミット

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): daily-runner ステップ 6-7 追加 (信号生成 + 新規発注)

- 7. SMA50(GSPC) を DB から計算
- 8. generateEntrySignal で entry 判定 → SignalLog に記録
- 9. ENTERED の場合 placeNewSpreadOrder で発注 (dry-run 対応)
  - 失敗時は ErrorLog に記録

dry-run smoke test で SUBMITTED まで動作確認可能（NY 時間外でも可）。
実発注は Task 11 で NY 取引時間中に実施。

Refs: KOH-454"
```

---

## Task 10: daily-runner.ts ステップ 8-9（DailyEquitySnapshot + cleanup）

**Files:**
- Modify: `src/paper-trading/daily-runner.ts`

### Step 1: スナップショット保存追加

ステップ 7 の後、disconnect の前に追加:

```typescript
  // ── 8. DailyEquitySnapshot を保存 ──
  await prisma.dailyEquitySnapshot.upsert({
    where: { date: new Date(today) },
    create: {
      date: new Date(today),
      cash: netLiq,
      positionsValue,
      totalEquity,
      openPositionCount: dbOpenSpreads.length,
      ddStopActive: ddState.ddStopActive,
      runningPeak: ddState.runningPeak,
      ddStopActivatedDate: ddState.ddStopActivatedDate ? new Date(ddState.ddStopActivatedDate) : null,
    },
    update: {
      cash: netLiq,
      positionsValue,
      totalEquity,
      openPositionCount: dbOpenSpreads.length,
      ddStopActive: ddState.ddStopActive,
      runningPeak: ddState.runningPeak,
      ddStopActivatedDate: ddState.ddStopActivatedDate ? new Date(ddState.ddStopActivatedDate) : null,
    },
  });
  console.log(`DailyEquitySnapshot saved for ${today}`);
```

### Step 2: 動作確認

Run: `npx tsx src/paper-trading/daily-runner.ts --dry-run 2>&1 | tail -15`

Expected:
- 全 9 ステップ実行
- "DailyEquitySnapshot saved for YYYY-MM-DD"
- 正常終了

DB 確認:
```bash
psql -U kouheikameyama -h localhost -d auto_stock_trader -c "SELECT * FROM auto_us_stock_trader.\"DailyEquitySnapshot\" ORDER BY date DESC LIMIT 5;"
```

Expected: 1 行入っている（今日の日付、netLiq などが正しい値）。

### Step 3: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 4: 全 npm test 実行（リグレッション確認）

Run: `npm test 2>&1 | tail -5`
Expected: 全件 PASS（既存 + 新規 kill-switch 3 + order-manager 3）

### Step 5: コミット

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): daily-runner ステップ 8 完成 (DailyEquitySnapshot 保存)

upsert で同日 2 回実行しても idempotent。
これで 9 ステップ全部実装完了:
1. kill switch
2. IBKR 接続 + account
3. position 同期
4. live data (SPY/VIX)
5. close 評価
6. equity + DD stop
7. signal 生成
8. 新規発注
9. DailyEquitySnapshot 保存

dry-run smoke test で end-to-end 動作確認済 (NY 時間外可)。
実発注テストは Task 11 で NY 取引時間中に行う。

Refs: KOH-454"
```

---

## Task 11: 実発注 smoke test（NY 取引時間中、手動実施）

**Files:** なし（実行 + 検証のみ）

### 前提条件（重要）

- **NY 取引時間中** (NY 9:30-16:00 = JST 23:30-翌 5:00)
- TWS Paper Trading にログイン済、port 7497 開放
- `nc -zv 127.0.0.1 7497` succeeded
- ローカル DB が migrate 済（Task 1 完了）
- Paper account に既存ポジションなし or qty=0 のみ

### Step 1: 事前確認

```bash
# 港確認
nc -zv 127.0.0.1 7497

# DB に Position が入っていないことを確認
psql -U kouheikameyama -h localhost -d auto_stock_trader \
  -c "SELECT COUNT(*) FROM auto_us_stock_trader.\"Position\" WHERE state = 'OPEN';"
# Expected: count=0

# まずは dry-run で動作確認
npx tsx src/paper-trading/daily-runner.ts --dry-run 2>&1 | tail -25
```

### Step 2: 実発注実行（注意: 実際に paper account で order が出る）

```bash
npx tsx src/paper-trading/daily-runner.ts 2>&1 | tail -30
```

Expected:
- Entry signal: ENTERED with SPY ... strikes
- "Placing order: ..."
- "Order: ibkrOrderId=NNN, status=FILLED, filledCredit=$0.85" 等

### Step 3: TWS GUI で約定確認

TWS の Trades / Activity タブで:
- 新規 Combo Order が表示されている
- Filled になっている

### Step 4: DB 確認

```bash
psql -U kouheikameyama -h localhost -d auto_stock_trader <<'EOF'
SELECT * FROM auto_us_stock_trader."TradingOrder" ORDER BY "createdAt" DESC LIMIT 1;
SELECT * FROM auto_us_stock_trader."Position" ORDER BY "createdAt" DESC LIMIT 1;
SELECT * FROM auto_us_stock_trader."DailyEquitySnapshot" ORDER BY date DESC LIMIT 1;
SELECT * FROM auto_us_stock_trader."SignalLog" ORDER BY "createdAt" DESC LIMIT 3;
EOF
```

Expected:
- TradingOrder: status=FILLED, ibkrOrderId>0, filledPrice (negative)
- Position: state=OPEN, creditReceived (positive)
- DailyEquitySnapshot: 今日のスナップショット
- SignalLog: ENTRY/ENTERED の記録

### Step 5: 翌日（または翌セッション）に再実行で既存 position 認識を確認

ある程度時間を空けて再度実行:

```bash
npx tsx src/paper-trading/daily-runner.ts --dry-run 2>&1 | tail -25
```

Expected:
- "DB OPEN positions: 1"
- "Evaluating 1 open spread(s)..."
- "SPY <strikes>: HOLD" (or CLOSE/EXPIRE depending on conditions)

### Step 6: 検証コミット（empty）

```bash
git commit --allow-empty -m "verify(paper-trading): Phase C 実発注 smoke test 成功

NY 取引時間中に paper account で 1 spread を発注:
- TradingOrder: status=FILLED, ibkrOrderId=<X>, filledCredit=\$<Y>
- Position: state=OPEN
- DailyEquitySnapshot: 当日記録
- SignalLog: ENTRY/ENTERED

翌実行で既存 position が認識され HOLD 判定されることも確認。

Phase C 完了。Phase D (Slack 通知) / Phase E (エラー処理) で堅牢化。

Refs: KOH-454"
```

### Step 7（重要）: 検証後のクリーンアップ判断

Paper の position をどうするか決める:
- そのまま満期まで保持（自然な動作観察）→ Phase D-F の入力に使える
- 手動で TWS から close → DB の Position も `state="CLOSED"` に手 update

最初の検証では **そのまま保持** 推奨（運用 dry-run の続きとして観察）。

---

## Task 12: Linear KOH-454 作成

**Files:** なし（Linear 操作のみ）

### Step 1: Linear タスク作成

`mcp__linear-server__save_issue`:

- **Title:** `Paper Trading Phase C: 発注 + 状態管理`
- **Project:** Auto US Stock Trader
- **State:** Done（実発注 smoke test まで完了）
- **Description**:

```markdown
## 概要

KOH-453 (Phase B) 完了を受けて、Paper Trading Phase C として
発注 + 状態管理を実装。9 ステップ日次サイクルが paper account で
完結発注できる状態に。

## 実装内容

### DB schema 追加（5 テーブル）

`auto_us_stock_trader.{TradingOrder, Position, DailyEquitySnapshot, SignalLog, ErrorLog}`

ローカル + Railway 両方に migrate 済。

### 新規ファイル

- `src/paper-trading/kill-switch.ts` — `.paper-trading-stop` ファイル方式
- `src/paper-trading/order-manager.ts` — Combo Order 発注 + 二重発注検知 + DB 記録
- `src/paper-trading/position-syncer.ts` — IBKR ↔ DB 同期、qty=0 除外
- `src/paper-trading/daily-runner.ts` — 9 ステップ日次サイクル orchestrator
- `src/paper-trading/__tests__/{kill-switch,order-manager}.test.ts` — 6 件のユニットテスト

### IBKRClient 拡張

- `qualifyOptionContract(underlying, expiry, strike, right): Promise<conId>`
- `placeComboOrder(req): Promise<OrderResult>` — Combo Order 発注 + 約定待ち（5 分タイムアウト）

### 二重防御

- DB unique 制約: `(symbol, shortStrike, longStrike, expiry, submittedAt)`
- コードチェック: `isDuplicateOrder` で発注前に確認

### dry-run mode

`--dry-run` フラグで IBKR 発注をスキップ、DB だけ記録。
NY 時間外でも end-to-end 動作確認可能。

## 動作確認

NY 取引時間中の実発注 smoke test:
- TradingOrder: FILLED, ibkrOrderId 取得
- Position: state=OPEN で記録
- DailyEquitySnapshot: 当日の equity / DD 状態
- SignalLog: ENTRY/ENTERED + 当日の SPY/VIX/SMA

## 残課題（次フェーズ）

- Phase D: Slack 通知（skip も含め毎日 1 通、致命的事故は緊急色）
- Phase E: エラー処理（リトライ、想定外例外の grand catch、二重発注時の自動 kill switch）
- Phase F: 90 日 paper trading 観察
- Phase G: 最終評価 + 本番判断

## 学び

- Paper account default は \$100,000、KOH-451 backtest の \$3,300 とは規模差
  - 本タスクでは contractsPerSpread=1 維持、戦略の挙動だけ観察
- IBKR の qty=0 残骸 position はフィルタ必須
- Combo Order は NET_CREDIT (BUY action + 負の lmtPrice) で構築
- placeNewOrder の API は `@stoqey/ib` v1.5.x で OrderStatus update を Observable で監視

## 参考

- 設計: `docs/plans/2026-04-30-paper-trading-design.md`
- 実装プラン: `docs/plans/2026-04-30-paper-trading-phase-c-implementation-plan.md`
- KOH-452 (Phase A), KOH-453 (Phase B)
```

---

## 全 Task 完了基準

- ✅ Prisma migration が local + Railway 両方 deploy 済（5 テーブル）
- ✅ `npm test` 全件 PASS（既存 33 + 新規 6 = 39 件）
- ✅ `npm run typecheck` エラーなし
- ✅ `npx tsx src/paper-trading/daily-runner.ts --dry-run` が NY 時間外でも完走
- ✅ NY 取引時間中の実発注 smoke test が成功（TradingOrder=FILLED, Position OPEN）
- ✅ kill switch ファイル作成 → daily-runner が即終了することを確認
- ✅ Linear KOH-454 が Done

## DRY / YAGNI 原則の確認

- Slack 通知 / リトライ / 想定外例外 grand catch は Phase D/E で（YAGNI）
- 監視ダッシュボード / Web UI は実装しない
- Combo Order の修正発注（partial fill の追撃、order modification）は実装しない
- 既存 spread の自動クローズ（profit_target / stop_loss 検出時の reverse 発注）は SignalLog にだけ記録（Phase D で実装、Phase C はスコープ外）

## 次フェーズ

KOH-455 (Phase D): Slack 通知 + 週次 Markdown レポート
- 設計: `docs/plans/2026-04-30-paper-trading-design.md` (Phase D セクション)

## 注意事項

- **NY 取引時間外の発注は reject される**: Task 11 は時間制約あり
- **clientId 衝突**: 別の paper trading セッションが clientId=100 を使っていたら別の値に変える
- **Paper account の equity 規模**: $100k vs backtest $3.3k で 30 倍。CAGR/PnL の絶対値は backtest 通りにならない（戦略の挙動・約定品質を観察するのが本タスクの目的）

## 参考

- 設計書: `docs/plans/2026-04-30-paper-trading-design.md` (Phase C セクション、9 ステップ詳細)
- KOH-452 (Phase A): `docs/plans/2026-04-30-paper-trading-phase-a-implementation-plan.md`
- KOH-453 (Phase B): `docs/plans/2026-04-30-paper-trading-phase-b-implementation-plan.md`
- @stoqey/ib placeNewOrder: https://stoqey.github.io/ib/api-next-IBApiNext.html
