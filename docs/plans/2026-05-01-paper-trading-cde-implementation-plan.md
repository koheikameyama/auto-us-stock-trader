# Paper Trading Phase C/D/E 統合実装プラン

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Phase C 残（クローズ発注）+ Phase D（Slack 通知 + 週次レポート）+ Phase E（エラー処理 + テスト）を 1 ブランチで完成させ、IBKR Paper Trading で自律運用可能な状態にする。

**Architecture:** 既存 [src/paper-trading/](../../src/paper-trading/) (Phase B/C コア、1064 行) に対して、(1) order-manager に `closeSpreadOrder` 追加、(2) `slack-notifier.ts` / `weekly-report.ts` / `with-retry.ts` を新規作成、(3) daily-runner.ts の各ステップに通知 + リトライ + grand catch を差し込む。新規 dep は `node-fetch` 不要（Node 20+ の global fetch 使用）。

**Tech Stack:** TypeScript / vitest / @stoqey/ib / @prisma/client / dayjs / Slack Incoming Webhook

**Branch:** `feature/koh-454-paper-trading-cde`

**Linear:** KOH-454

---

## 前提コンテキスト

### 既存コード状態

| ファイル | 状態 |
|---|---|
| [src/paper-trading/daily-runner.ts](../../src/paper-trading/daily-runner.ts) | 273 行、9 ステップ orchestrator。Step 4 (close 発注) 未実装、grand catch なし、Slack 通知なし |
| [src/paper-trading/order-manager.ts](../../src/paper-trading/order-manager.ts) | 144 行、`placeNewSpreadOrder` のみ。`closeSpreadOrder` 未実装 |
| [src/paper-trading/ibkr-client.ts](../../src/paper-trading/ibkr-client.ts) | 482 行、`placeComboOrder` 実装済（debit/credit 両対応） |
| [src/paper-trading/position-syncer.ts](../../src/paper-trading/position-syncer.ts) | 59 行、mismatch 検知のみ |
| [src/paper-trading/kill-switch.ts](../../src/paper-trading/kill-switch.ts) | 16 行 |
| [src/paper-trading/__tests__/](../../src/paper-trading/__tests__/) | kill-switch.test.ts, order-manager.test.ts |

### Prisma schema 関連 model

`auto_us_stock_trader` schema:
- `Position` (state: "OPEN" | "CLOSED" | "EXPIRED", closeReason, closeSpreadPrice, netPnl, totalCommission)
- `TradingOrder` (orderType: "ENTRY" | "EXIT", positionId)
- `DailyEquitySnapshot`, `SignalLog`, `ErrorLog`

### 環境変数

- `DATABASE_URL`: 既存
- `SLACK_WEBHOOK_URL`: **新規追加（.env / GitHub secrets）** — Phase D で使用

### 設計の起点

[docs/plans/2026-04-30-paper-trading-design.md](2026-04-30-paper-trading-design.md) の Phase C/D/E セクション。本プランはそれを実装手順に分解したもの。

---

## Phase C-2: クローズ発注（残作業）

### Task 1: `closeSpreadOrder()` のテスト先行

**Files:**
- Test: `src/paper-trading/__tests__/order-manager.test.ts` (既存に追加)

**Step 1: 失敗テストを書く**

`order-manager.test.ts` の末尾に `describe("closeSpreadOrder")` ブロックを追加:

```typescript
describe("closeSpreadOrder", () => {
  it("submits a debit combo order (BUY back short, SELL long) and updates Position state to CLOSED", async () => {
    const mockIbkr = {
      qualifyOptionContract: vi.fn()
        .mockResolvedValueOnce(111) // short put conId
        .mockResolvedValueOnce(222), // long put conId
      placeComboOrder: vi.fn().mockResolvedValue({
        ibkrOrderId: 999,
        status: "FILLED",
        filledPrice: 0.30,    // debit (positive limit)
        commission: 1.20,
      }),
    } as any;

    const position = await prisma.position.create({
      data: {
        symbol: "SPY",
        shortStrike: 480,
        longStrike: 475,
        expiry: new Date("2026-06-19"),
        contracts: 1,
        creditReceived: 0.85,
        entryDate: new Date("2026-05-01"),
        state: "OPEN",
        totalCommission: 1.20,
      },
    });

    const result = await closeSpreadOrder(mockIbkr, prisma, {
      positionId: position.id,
      reason: "profit_target",
      currentSpreadValue: 0.30,
    });

    expect(result.status).toBe("FILLED");
    expect(mockIbkr.placeComboOrder).toHaveBeenCalledWith(expect.objectContaining({
      legs: [
        expect.objectContaining({ conId: 111, action: "BUY" }),
        expect.objectContaining({ conId: 222, action: "SELL" }),
      ],
      limitPrice: 0.30, // positive = NET DEBIT
    }));

    const updated = await prisma.position.findUnique({ where: { id: position.id } });
    expect(updated?.state).toBe("CLOSED");
    expect(updated?.closeReason).toBe("profit_target");
    expect(updated?.closeSpreadPrice).toBe(0.30);
    // netPnl = (creditReceived - closeSpreadPrice) * 100 - totalCommission - exit commission
    // = (0.85 - 0.30) * 100 - 1.20 - 1.20 = 55 - 2.40 = 52.60
    expect(updated?.netPnl).toBeCloseTo(52.60, 2);

    const order = await prisma.tradingOrder.findFirst({
      where: { ibkrOrderId: 999 },
    });
    expect(order?.orderType).toBe("EXIT");
    expect(order?.positionId).toBe(position.id);
  });

  it("throws if Position is already CLOSED (duplicate close prevention)", async () => {
    const position = await prisma.position.create({
      data: {
        symbol: "SPY", shortStrike: 480, longStrike: 475,
        expiry: new Date("2026-06-19"), contracts: 1, creditReceived: 0.85,
        entryDate: new Date("2026-05-01"), state: "CLOSED",
      },
    });
    await expect(
      closeSpreadOrder({} as any, prisma, {
        positionId: position.id, reason: "profit_target", currentSpreadValue: 0.30,
      }),
    ).rejects.toThrow(/already closed/i);
  });
});
```

**Step 2: テストを走らせて失敗確認**

Run: `npm test -- order-manager`
Expected: FAIL with "closeSpreadOrder is not exported" / "function not defined"

**Step 3: 最小実装**

`src/paper-trading/order-manager.ts` 末尾に追加:

```typescript
export interface CloseSpreadInput {
  positionId: string;
  reason: "profit_target" | "stop_loss";
  currentSpreadValue: number; // positive = debit to close
}

export async function closeSpreadOrder(
  ibkr: IBKRClient,
  prisma: PrismaClient,
  input: CloseSpreadInput,
): Promise<PlacedSpread> {
  const position = await prisma.position.findUnique({ where: { id: input.positionId } });
  if (!position) throw new Error(`Position not found: ${input.positionId}`);
  if (position.state !== "OPEN") {
    throw new Error(`Position ${input.positionId} is already closed (state=${position.state})`);
  }

  const expiryYYYYMMDD = position.expiry.toISOString().slice(0, 10).replace(/-/g, "");
  const shortConId = await ibkr.qualifyOptionContract(position.symbol, expiryYYYYMMDD, position.shortStrike, "P");
  const longConId = await ibkr.qualifyOptionContract(position.symbol, expiryYYYYMMDD, position.longStrike, "P");

  // close = reverse of entry: BUY back the short, SELL the long, NET DEBIT (positive limit)
  const result = await ibkr.placeComboOrder({
    underlying: position.symbol,
    legs: [
      { conId: shortConId, action: "BUY",  ratio: 1 },
      { conId: longConId,  action: "SELL", ratio: 1 },
    ],
    totalQuantity: position.contracts,
    limitPrice: input.currentSpreadValue, // positive
    tif: "DAY",
  });

  const order = await prisma.tradingOrder.create({
    data: {
      ibkrOrderId: result.ibkrOrderId,
      symbol: position.symbol,
      orderType: "EXIT",
      shortStrike: position.shortStrike,
      longStrike: position.longStrike,
      expiry: position.expiry,
      quantity: position.contracts,
      limitPrice: input.currentSpreadValue,
      status: result.status,
      submittedAt: new Date(),
      filledAt: result.status === "FILLED" ? new Date() : null,
      filledPrice: result.filledPrice,
      commission: result.commission,
      positionId: position.id,
    },
  });

  if (result.status === "FILLED" && result.filledPrice != null) {
    const exitCommission = result.commission ?? 0;
    const totalCommission = (position.totalCommission ?? 0) + exitCommission;
    const netPnl = (position.creditReceived - result.filledPrice) * 100 * position.contracts - totalCommission;
    await prisma.position.update({
      where: { id: position.id },
      data: {
        state: "CLOSED",
        closeDate: new Date(),
        closeReason: input.reason,
        closeSpreadPrice: result.filledPrice,
        netPnl,
        totalCommission,
      },
    });
    return {
      ibkrOrderId: result.ibkrOrderId,
      status: result.status,
      filledCredit: -result.filledPrice, // for symmetry with placeNewSpreadOrder
      positionId: position.id,
    };
  }

  return {
    ibkrOrderId: result.ibkrOrderId,
    status: result.status,
    filledCredit: null,
    positionId: position.id,
  };
}
```

**Step 4: テストパス確認**

Run: `npm test -- order-manager`
Expected: PASS

**Step 5: Commit**

```bash
git add src/paper-trading/order-manager.ts src/paper-trading/__tests__/order-manager.test.ts
git commit -m "feat(paper-trading): add closeSpreadOrder for exit/stop-loss orders"
```

---

### Task 2: EXPIRE 処理（発注なし、Position 状態だけ更新）

**Files:**
- Modify: `src/paper-trading/order-manager.ts`
- Test: `src/paper-trading/__tests__/order-manager.test.ts`

**Step 1: 失敗テスト**

```typescript
describe("expirePosition", () => {
  it("marks Position as EXPIRED with finalValue and netPnl, no IBKR call", async () => {
    const position = await prisma.position.create({
      data: { /* OPEN, creditReceived 0.85, totalCommission 1.20 */ },
    });
    await expirePosition(prisma, {
      positionId: position.id,
      reason: "expired_worthless",
      finalValue: 0,
    });
    const updated = await prisma.position.findUnique({ where: { id: position.id } });
    expect(updated?.state).toBe("EXPIRED");
    expect(updated?.closeReason).toBe("expired_worthless");
    expect(updated?.netPnl).toBeCloseTo(0.85 * 100 - 1.20, 2); // = 83.80
  });
});
```

**Step 2: 実装**

```typescript
export async function expirePosition(
  prisma: PrismaClient,
  input: { positionId: string; reason: "expired_worthless" | "expired_max_loss" | "expired_partial"; finalValue: number },
): Promise<void> {
  const position = await prisma.position.findUnique({ where: { id: input.positionId } });
  if (!position) throw new Error(`Position not found: ${input.positionId}`);
  if (position.state !== "OPEN") return; // idempotent
  const totalCommission = position.totalCommission ?? 0;
  const netPnl = (position.creditReceived - input.finalValue) * 100 * position.contracts - totalCommission;
  await prisma.position.update({
    where: { id: position.id },
    data: {
      state: "EXPIRED",
      closeDate: new Date(),
      closeReason: input.reason,
      closeSpreadPrice: input.finalValue,
      netPnl,
    },
  });
}
```

**Step 3: テストパス確認 + Commit**

```bash
git add src/paper-trading/order-manager.ts src/paper-trading/__tests__/order-manager.test.ts
git commit -m "feat(paper-trading): add expirePosition for expiry-day cleanup"
```

---

### Task 3: daily-runner.ts に close/expire を配線

**Files:**
- Modify: `src/paper-trading/daily-runner.ts:80-127`

**Step 1: 既存ループを置き換え**

[daily-runner.ts:111-126](../../src/paper-trading/daily-runner.ts#L111-L126) の `if (action.action === "CLOSE" || action.action === "EXPIRE")` ブロックを以下に書き換え:

```typescript
if (action.action === "CLOSE") {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would close: reason=${action.reason}, value=${action.currentValue}`);
  } else {
    try {
      const closed = await closeSpreadOrder(ibkr, prisma, {
        positionId: dbPos.id,
        reason: action.reason,
        currentSpreadValue: action.currentValue,
      });
      console.log(`  Closed ibkrOrderId=${closed.ibkrOrderId}, status=${closed.status}`);
    } catch (e: any) {
      console.error(`  ❌ Close failed: ${e.message}`);
      await prisma.errorLog.create({
        data: { category: "CLOSE_FAILED", message: e.message, context: { positionId: dbPos.id, reason: action.reason } },
      });
    }
  }
} else if (action.action === "EXPIRE") {
  await expirePosition(prisma, {
    positionId: dbPos.id,
    reason: action.reason,
    finalValue: action.finalValue,
  });
  console.log(`  Expired: reason=${action.reason}, value=${action.finalValue}`);
}

await prisma.signalLog.create({
  data: {
    date: new Date(today),
    signalType: action.action,
    reason: action.action === "HOLD" ? "hold" : action.reason,
    details: {
      shortStrike: dbPos.shortStrike,
      longStrike: dbPos.longStrike,
      currentValue: (action as any).currentValue ?? null,
      finalValue: (action as any).finalValue ?? null,
    },
  },
});
```

**Step 2: import 追加**

```typescript
import { placeNewSpreadOrder, closeSpreadOrder, expirePosition } from "./order-manager";
```

**Step 3: typecheck + 既存テスト pass 確認**

```bash
npm run typecheck
npm test
```

**Step 4: dry-run smoke test**

```bash
npx tsx src/paper-trading/daily-runner.ts --dry-run
```

Expected: TWS 起動済なら、step 1〜9 まで進行 (close/expire 対象がなければ既存通り)

**Step 5: Commit**

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): wire CLOSE/EXPIRE handling in daily-runner"
```

---

### Task 4: 二重クローズ防止（コード側）

**Note:** Task 1 で既に `state !== "OPEN"` チェックを実装済み。追加で「同日に EXIT 注文が submitted 済みなら再発注しない」チェックを入れる:

**Files:**
- Modify: `src/paper-trading/order-manager.ts` (closeSpreadOrder の冒頭)

```typescript
// ... after position state check ...
const todayStart = dayjs().startOf("day").toDate();
const existingExit = await prisma.tradingOrder.findFirst({
  where: {
    positionId: position.id,
    orderType: "EXIT",
    submittedAt: { gte: todayStart },
  },
});
if (existingExit) {
  throw new Error(`EXIT order already submitted today for position ${position.id} (orderId=${existingExit.ibkrOrderId})`);
}
```

**Step 2: 既存テストに追加**

```typescript
it("throws if EXIT order already submitted today", async () => {
  const position = await prisma.position.create({ data: { /* OPEN */ } });
  await prisma.tradingOrder.create({
    data: { ibkrOrderId: 100, symbol: "SPY", orderType: "EXIT",
            shortStrike: 480, longStrike: 475, expiry: new Date("2026-06-19"),
            quantity: 1, limitPrice: 0.30, status: "SUBMITTED",
            submittedAt: new Date(), positionId: position.id },
  });
  await expect(
    closeSpreadOrder({} as any, prisma, {
      positionId: position.id, reason: "profit_target", currentSpreadValue: 0.30,
    }),
  ).rejects.toThrow(/already submitted/i);
});
```

**Step 3: Commit**

```bash
git add src/paper-trading/order-manager.ts src/paper-trading/__tests__/order-manager.test.ts
git commit -m "feat(paper-trading): prevent duplicate EXIT orders on same day"
```

---

## Phase D: Slack 通知 + 週次レポート

### Task 5: `slack-notifier.ts` モジュール

**Files:**
- Create: `src/paper-trading/slack-notifier.ts`
- Test: `src/paper-trading/__tests__/slack-notifier.test.ts`

**Step 1: テスト先行**

```typescript
// __tests__/slack-notifier.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSlack, formatEntrySuccess, formatCloseSuccess, formatErrorAlert } from "../slack-notifier";

describe("sendSlack", () => {
  const fetchMock = vi.fn();
  const origFetch = global.fetch;

  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as any);
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete process.env.SLACK_WEBHOOK_URL;
    (global as any).fetch = origFetch;
  });

  it("posts JSON payload to webhook URL", async () => {
    await sendSlack({ text: "hello", level: "info" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("hello");
  });

  it("no-op if SLACK_WEBHOOK_URL not set", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    await sendSlack({ text: "x", level: "info" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw if webhook fails (best effort)", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(sendSlack({ text: "x", level: "info" })).resolves.toBeUndefined();
  });
});

describe("formatters", () => {
  it("formatEntrySuccess includes strike + credit", () => {
    const msg = formatEntrySuccess({ shortStrike: 480, longStrike: 475, expiry: "20260619", filledCredit: 0.85 });
    expect(msg).toContain("480/475");
    expect(msg).toContain("$0.85");
  });
  // ... similar for close, error, etc.
});
```

**Step 2: 実装**

```typescript
// src/paper-trading/slack-notifier.ts
export type Level = "info" | "warn" | "error" | "critical";

export interface SlackMessage {
  text: string;
  level: Level;
}

const COLOR: Record<Level, string> = {
  info: "good",
  warn: "warning",
  error: "danger",
  critical: "danger",
};

export async function sendSlack(msg: SlackMessage): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return; // no-op in tests / unconfigured envs
  const prefix = msg.level === "critical" ? "<!channel> 🚨 " : msg.level === "error" ? "❌ " : msg.level === "warn" ? "⚠️ " : "✅ ";
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: prefix + msg.text,
        attachments: [{ color: COLOR[msg.level], text: msg.text }],
      }),
    });
  } catch {
    // best-effort: do not let notification failure crash the runner
  }
}

export function formatEntrySuccess(p: { shortStrike: number; longStrike: number; expiry: string; filledCredit: number | null }) {
  return `Entry: SPY P ${p.shortStrike}/${p.longStrike} ${p.expiry} credit=$${(p.filledCredit ?? 0).toFixed(2)}`;
}
export function formatEntrySkip(reason: string, ctx: { spy: number; vix: number; sma50?: number | null }) {
  return `Skip entry (${reason}): SPY=${ctx.spy} VIX=${ctx.vix.toFixed(2)} SMA50=${ctx.sma50?.toFixed(2) ?? "n/a"}`;
}
export function formatCloseSuccess(p: { shortStrike: number; longStrike: number; reason: string; netPnl: number | null; daysHeld: number }) {
  return `Close (${p.reason}): SPY P ${p.shortStrike}/${p.longStrike} pnl=$${(p.netPnl ?? 0).toFixed(2)} days=${p.daysHeld}`;
}
export function formatExpire(p: { shortStrike: number; longStrike: number; reason: string; netPnl: number | null }) {
  return `Expired (${p.reason}): SPY P ${p.shortStrike}/${p.longStrike} pnl=$${(p.netPnl ?? 0).toFixed(2)}`;
}
export function formatDDStop(action: "ACTIVATED" | "DEACTIVATED", peak: number, equity: number) {
  return `DD stop ${action}: peak=$${peak.toFixed(0)} equity=$${equity.toFixed(0)} drawdown=${((1 - equity / peak) * 100).toFixed(2)}%`;
}
export function formatDailySummary(s: { date: string; openCount: number; equity: number; dailyPnl: number }) {
  return `Daily summary ${s.date}: open=${s.openCount} equity=$${s.equity.toFixed(0)} ΔPnL=$${s.dailyPnl.toFixed(2)}`;
}
export function formatErrorAlert(category: string, message: string, ctx?: object) {
  const ctxStr = ctx ? ` ctx=${JSON.stringify(ctx)}` : "";
  return `${category}: ${message}${ctxStr}`;
}
export function formatKillSwitch(reason: string) {
  return `Kill switch active: ${reason}`;
}
export function formatDuplicateOrder(detail: string) {
  return `DUPLICATE ORDER DETECTED: ${detail}`;
}
```

**Step 3: テスト pass + Commit**

```bash
npm test -- slack-notifier
git add src/paper-trading/slack-notifier.ts src/paper-trading/__tests__/slack-notifier.test.ts
git commit -m "feat(paper-trading): add slack-notifier with 8 message formatters"
```

---

### Task 6: daily-runner に通知を配線

**Files:**
- Modify: `src/paper-trading/daily-runner.ts`

各イベントポイントで `await sendSlack(...)` を呼ぶ:

| イベント | 配線位置 | level |
|---|---|---|
| kill switch active | step 1 | warn |
| 接続エラー後 abort | step 2 catch | error |
| position mismatch | step 3 | warn |
| close success | step 4 | info |
| expire | step 4 | info |
| close failed | step 4 catch | error |
| DD stop transition | step 5 | warn |
| entry skip | step 6 (reason !== ENTERED) | info |
| entry success | step 7 (FILLED) | info |
| entry failed | step 7 catch | error |
| 二重発注検知 | step 7 catch (Duplicate) | critical |
| daily summary | step 8 末尾 | info |
| 想定外例外 | grand catch (Task 9) | critical |

**Step 1: 上記ポイントを順次追加**（1 ステップ 1 通の差し込み）

**Step 2: dry-run で SLACK_WEBHOOK_URL を未設定にして console 出力だけ確認**

**Step 3: SLACK_WEBHOOK_URL を一時的に test webhook に設定して 1 通だけ受信確認**（任意）

**Step 4: Commit**

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): wire slack notifications across daily-runner steps"
```

---

### Task 7: 週次レポートスクリプト

**Files:**
- Create: `src/paper-trading/weekly-report.ts`
- Test: `src/paper-trading/__tests__/weekly-report.test.ts` (任意、純関数だけ)

**Step 1: 仕様**

毎週土曜 JST 朝 cron で起動想定。出力先: `docs/paper-trading/weekly-YYYY-Www.md`

内容:
- 期間: 今週の月〜金
- 累計取引数 / win / loss / win rate
- 累計 PnL / 平均 PnL / max gain / max loss
- 現在のオープンポジション一覧
- DailyEquitySnapshot の equity curve（簡易、前週比 + 累計）
- backtest 整合性: 同期間の backtest を走らせて PnL 比較（任意、Phase D 完了基準には含めない）

**Step 2: 実装スケルトン**

```typescript
// src/paper-trading/weekly-report.ts
import { PrismaClient } from "@prisma/client";
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const prisma = new PrismaClient();
  const today = dayjs();
  const monday = today.startOf("week").add(1, "day"); // ISO Monday
  const friday = monday.add(4, "day");
  const weekLabel = `${today.year()}-W${String(today.isoWeek?.() ?? today.week()).padStart(2, "0")}`;

  const closedThisWeek = await prisma.position.findMany({
    where: { closeDate: { gte: monday.toDate(), lte: friday.endOf("day").toDate() } },
  });
  const open = await prisma.position.findMany({ where: { state: "OPEN" } });
  const snapshots = await prisma.dailyEquitySnapshot.findMany({
    where: { date: { gte: monday.toDate(), lte: friday.toDate() } },
    orderBy: { date: "asc" },
  });

  const wins = closedThisWeek.filter((p) => (p.netPnl ?? 0) > 0).length;
  const losses = closedThisWeek.filter((p) => (p.netPnl ?? 0) <= 0).length;
  const totalPnl = closedThisWeek.reduce((s, p) => s + (p.netPnl ?? 0), 0);

  const md = `# Paper Trading Weekly Report — ${weekLabel}

期間: ${monday.format("YYYY-MM-DD")} 〜 ${friday.format("YYYY-MM-DD")}

## サマリー

- クローズ件数: ${closedThisWeek.length} (win=${wins}, loss=${losses})
- 累計 PnL: $${totalPnl.toFixed(2)}
- 平均 PnL: $${(totalPnl / Math.max(1, closedThisWeek.length)).toFixed(2)}
- オープン: ${open.length} 件

## オープンポジション

${open.map((p) => `- SPY ${p.shortStrike}/${p.longStrike} exp=${p.expiry.toISOString().slice(0, 10)} credit=$${p.creditReceived}`).join("\n") || "(none)"}

## Equity Curve

| date | equity | open | DD stop |
|---|---|---|---|
${snapshots.map((s) => `| ${s.date.toISOString().slice(0, 10)} | $${s.totalEquity.toFixed(0)} | ${s.openPositionCount} | ${s.ddStopActive ? "✓" : ""} |`).join("\n")}
`;

  const outDir = path.resolve("docs/paper-trading");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `weekly-${weekLabel}.md`);
  fs.writeFileSync(outPath, md);
  console.log(`Wrote ${outPath}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Step 3: 手動実行確認**

```bash
npx tsx src/paper-trading/weekly-report.ts
```

DB が空でも空のレポートが書けることを確認。

**Step 4: Commit**

```bash
git add src/paper-trading/weekly-report.ts docs/paper-trading
git commit -m "feat(paper-trading): add weekly Markdown report generator"
```

---

## Phase E: エラー処理 + テスト

### Task 8: `withRetry` ヘルパー

**Files:**
- Create: `src/paper-trading/with-retry.ts`
- Test: `src/paper-trading/__tests__/with-retry.test.ts`

**Step 1: テスト先行**

```typescript
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../with-retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const r = await withRetry(fn, { retries: 3, intervalMs: 0 });
    expect(r).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to N times then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(withRetry(fn, { retries: 3, intervalMs: 0 })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("returns on second attempt if first fails", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const r = await withRetry(fn, { retries: 3, intervalMs: 0 });
    expect(r).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
```

**Step 2: 実装**

```typescript
// src/paper-trading/with-retry.ts
export interface RetryOptions {
  retries: number;
  intervalMs: number;
  onError?: (err: unknown, attempt: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      opts.onError?.(e, attempt);
      if (attempt < opts.retries) {
        await new Promise((r) => setTimeout(r, opts.intervalMs));
      }
    }
  }
  throw lastErr;
}
```

**Step 3: pass + Commit**

```bash
npm test -- with-retry
git add src/paper-trading/with-retry.ts src/paper-trading/__tests__/with-retry.test.ts
git commit -m "feat(paper-trading): add withRetry helper"
```

---

### Task 9: grand catch + ErrorLog

**Files:**
- Modify: `src/paper-trading/daily-runner.ts:267-273`

**Step 1: main() を try/catch でラップ**

`daily-runner.ts` 末尾の `main().then(...).catch(...)` を以下に置き換え:

```typescript
main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("❌ Daily runner failed:", e?.message ?? e);
    if (e?.stack) console.error(e.stack);
    try {
      const prisma = new PrismaClient();
      await prisma.errorLog.create({
        data: {
          category: "UNCAUGHT_EXCEPTION",
          message: String(e?.message ?? e),
          context: { stack: e?.stack ?? null },
        },
      });
      await prisma.$disconnect();
    } catch (logErr) {
      console.error("Failed to write ErrorLog:", logErr);
    }
    try {
      await sendSlack({
        text: formatErrorAlert("UNCAUGHT_EXCEPTION", String(e?.message ?? e)),
        level: "critical",
      });
    } catch {}
    process.exit(1);
  });
```

**Step 2: Commit**

```bash
git add src/paper-trading/daily-runner.ts
git commit -m "feat(paper-trading): grand catch with ErrorLog + critical Slack alert"
```

---

### Task 10: IBKR 操作を withRetry でラップ

**Files:**
- Modify: `src/paper-trading/daily-runner.ts`

対象（design doc Phase E のリトライ表に従う）:

| 操作 | retries | intervalMs |
|---|---|---|
| `ibkr.connect()` | 3 | 10_000 |
| `ibkr.getAccountSummary()` / `getPositions()` / `getMarketPrice()` / `getVIX()` | 3 | 5_000 |

例 (step 2):

```typescript
await withRetry(() => ibkr.connect(), { retries: 3, intervalMs: 10_000 });
const accountSummary = await withRetry(() => ibkr.getAccountSummary(), { retries: 3, intervalMs: 5_000 });
```

**Step 1: 該当箇所を順次置き換え**

- `ibkr.connect()` (1 箇所)
- `ibkr.getAccountSummary()` (1 箇所)
- `ibkr.getMarketPrice("SPY")` (1 箇所)
- `ibkr.getVIX()` (1 箇所)

`getPositions()` は内部で `position-syncer` から呼ばれているため、`reconcilePositions(ibkr, prisma)` の呼び出し側で `withRetry` するか、`reconcilePositions` の内部に組み込む（後者推奨、PR レビュー時に判断）。

**Step 2: import 追加 + dry-run 動作確認**

**Step 3: Commit**

```bash
git add src/paper-trading/daily-runner.ts src/paper-trading/position-syncer.ts
git commit -m "feat(paper-trading): retry IBKR operations on transient failures"
```

---

### Task 11: daily-runner integration test (mock IBKR)

**Files:**
- Create: `src/paper-trading/__tests__/daily-runner.integration.test.ts`

**Step 1: 仕様**

mock IBKR (in-memory) で 1 サイクル実行し、DailyEquitySnapshot / SignalLog / Position が DB に正しく書かれることを確認。実 fetch は呼ばない（SLACK_WEBHOOK_URL 未設定で no-op）。

**Step 2: スケルトン**

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// daily-runner を直接 import すると process.exit が呼ばれるので、
// runDailyCycle(ibkr, prisma) 関数として exportable にリファクタが必要。
// または child_process.spawn で別プロセス実行 + 環境変数で IBKR mock を注入。
//
// ★ 実装方針: daily-runner.ts の main() を runDailyCycle({ ibkr, prisma, today, dryRun }) に
//   抽出し、CLI entry は薄いラッパーにする。テストは runDailyCycle を直接呼ぶ。
```

**Step 3: daily-runner.ts のリファクタ**

```typescript
export interface DailyCycleDeps { ibkr: IBKRClient; prisma: PrismaClient; today: string; dryRun: boolean; }
export async function runDailyCycle(deps: DailyCycleDeps): Promise<void> { /* 既存 main() の中身 */ }

async function main() {
  const ibkr = new IBKRClient({ clientId: 100 });
  const prisma = new PrismaClient();
  await runDailyCycle({ ibkr, prisma, today: dayjs().format("YYYY-MM-DD"), dryRun: DRY_RUN });
  await ibkr.disconnect();
  await prisma.$disconnect();
}
```

**Step 4: テスト**

```typescript
const mockIbkr = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  isConnected: () => true,
  getAccountSummary: vi.fn().mockResolvedValue({
    netLiquidation: 100_000, totalCashValue: 100_000, buyingPower: 400_000, availableFunds: 100_000,
  }),
  getPositions: vi.fn().mockResolvedValue([]),
  getMarketPrice: vi.fn().mockResolvedValue({ bid: 480, ask: 480.05, last: 480.02 }),
  getVIX: vi.fn().mockResolvedValue(15.5),
} as any;

// fetchIndexFromDB を vi.mock(...) でスタブ：50 日分の GSPC を返す
vi.mock("../../backtest/data-fetcher", () => ({
  fetchIndexFromDB: vi.fn().mockResolvedValue(new Map(/* 50 entries */)),
}));

it("runs end-to-end without error and writes DailyEquitySnapshot", async () => {
  await runDailyCycle({ ibkr: mockIbkr, prisma, today: "2026-05-01", dryRun: true });
  const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
  expect(snap?.totalEquity).toBe(100_000);
});
```

**Step 5: pass 確認 + Commit**

```bash
npm test -- daily-runner.integration
git add src/paper-trading/daily-runner.ts src/paper-trading/__tests__/daily-runner.integration.test.ts
git commit -m "test(paper-trading): daily-runner integration test with mock IBKR"
```

---

## Smoke Test (NY 取引時間中、手動)

### Task 12: 実発注スモーク

**前提:**
- TWS Paper Trading が `localhost:7497` で起動
- DB に既存 OPEN positions が 0 件か、テスト用の 1 件のみ
- `.env` に `SLACK_WEBHOOK_URL` 設定済（任意）
- 時刻: NY 9:30〜16:00 EDT (JST 22:30〜翌 5:00)

**手順:**

1. `npx tsx src/paper-trading/daily-runner.ts --dry-run` で全ステップ通る
2. `npx tsx src/paper-trading/daily-runner.ts` で 1 entry 発注
3. TWS の "Activity" で fill 確認、`select * from "auto_us_stock_trader"."Position"` で OPEN 確認
4. 翌日（or 数分後 mock 日付で再実行）、HOLD 判定されることを確認
5. Position を手動で profit_target 状態に置く（DB の現在値を mock）→ close 発注確認
6. Slack に 5〜6 通の通知が来たことを確認

**完了基準:**

- 1 entry + 1 close が paper account で完結
- DB 5 テーブル全てに整合性のある記録
- 想定外例外なし

---

## Final: PR 作成

### Task 13: typecheck + 全テスト pass + commit + PR

```bash
npm run typecheck
npm test
git status
git log --oneline main..HEAD

# develop ブランチが無いので main 向け PR
gh pr create --title "Paper Trading Phase C/D/E: 発注 + 状態管理 + 通知 + エラー処理" --body "$(cat <<'EOF'
Fixes KOH-454

## Summary

- Phase C 残: closeSpreadOrder + expirePosition + duplicate-close 防止
- Phase D: Slack 通知（8 種フォーマッタ）+ 週次 Markdown レポート
- Phase E: withRetry ヘルパー + grand catch + ErrorLog + integration test

## Test plan

- [x] npm test (kill-switch, order-manager, slack-notifier, with-retry, daily-runner.integration)
- [x] npm run typecheck
- [ ] NY 取引時間中の smoke test (1 entry + 1 close)
EOF
)"
```

---

## YAGNI 不採用

- Slack ブロック / リッチフォーマット（text + attachment color のみ）
- 週次レポートの HTML / PDF 化
- 発注エラー時の自動 retry（Phase E は IBKR connect / read 系のみ retry、order placement は 1 回のみ）
- Iron Condor / 他戦略の paper trading（KOH-454 では SPY Credit Spread のみ）
- 監視ダッシュボード Web UI

## 完了基準（KOH-454 全体）

- [ ] Task 1〜11 全て pass
- [ ] Task 12 smoke test 完了（NY 時間中、手動）
- [ ] PR merged
- [ ] KOH-454 → Done
