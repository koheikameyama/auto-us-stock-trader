# Paper Trading Phase B: IBKR TWS API 接続（リードオンリー）実装プラン

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `@stoqey/ib` で IBKR TWS Paper Trading に接続し、アカウント情報・ポジション・SPY/VIX 価格・オプションチェーンの取得（リードオンリー）まで動作させる。発注は Phase C で実装。

**Architecture:** `src/paper-trading/ibkr-client.ts` に `IBKRClient` クラスを実装。`@stoqey/ib` の `IBApiNext` を使い、Observable/Promise ベースで API を Promise 化。`test-connection.ts` でローカル TWS への smoke test を行う。発注やトランザクション系 API は触らず、`reqAccountSummary` / `reqPositions` / `reqMktData` / `reqSecDefOptParams` のみ使用。

**Tech Stack:** TypeScript 6, tsx, `@stoqey/ib` v1.5+

**前提:**
- KOH-452-A 完了（信号ロジック純関数化）
- TWS Paper Trading にログイン済、port 7497 で API socket 開放確認済（`nc -zv 127.0.0.1 7497` succeeded）
- API 設定: "Enable ActiveX and Socket Clients" 有効
- 設計書: `docs/plans/2026-04-30-paper-trading-design.md` (Phase B セクション)

---

## ロールバック方法

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
git status

# 全変更を破棄
git restore --staged .
git checkout -- package.json package-lock.json
rm -rf src/paper-trading/

# 既コミット済みの場合
git log --oneline | head -10
git revert <SHA range>
```

`@stoqey/ib` をアンインストールしたい場合: `npm uninstall @stoqey/ib`。

---

## Task 1: `@stoqey/ib` インストール + ディレクトリ作成

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/paper-trading/` ディレクトリ

### Step 1: パッケージインストール

Run:
```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
npm install @stoqey/ib 2>&1 | tail -5
```

Expected: `added N packages` のような出力、エラーなし

### Step 2: 確認

Run:
```bash
grep "@stoqey/ib" package.json
```
Expected: `"@stoqey/ib": "^1.5.x"`（dependencies に追加されている）

### Step 3: ディレクトリ作成

Run:
```bash
mkdir -p src/paper-trading/__tests__
```

### Step 4: typecheck

Run: `npm run typecheck 2>&1 | tail -3`
Expected: エラーなし

### Step 5: コミット

```bash
git add package.json package-lock.json
git commit -m "chore(paper-trading): @stoqey/ib をインストール

IBKR TWS API への Node.js クライアント。Phase B で
src/paper-trading/ibkr-client.ts に IBKRClient クラスを
実装するための準備。

Refs: KOH-452-B (予定)"
```

---

## Task 2: IBKRClient スケルトン（connect / disconnect）

**Files:**
- Create: `src/paper-trading/ibkr-client.ts`

### Step 1: 最小実装

```typescript
// src/paper-trading/ibkr-client.ts
import { IBApiNext, ConnectionState } from "@stoqey/ib";

export interface IBKRClientConfig {
  host?: string;          // default: "127.0.0.1"
  port?: number;          // default: 7497 (TWS Paper)
  clientId?: number;      // default: 100
  connectTimeoutMs?: number; // default: 10_000
}

export class IBKRClient {
  private api: IBApiNext;
  private config: Required<IBKRClientConfig>;
  private connected = false;

  constructor(config: IBKRClientConfig = {}) {
    this.config = {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 7497,
      clientId: config.clientId ?? 100,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    };
    this.api = new IBApiNext({ host: this.config.host, port: this.config.port });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.config.connectTimeoutMs}ms`));
      }, this.config.connectTimeoutMs);

      const sub = this.api.connectionState.subscribe((state) => {
        if (state === ConnectionState.Connected) {
          clearTimeout(timeout);
          this.connected = true;
          sub.unsubscribe();
          resolve();
        } else if (state === ConnectionState.Disconnected && this.connected) {
          this.connected = false;
        }
      });

      this.api.connect(this.config.clientId);
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.api.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
```

### Step 2: typecheck

Run: `npm run typecheck 2>&1 | tail -10`
Expected: エラーなし

`@stoqey/ib` の型に問題があれば、まず import をシンプルに調整（version v1.5.3 の export を確認）。

### Step 3: 動作確認 — ad-hoc 接続テスト

`/tmp/test-ibkr-connect.ts` を作成:

```typescript
import { IBKRClient } from "/Users/kouheikameyama/development/auto-us-stock-trader/src/paper-trading/ibkr-client";

async function main() {
  const client = new IBKRClient({ clientId: 100 });
  console.log("Connecting to TWS at 127.0.0.1:7497 (Paper)...");
  await client.connect();
  console.log("✅ Connected:", client.isConnected());
  await client.disconnect();
  console.log("✅ Disconnected");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
```

Run:
```bash
npx tsx /tmp/test-ibkr-connect.ts
```

Expected:
```
Connecting to TWS at 127.0.0.1:7497 (Paper)...
✅ Connected: true
✅ Disconnected
```

エラーが出る場合:
- "Connection timeout" → TWS の API 設定が無効、または別の clientId で既に接続済み
- 型エラー → `@stoqey/ib` の API が想定と異なる、エラーメッセージで実 API を確認
- "ECONNREFUSED" → port 7497 が開いていない（`nc -zv 127.0.0.1 7497` で再確認）

### Step 4: 一時ファイル削除

```bash
rm /tmp/test-ibkr-connect.ts
```

### Step 5: コミット

```bash
git add src/paper-trading/ibkr-client.ts
git commit -m "feat(paper-trading): IBKRClient のスケルトン (connect/disconnect)

@stoqey/ib の IBApiNext を使い localhost:7497 (TWS Paper) に
接続できるクライアントクラスを実装。

- connectionState Observable を購読し ConnectionState.Connected で resolve
- 接続タイムアウト 10 秒（設定可能）
- disconnect() で切断

各種データ取得関数は次タスク以降で追加。

Refs: KOH-452-B (予定)"
```

---

## Task 3: getAccountSummary + getPositions

**Files:**
- Modify: `src/paper-trading/ibkr-client.ts`

### Step 1: 型定義 + メソッド実装

`IBKRClient` クラスに以下を追加:

```typescript
// 型定義（クラスの外、またはファイル末尾）
export interface AccountSummary {
  netLiquidation: number;
  totalCashValue: number;
  buyingPower: number;
  availableFunds: number;
}

export interface IBKRPosition {
  symbol: string;
  secType: string;            // "STK" | "OPT" | "FUT" | etc.
  right?: "P" | "C";          // option only
  strike?: number;
  expiry?: string;            // YYYYMMDD format
  quantity: number;
  avgCost: number;
  marketValue: number;
  unrealizedPnl: number;
}
```

メソッドを `IBKRClient` クラス内に追加（`disconnect` の後）:

```typescript
  async getAccountSummary(): Promise<AccountSummary> {
    if (!this.connected) throw new Error("Not connected");
    const tags = "NetLiquidation,TotalCashValue,BuyingPower,AvailableFunds";
    return new Promise<AccountSummary>((resolve, reject) => {
      const result: Partial<AccountSummary> = {};
      const sub = this.api.getAccountSummary("All", tags).subscribe({
        next: (update) => {
          for (const [, accountMap] of update.all) {
            for (const [tag, valueMap] of accountMap) {
              const v = [...valueMap.values()][0];
              if (!v) continue;
              const num = Number(v.value);
              if (tag === "NetLiquidation") result.netLiquidation = num;
              else if (tag === "TotalCashValue") result.totalCashValue = num;
              else if (tag === "BuyingPower") result.buyingPower = num;
              else if (tag === "AvailableFunds") result.availableFunds = num;
            }
          }
          // 全タグ揃ったら resolve
          if (
            result.netLiquidation != null &&
            result.totalCashValue != null &&
            result.buyingPower != null &&
            result.availableFunds != null
          ) {
            sub.unsubscribe();
            resolve(result as AccountSummary);
          }
        },
        error: (e) => {
          sub.unsubscribe();
          reject(e);
        },
      });
      // タイムアウト
      setTimeout(() => {
        sub.unsubscribe();
        reject(new Error("getAccountSummary timeout (10s)"));
      }, 10_000);
    });
  }

  async getPositions(): Promise<IBKRPosition[]> {
    if (!this.connected) throw new Error("Not connected");
    return new Promise<IBKRPosition[]>((resolve, reject) => {
      const positions: IBKRPosition[] = [];
      const sub = this.api.getPositions().subscribe({
        next: (update) => {
          for (const [, accountPositions] of update.all) {
            positions.length = 0;
            for (const p of accountPositions.values()) {
              const c = p.contract;
              positions.push({
                symbol: c.symbol ?? "",
                secType: c.secType ?? "",
                right: c.right === "P" || c.right === "C" ? c.right : undefined,
                strike: c.strike,
                expiry: c.lastTradeDateOrContractMonth,
                quantity: p.pos,
                avgCost: p.avgCost,
                marketValue: 0, // 後で reqMktData で補完可能、Phase B では 0 で良い
                unrealizedPnl: 0,
              });
            }
          }
        },
        error: (e) => {
          sub.unsubscribe();
          reject(e);
        },
      });
      // 最初の snapshot を待つ（IBKR は positions を全件返してから完了する）
      // Promise を 5 秒で解決、その時点で集まった positions を返す
      setTimeout(() => {
        sub.unsubscribe();
        resolve(positions);
      }, 5_000);
    });
  }
```

**注意**:
- `@stoqey/ib` の `getAccountSummary` / `getPositions` の戻り型は実装によって異なる可能性。コード上の型不一致は `as` で迂回 or 公式 example に合わせて修正。
- 上記コードはテンプレート。実装中に型エラーが出れば、`@stoqey/ib` の TypeScript 型定義（`node_modules/@stoqey/ib/dist/...`）を参照して調整。

### Step 2: typecheck

Run: `npm run typecheck 2>&1 | tail -10`
Expected: エラーなし。型エラーが出る場合は実 API に合わせて補正。

### Step 3: ad-hoc 動作確認

`/tmp/test-ibkr-account.ts`:

```typescript
import { IBKRClient } from "/Users/kouheikameyama/development/auto-us-stock-trader/src/paper-trading/ibkr-client";

async function main() {
  const client = new IBKRClient();
  await client.connect();

  const summary = await client.getAccountSummary();
  console.log("Account Summary:");
  console.log(`  Net Liquidation: $${summary.netLiquidation.toLocaleString()}`);
  console.log(`  Cash:            $${summary.totalCashValue.toLocaleString()}`);
  console.log(`  Buying Power:    $${summary.buyingPower.toLocaleString()}`);
  console.log(`  Available Funds: $${summary.availableFunds.toLocaleString()}`);

  const positions = await client.getPositions();
  console.log(`\nPositions: ${positions.length}`);
  for (const p of positions.slice(0, 5)) {
    console.log(`  ${p.symbol} ${p.secType} ${p.right ?? ""} ${p.strike ?? ""} qty=${p.quantity}`);
  }

  await client.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
```

Run: `npx tsx /tmp/test-ibkr-account.ts`

Expected:
- Paper account の現在の equity（IBKR Paper のデフォルトは $1,000,000 等）
- Positions: 0〜数件（Paper account に何も入れていなければ 0）

### Step 4: 一時ファイル削除 + コミット

```bash
rm /tmp/test-ibkr-account.ts
git add src/paper-trading/ibkr-client.ts
git commit -m "feat(paper-trading): getAccountSummary / getPositions 実装

IBKR Paper account の equity, cash, buying power, available funds と
保有ポジション一覧を取得するメソッドを追加。

- getAccountSummary: NetLiquidation 等の 4 タグを Observable で集約
- getPositions: 全 position を 5 秒以内に集めて返却

戻り値型は paper-trading 固有の AccountSummary / IBKRPosition で
カプセル化（@stoqey/ib の internal 型に依存しない）。

Refs: KOH-452-B (予定)"
```

---

## Task 4: getMarketPrice + getVIX

**Files:**
- Modify: `src/paper-trading/ibkr-client.ts`

### Step 1: 型定義 + メソッド

```typescript
export interface MarketPrice {
  bid: number | null;
  ask: number | null;
  last: number | null;
}
```

`IBKRClient` クラスに追加:

```typescript
  /** 株式 / ETF のリアルタイム bid/ask/last 取得 */
  async getMarketPrice(symbol: string): Promise<MarketPrice> {
    if (!this.connected) throw new Error("Not connected");
    const contract = {
      symbol,
      secType: "STK" as const,
      exchange: "SMART",
      currency: "USD",
    };
    return this.fetchMarketData(contract);
  }

  /** VIX (CBOE INDEX) の current value 取得 */
  async getVIX(): Promise<number> {
    if (!this.connected) throw new Error("Not connected");
    const contract = {
      symbol: "VIX",
      secType: "IND" as const,
      exchange: "CBOE",
      currency: "USD",
    };
    const { last } = await this.fetchMarketData(contract);
    if (last == null) throw new Error("VIX last price unavailable");
    return last;
  }

  /** 内部ヘルパー: reqMktData で snapshot 取得 */
  private async fetchMarketData(contract: any): Promise<MarketPrice> {
    return new Promise<MarketPrice>((resolve, reject) => {
      const result: MarketPrice = { bid: null, ask: null, last: null };
      const sub = this.api.getMarketData(contract, "", false, false).subscribe({
        next: (update) => {
          // update.all は Map<TickType, MarketDataTick>
          for (const [tickType, tick] of update.all) {
            if (tickType === 1) result.bid = tick.value ?? null;     // BID
            else if (tickType === 2) result.ask = tick.value ?? null; // ASK
            else if (tickType === 4) result.last = tick.value ?? null; // LAST
          }
          if (result.bid != null && result.ask != null && result.last != null) {
            sub.unsubscribe();
            resolve(result);
          }
        },
        error: (e) => {
          sub.unsubscribe();
          reject(e);
        },
      });
      // 5 秒で打ち切って取得済みを返す（last のみでも返す）
      setTimeout(() => {
        sub.unsubscribe();
        resolve(result);
      }, 5_000);
    });
  }
```

**注意**:
- `getMarketData` の API シグネチャは `@stoqey/ib` のバージョン依存。エラーが出れば node_modules で確認。
- TickType: 1=BID, 2=ASK, 4=LAST（IBKR 公式）

### Step 2: typecheck + ad-hoc 動作確認

`/tmp/test-ibkr-prices.ts`:

```typescript
import { IBKRClient } from "/Users/kouheikameyama/development/auto-us-stock-trader/src/paper-trading/ibkr-client";

async function main() {
  const client = new IBKRClient();
  await client.connect();

  const spy = await client.getMarketPrice("SPY");
  console.log(`SPY: bid=${spy.bid}, ask=${spy.ask}, last=${spy.last}`);

  const vix = await client.getVIX();
  console.log(`VIX: ${vix}`);

  await client.disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error("❌", e); process.exit(1); });
```

Run: `npx tsx /tmp/test-ibkr-prices.ts`

Expected:
- 取引時間中: 実際の SPY bid/ask/last（例: bid=467.20, ask=467.25, last=467.23）
- 時間外: last のみ取得、bid/ask は null
- VIX: 12〜30 程度の範囲

時間外でデータが空の場合は `delayed=true` の market data を試す（`@stoqey/ib` のオプション）。

### Step 3: 一時ファイル削除 + コミット

```bash
rm /tmp/test-ibkr-prices.ts
git add src/paper-trading/ibkr-client.ts
git commit -m "feat(paper-trading): getMarketPrice / getVIX 実装

SPY (STK / SMART) と VIX (IND / CBOE) のリアルタイム
bid/ask/last を取得する。fetchMarketData ヘルパーで
共通化、5 秒タイムアウトで打ち切り。

Refs: KOH-452-B (予定)"
```

---

## Task 5: getOptionChain（一部実装）

**Files:**
- Modify: `src/paper-trading/ibkr-client.ts`

オプションチェーンの完全取得は IBKR では複数 API ステップ必要（expiry 一覧 → strike 一覧 → 各 strike の market data）。Phase B では smoke test として **指定 expiry の SPY put 一覧（strike + bid/ask + greeks）** を limited に取得する。

### Step 1: 型定義 + メソッド

```typescript
export interface OptionContract {
  strike: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma: number | null;
  impliedVol: number | null;
}
```

`IBKRClient` に追加:

```typescript
  /**
   * SPY オプションの指定 expiry / right の選択 strike を取得。
   * Phase B では smoke test として ATM ±20 strike を返す。
   *
   * @param underlying 例: "SPY"
   * @param expiry YYYYMMDD 形式（例: "20260619"）
   * @param right "P" or "C"
   * @param atmStrike ATM strike（リクエストする中心、これの ±20 を取得）
   */
  async getOptionChain(
    underlying: string,
    expiry: string,
    right: "P" | "C",
    atmStrike: number,
  ): Promise<OptionContract[]> {
    if (!this.connected) throw new Error("Not connected");

    // Phase B: ATM ±20 strikes（41 件）に限定
    const strikes: number[] = [];
    for (let s = atmStrike - 20; s <= atmStrike + 20; s++) {
      strikes.push(s);
    }

    const results: OptionContract[] = [];
    for (const strike of strikes) {
      try {
        const data = await this.fetchOptionTick(underlying, expiry, right, strike);
        results.push(data);
      } catch {
        // skip individual failures
      }
    }
    return results;
  }

  private async fetchOptionTick(
    underlying: string,
    expiry: string,
    right: "P" | "C",
    strike: number,
  ): Promise<OptionContract> {
    const contract = {
      symbol: underlying,
      secType: "OPT" as const,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: expiry,
      strike,
      right,
      multiplier: "100",
    };

    return new Promise<OptionContract>((resolve) => {
      const result: OptionContract = {
        strike,
        bid: null,
        ask: null,
        delta: null,
        gamma: null,
        impliedVol: null,
      };
      // genericTickList "13" = Model Option Computation (Greeks)
      const sub = this.api.getMarketData(contract, "13", false, false).subscribe({
        next: (update) => {
          for (const [tickType, tick] of update.all) {
            if (tickType === 1) result.bid = tick.value ?? null;
            else if (tickType === 2) result.ask = tick.value ?? null;
            else if (tickType === 13) {
              // ModelOptionComputation: tick.delta, tick.gamma, tick.impliedVol
              const t = tick as any;
              result.delta = t.delta ?? null;
              result.gamma = t.gamma ?? null;
              result.impliedVol = t.impliedVol ?? null;
            }
          }
        },
        error: () => {
          sub.unsubscribe();
          resolve(result); // partial OK
        },
      });
      setTimeout(() => {
        sub.unsubscribe();
        resolve(result);
      }, 3_000); // strike ごとに 3 秒
    });
  }
```

**注意**:
- 41 strike × 3 秒 = 最大 123 秒。IBKR のレート制限（~50 req/sec）には余裕あるはず。
- TickType 13 (ModelOptionComputation) で greeks を取得。実装によって型が異なるので `as any` で迂回。

### Step 2: typecheck

Run: `npm run typecheck 2>&1 | tail -5`
Expected: エラーなし

### Step 3: 動作確認は test-connection.ts に統合（次タスク）

ここでは ad-hoc test しない（時間がかかる、test-connection でまとめて確認）。

### Step 4: コミット

```bash
git add src/paper-trading/ibkr-client.ts
git commit -m "feat(paper-trading): getOptionChain 実装（ATM ±20 strikes）

SPY オプションの指定 expiry / right に対し ATM ±20 の
strike を逐次取得（最大 41 件）。各 strike について
bid/ask/delta/gamma/impliedVol を返す。

Phase B では smoke test として小規模 chain のみ。
Phase C で発注対象 strike を delta=0.20 から決定する際に
こちらを使う。

Refs: KOH-452-B (予定)"
```

---

## Task 6: test-connection.ts（統合 smoke test）

**Files:**
- Create: `src/paper-trading/test-connection.ts`

### Step 1: 実装

```typescript
// src/paper-trading/test-connection.ts
/**
 * IBKR TWS Paper Trading への接続 smoke test
 *
 * Usage:
 *   npx tsx src/paper-trading/test-connection.ts
 */

import { IBKRClient } from "./ibkr-client";

async function main() {
  console.log("=".repeat(60));
  console.log("IBKR TWS Paper Trading Connection Smoke Test");
  console.log("=".repeat(60));

  const client = new IBKRClient({ clientId: 100 });

  console.log("\n[1] Connecting to TWS at 127.0.0.1:7497...");
  await client.connect();
  console.log("    ✅ Connected");

  console.log("\n[2] Fetching account summary...");
  const summary = await client.getAccountSummary();
  console.log(`    Net Liquidation: $${summary.netLiquidation.toLocaleString()}`);
  console.log(`    Cash:            $${summary.totalCashValue.toLocaleString()}`);
  console.log(`    Buying Power:    $${summary.buyingPower.toLocaleString()}`);
  console.log(`    Available Funds: $${summary.availableFunds.toLocaleString()}`);

  console.log("\n[3] Fetching positions...");
  const positions = await client.getPositions();
  console.log(`    Positions: ${positions.length}`);
  for (const p of positions.slice(0, 10)) {
    console.log(
      `      ${p.symbol} ${p.secType} ${p.right ?? "-"} ${
        p.strike ?? "-"
      } qty=${p.quantity}`,
    );
  }

  console.log("\n[4] Fetching SPY market price...");
  const spy = await client.getMarketPrice("SPY");
  console.log(`    SPY: bid=${spy.bid}, ask=${spy.ask}, last=${spy.last}`);

  console.log("\n[5] Fetching VIX...");
  const vix = await client.getVIX();
  console.log(`    VIX: ${vix.toFixed(2)}`);

  console.log("\n[6] Fetching SPY put option chain (ATM ±20 strikes)...");
  if (spy.last == null) {
    console.log("    SKIP: SPY last price unavailable, cannot determine ATM");
  } else {
    // 適切な expiry を計算（35 日後の最初の金曜）
    const today = new Date();
    today.setDate(today.getDate() + 35);
    const dow = today.getDay(); // 0 = Sun, 5 = Fri
    const offset = (5 - dow + 7) % 7;
    today.setDate(today.getDate() + offset);
    const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
    console.log(`    Target expiry: ${yyyymmdd}`);

    const atmStrike = Math.round(spy.last);
    console.log(`    ATM strike: ${atmStrike}`);

    const chain = await client.getOptionChain("SPY", yyyymmdd, "P", atmStrike);
    console.log(`    Got ${chain.length} contracts. Top 5 by strike (descending):`);
    for (const opt of chain.sort((a, b) => b.strike - a.strike).slice(0, 5)) {
      console.log(
        `      strike=${opt.strike} bid=${opt.bid} ask=${opt.ask} delta=${
          opt.delta?.toFixed(3) ?? "-"
        } iv=${opt.impliedVol?.toFixed(3) ?? "-"}`,
      );
    }
  }

  console.log("\n[7] Disconnecting...");
  await client.disconnect();
  console.log("    ✅ Disconnected");

  console.log("\n" + "=".repeat(60));
  console.log("✅ Smoke test passed");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ Smoke test failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
```

### Step 2: typecheck

Run: `npm run typecheck 2>&1 | tail -5`
Expected: エラーなし

### Step 3: コミット（実行は次タスク）

```bash
git add src/paper-trading/test-connection.ts
git commit -m "feat(paper-trading): test-connection.ts スモークテスト追加

IBKR TWS Paper Trading 接続から account/positions/SPY/VIX/
option chain (ATM±20) までを順次取得する統合 smoke test。

Phase B の動作確認用。Phase C 以降は daily-runner.ts
が cron で動くようになる。

Refs: KOH-452-B (予定)"
```

---

## Task 7: smoke test 実行

**Files:** なし（実行のみ）

### Step 1: TWS が起動済かつログイン済か再確認

Run:
```bash
nc -zv 127.0.0.1 7497 2>&1 | head -2
```
Expected: `succeeded!`

NG なら TWS を起動して Paper Trading でログインする。

### Step 2: smoke test 実行

Run:
```bash
npx tsx src/paper-trading/test-connection.ts
```

Expected: 全ステップ ✅、エラーなし完走。

サンプル出力:
```
============================================================
IBKR TWS Paper Trading Connection Smoke Test
============================================================

[1] Connecting to TWS at 127.0.0.1:7497...
    ✅ Connected

[2] Fetching account summary...
    Net Liquidation: $1,000,000
    Cash:            $1,000,000
    Buying Power:    $4,000,000
    Available Funds: $1,000,000

[3] Fetching positions...
    Positions: 0

[4] Fetching SPY market price...
    SPY: bid=467.20, ask=467.25, last=467.23

[5] Fetching VIX...
    VIX: 13.42

[6] Fetching SPY put option chain (ATM ±20 strikes)...
    Target expiry: 20260619
    ATM strike: 467
    Got 41 contracts. Top 5 by strike (descending):
      strike=487 bid=20.5 ask=20.8 delta=-0.892 iv=0.124
      strike=486 bid=19.5 ask=19.8 delta=-0.872 iv=0.123
      ...

[7] Disconnecting...
    ✅ Disconnected

============================================================
✅ Smoke test passed
============================================================
```

### Step 3: 失敗時の切り分け

| 観察 | 想定原因 | 対処 |
|---|---|---|
| `Connection timeout` | API 設定無効、または同 clientId が既存 | TWS の API → Settings 確認、clientId 変更 |
| `Cannot find module '@stoqey/ib'` | install 漏れ | Task 1 を再確認 |
| `BuyingPower undefined` | account タグ不一致 | tags 文字列を IBKR ドキュメントで確認 |
| 価格が `null` | 時間外 + リアルタイム未契約 | 取引時間中に再実行、または delayed=true 試す |
| Greeks が全て null | TickType 13 対応バージョン違い | `tickByTickReturnComputation` 等の代替確認 |

### Step 4: 検証コミット

```bash
git commit --allow-empty -m "verify(paper-trading): IBKR Paper Trading 接続 smoke test 成功

\`npx tsx src/paper-trading/test-connection.ts\` 完走を確認:
- TWS Paper (127.0.0.1:7497) 接続
- AccountSummary 取得（Net Liquidation \$X, Cash \$Y）
- Positions 取得（N 件）
- SPY 価格取得 (bid/ask/last)
- VIX 取得（XX.XX）
- SPY put option chain (ATM ±20 strikes) 取得

Phase B 完了。Phase C で発注実装に進む。

Refs: KOH-452-B"
```

---

## Task 8: Linear KOH-452-B 作成

**Files:** なし（Linear 操作のみ）

### Step 1: タスク作成

`mcp__linear-server__save_issue` で:
- **Title:** `Paper Trading Phase B: IBKR TWS API 接続（リードオンリー）`
- **Project:** Auto US Stock Trader
- **State:** Done
- **Description**:

```markdown
## 概要

KOH-452-A 完了を受けて、Paper Trading Phase B として IBKR TWS API への接続とリードオンリーのデータ取得を実装。

## 実装内容

- `@stoqey/ib` v1.5.x を導入
- `src/paper-trading/ibkr-client.ts`:
  - `IBKRClient` クラス
  - `connect / disconnect`
  - `getAccountSummary` / `getPositions`
  - `getMarketPrice` / `getVIX`
  - `getOptionChain`（ATM ±20 strikes、greeks 込み）
- `src/paper-trading/test-connection.ts`: 統合 smoke test

## 動作確認

`npx tsx src/paper-trading/test-connection.ts` 完走:
- TWS Paper (127.0.0.1:7497) 接続成功
- AccountSummary, Positions, SPY/VIX, SPY put option chain 全取得

## 次フェーズ

KOH-452-C: 発注 + 状態管理（Combo Order、DB 同期、kill switch）

## 参考

- 設計: `docs/plans/2026-04-30-paper-trading-design.md`
- 実装プラン: `docs/plans/2026-04-30-paper-trading-phase-b-implementation-plan.md`
- KOH-452-A
```

---

## 全 Task 完了基準

- ✅ `@stoqey/ib` が `package.json` に追加されている
- ✅ `src/paper-trading/ibkr-client.ts` 実装、各メソッドが動く
- ✅ `src/paper-trading/test-connection.ts` 実装
- ✅ `npx tsx src/paper-trading/test-connection.ts` がエラーなく完走
- ✅ `npm run typecheck` エラーなし
- ✅ 既存テスト 33/33 PASS（リグレッションなし）
- ✅ Linear KOH-452-B が Done

## DRY / YAGNI 原則の確認

- リードオンリーのみ実装、発注は Phase C
- 戻り値型は paper-trading 固有（@stoqey/ib の internal 型に依存しない）
- Greeks 取得は ATM 周辺のみ（全 strike は不要、実取引判断には ATM ±20 で十分）
- ユニットテスト不要（モック実装は割に合わない、実 API smoke test で代替）
- 接続切れの auto-reconnect は実装しない（Phase E でエラーハンドリング統合）

## 次フェーズ

Phase C（発注 + 状態管理、Combo Order）の実装プラン作成 → 実装。

別タスクで:
- KOH-452-C: Phase C 実装
- KOH-452-D: Phase D ロギング + 通知 + 週次レポート
- KOH-452-E: Phase E エラー処理 + テスト
- KOH-452-F: Phase F 90 日観察
- KOH-452-G: Phase G 最終評価

## 参考

- 設計書: `docs/plans/2026-04-30-paper-trading-design.md` (Phase B セクション)
- KOH-452-A: `docs/plans/2026-04-30-paper-trading-phase-a-implementation-plan.md`
- @stoqey/ib: https://github.com/stoqey/ib
