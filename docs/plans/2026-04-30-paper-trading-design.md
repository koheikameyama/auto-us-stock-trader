# SPY Credit Spread Paper Trading 設計ドキュメント

作成日: 2026-04-30
ロードマップ位置: KOH-451 (戦略リファクタ完了) → KOH-452 (paper trading)

## 目的

KOH-451 の backtest 検証 (6/7 PASS、CAGR 8.83%) を受けて、IBKR Paper Trading で 90 日間の実環境検証を行い、本番取引判断の材料を得る。実約定価格・スリッページ・流動性・運用安定性を観察する。

## 方針サマリー

- **完全自動化**: cron で日次実行、信号生成 → IBKR 発注 → DB 記録 → Slack 通知まで完結
- **IBKR TWS API + Node.js (`@stoqey/ib`)**: 既存 TS コードと統合、Combo Order でスプレッド発注
- **観察期間 90 日**: 5 指標 4/5 PASS で総合 PASS 判定
- **既存 backtest コードの DRY 共有**: 信号ロジックを純関数化して両方から呼ぶ

---

## 全体アーキテクチャ

```
              ┌─────────────────────────┐
              │  IBKR TWS / IB Gateway  │  ← ローカル PC で常駐
              │  (paper trading login)  │
              └────────────┬────────────┘
                           │ TWS API (socket)
                           │
        ┌──────────────────┴──────────────────┐
        │   src/paper-trading/daily-runner    │ ← cron 起動 (JST 7:00)
        └──────────────────┬──────────────────┘
                           │
    ┌──────────────────────┼──────────────────────┐
    │                      │                      │
    ▼                      ▼                      ▼
┌──────────┐           ┌──────────┐           ┌──────────┐
│ Signal   │           │ IBKR     │           │ DB       │
│ Generator│           │ Client   │           │ (Prisma) │
│ (純関数) │           │          │           │          │
└──────────┘           └──────────┘           └──────────┘
```

## ディレクトリ構成

```
auto-us-stock-trader/
├── src/
│   ├── backtest/credit-spread/
│   │   ├── signal-generator.ts        新規（既存 simulation.ts から抽出）
│   │   ├── spread-evaluator.ts        新規
│   │   ├── dd-stop.ts                 新規（calcDDStopState）
│   │   ├── simulation.ts              既存をラッパー化
│   │   └── ...
│   ├── paper-trading/                 新規ディレクトリ
│   │   ├── daily-runner.ts            エントリーポイント
│   │   ├── ibkr-client.ts             TWS API ラッパー
│   │   ├── position-syncer.ts         IBKR ↔ DB 同期
│   │   ├── order-manager.ts           発注 + 約定確認
│   │   ├── kill-switch.ts             .paper-trading-stop 検知
│   │   ├── slack-notifier.ts          通知
│   │   ├── weekly-report.ts           週次 Markdown 生成
│   │   └── __tests__/
│   └── lib/prisma.ts (既存)
├── prisma/schema.prisma                新規テーブル 5 つ追加
├── docs/paper-trading/                 週次レポート出力先
└── .paper-trading-stop                 kill switch (gitignore)
```

## 段階リリース

| Phase | 内容 | 工数 |
|---|---|---|
| **A** | 信号ロジック抽出（リファクタ） | 1〜2 セッション |
| **B** | IBKR TWS API 統合（リード） | 1 セッション |
| **C** | 発注 + 状態管理（完結） | 1〜2 セッション |
| **D** | ロギング + 通知 + 週次レポート | 1 セッション |
| **E** | エラー処理 + kill switch + テスト | 1 セッション |
| **F** | 90 日 paper trading 観察 | 90 暦日 |
| **G** | 最終評価 + 本番判断 | 1 セッション |

合計: **実装 5〜7 セッション + 観察 90 日 + 評価 1 セッション**

---

## Phase A: 信号ロジック抽出（リファクタ）

### 目的

`us-credit-spread-simulation.ts` から純関数として抽出し、backtest と paper trading で共有可能にする。挙動は完全に同等を保つ。

### 抽出する 3 つの純関数

#### 1. `generateEntrySignal(ctx)` — 新規エントリー判定

```typescript
interface EntryContext {
  today: string;
  spotSpy: number;
  vix: number;
  smaSpy: number | null;
  cash: number;
  openPositionCount: number;
  ddStopActive: boolean;
  config: USCreditSpreadBacktestConfig;
}

interface EntrySignal {
  shortStrike: number;
  longStrike: number;
  expirationDate: string;
  estimatedCredit: number;
  shortDelta: number;
  reason: "ENTERED";
}

type EntryResult = EntrySignal | { reason: "SKIP_VIX_CAP" | "SKIP_TREND_FILTER" | "SKIP_DD_STOP" | "SKIP_MAX_POSITIONS" | "SKIP_INSUFFICIENT_CASH" | "SKIP_LOW_CREDIT" };
```

#### 2. `evaluateSpread(spread, ctx)` — 既存 spread のクローズ判定

```typescript
type SpreadAction =
  | { action: "HOLD"; currentValue: number }
  | { action: "CLOSE"; reason: "profit_target" | "stop_loss"; currentValue: number }
  | { action: "EXPIRE"; reason: "expired_worthless" | "expired_max_loss" | "expired_partial"; finalValue: number };
```

#### 3. `calcDDStopState(ctx)` — DD stop 状態遷移

```typescript
interface DDStopState {
  runningPeak: number;
  ddStopActive: boolean;
  ddStopActivatedDate: string | null;
  transition: "ACTIVATED" | "DEACTIVATED" | "UNCHANGED";
}
```

### 完了基準

- 純関数 3 つがファイル分離
- ユニットテスト 10〜15 件追加
- backtest 全期間（2007-01-03〜2026-04-28）が step3b と完全一致

---

## Phase B: IBKR TWS API 統合（リード）

### 目的

`@stoqey/ib` で IBKR TWS / IB Gateway に接続し、リードオンリーで動作確認。

### `ibkr-client.ts` API

```typescript
export class IBKRClient {
  async connect(host: string = "127.0.0.1", port: number = 7497, clientId: number = 100): Promise<void>;
  async disconnect(): Promise<void>;
  async getAccountSummary(account: string): Promise<{ netLiquidation: number; totalCashValue: number; buyingPower: number; availableFunds: number }>;
  async getPositions(): Promise<Array<{ symbol: string; secType: string; right: "P" | "C"; strike: number; expiry: string; quantity: number; avgCost: number; marketValue: number; unrealizedPnl: number }>>;
  async getOptionChain(underlying: string, expiry: string, right: "P" | "C"): Promise<Array<{ strike: number; bid: number; ask: number; delta: number; gamma: number; impliedVol: number }>>;
  async getMarketPrice(symbol: string): Promise<{ bid: number; ask: number; last: number }>;
  async getVIX(): Promise<number>;
}
```

### 完了基準

- `ibkr-client.ts` 実装、各 API 関数が動く
- `test-connection.ts` 実行で paper account 情報取得
- 切断/再接続のリトライが動く

### Port 一覧

- 7497: TWS Paper, 7496: TWS Live
- 4002: Gateway Paper, 4001: Gateway Live

---

## Phase C: 発注 + 状態管理（完結フロー）

### 日次サイクル（9 ステップ）

1. **kill switch チェック** — `.paper-trading-stop` 検知で即終了
2. **IBKR 接続 + アカウント情報取得** — cash, buying power, positions
3. **既存ポジション同期 (IBKR ↔ DB)** — 差分があれば Slack 通知
4. **既存スプレッド評価**（`evaluateSpread`） — HOLD / CLOSE / EXPIRE 判定、CLOSE 時は IBKR で reverse 発注
5. **equity 計算 + DD stop 状態遷移**（`calcDDStopState`）
6. **新規エントリー判定**（`generateEntrySignal`）
7. **発注**（新規 entry 時、Combo Order）
   - 二重発注チェック
   - オプションチェーン取得 → 実 strike 決定
   - Combo Order 構築 + limit price = mid
   - placeOrder → fill 確認（最大 5 分）
   - 成功時 Slack 通知
8. **DailyEquitySnapshot を DB に記録**
9. **SignalLog 記録 + IBKR 切断**

### Combo Order 仕様

```typescript
const combo: Contract = {
  symbol: "SPY",
  secType: "BAG",
  currency: "USD",
  exchange: "SMART",
  comboLegs: [
    { conId: shortPutConId, ratio: 1, action: "SELL", exchange: "SMART" },
    { conId: longPutConId,  ratio: 1, action: "BUY",  exchange: "SMART" },
  ],
};

const order: Order = {
  action: "BUY",     // NET_CREDIT order
  orderType: "LMT",
  totalQuantity: 1,
  lmtPrice: -0.85,   // 負の値 = credit 受領想定
  tif: "DAY",
};
```

### DB スキーマ追加（5 テーブル）

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
  limitPrice      Float
  status          String
  submittedAt     DateTime
  filledAt        DateTime?
  filledPrice     Float?
  commission      Float?
  createdAt       DateTime @default(now())
  position        Position? @relation(fields: [positionId], references: [id])
  positionId      String?
  @@unique([symbol, shortStrike, longStrike, expiry, submittedAt])
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
  state           String
  closeDate       DateTime?
  closeReason     String?
  closeSpreadPrice Float?
  netPnl          Float?
  totalCommission Float?
  orders          TradingOrder[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@schema("auto_us_stock_trader")
}

model DailyEquitySnapshot {
  id              String   @id @default(cuid())
  date            DateTime @db.Date  @unique
  cash            Float
  positionsValue  Float
  totalEquity     Float
  openPositionCount Int
  ddStopActive    Boolean
  runningPeak     Float
  createdAt       DateTime @default(now())
  @@schema("auto_us_stock_trader")
}

model SignalLog {
  id              String   @id @default(cuid())
  date            DateTime @db.Date
  signalType      String
  reason          String
  details         Json?
  createdAt       DateTime @default(now())
  @@index([date])
  @@schema("auto_us_stock_trader")
}

model ErrorLog {
  id              String   @id @default(cuid())
  occurredAt      DateTime @default(now())
  category        String
  message         String
  context         Json?
  resolved        Boolean  @default(false)
  @@index([occurredAt])
  @@schema("auto_us_stock_trader")
}
```

### 完了基準

- `daily-runner.ts` が手動実行で paper trading で 1 spread 完結発注
- DB に正しく記録、翌日実行で既存 position 認識
- 利確/SL クローズも実発注 → DB 更新

---

## Phase D: ロギング + 通知 + 週次レポート

### Slack 通知粒度

skip も含め**毎日必ず 1 通以上**通知:

| イベント | 通知内容 |
|---|---|
| 成功エントリー | strike, credit, fill price |
| 成功クローズ | reason, PnL, 保有日数 |
| **エントリー skip（フィルタ）** | reason + VIX/SPY/SMA |
| 満期 expire | result, PnL |
| DD stop 発動/解除 | 警告/情報色 |
| 発注エラー | 詳細 |
| 接続エラー（リトライ後 NG）| 詳細 |
| **二重発注検知** | 緊急色（mention）|
| kill switch 発動 | 「実行スキップ」 |
| **想定外例外** | stack trace、緊急色 |
| 日次サマリー | 常に通知（オープン数、equity、PnL） |

### 週次 Markdown レポート

- 出力先: `docs/paper-trading/weekly-YYYY-Www.md`
- 生成タイミング: 毎週土曜 JST 朝（cron）
- 内容: 累積取引数、累積 PnL、Win Rate、オープンポジション、backtest 整合性チェック

### 完了基準

- 12 種通知すべてが Slack に飛ぶ
- 週次レポートが手動 + cron で生成可
- backtest との整合性チェックが動く

---

## Phase E: エラー処理 + kill switch + テスト

### kill switch（ファイルベース）

```typescript
const KILL_SWITCH_FILE = path.resolve(".paper-trading-stop");
export function isKillSwitchActive(): boolean { return fs.existsSync(KILL_SWITCH_FILE); }
```

### リトライ設定

| 操作 | retries | interval | 失敗時 |
|---|---|---|---|
| IBKR connect | 3 | 10 sec | エラー記録 + 当日処理スキップ |
| IBKR API call | 3 | 5 sec | 同上 |
| Order placement | 1 | - | Slack、entry スキップ |
| Order fill 確認 | poll 30 sec × 10 回 | - | timeout で order 取消 |
| DB write | 3 | 2 sec | Slack、当日処理続行 |

### 二重発注検知（2 重防御）

- Prisma 制約: `@@unique([symbol, shortStrike, longStrike, expiry, submittedAt])`
- コードチェック: 発注前に DB を検索
- 検知時: 緊急 Slack + 自動 kill switch ON

### 想定外例外の grand catch

`daily-runner.ts` 最上位で try/catch、ErrorLog 記録 + 緊急 Slack。

### テスト

| 対象 | 数 |
|---|---|
| Phase A 純関数（signal/spread/dd-stop） | 10〜15 件 |
| kill-switch | 3〜5 件 |
| withRetry | 3 件 |
| slack-notifier | 2 件 |
| ibkr-client（モック） | 5〜8 件 |
| daily-runner integration | 1 件 |

合計: 既存 25-30 + 新規 25-35 = **50-65 件**。

---

## Phase F: 90 日観察期間

### 運用フロー

```
Day 1: 観察開始（cron 化、Linear KOH-452 In Progress、初期 equity $100,000）
Day 7, 14, ...: 週次レポート生成 + Slack 要約
Day 30: 中間レビュー（5/4 PASS のうち何が PASS/FAIL か）
Day 90: 観察終了 → 最終評価
```

### 早期中止条件

- 致命的事故 1 件（想定外例外、二重発注）
- 2 週連続で大幅乖離（実 PnL が backtest 予測の ±60% 超）
- DD stop 複数回発動（観察期間中 2 回以上）
- kill switch 手動発動

---

## Phase G: 最終評価 — PASS/FAIL 判定

### 5 指標、4/5 PASS で総合 PASS

| # | 指標 | 閾値 |
|---|---|---|
| 1 | Net P&L 整合 | 実 P&L が backtest 予測の ±30%（small なら ±50%）以内 |
| 2 | Win Rate | 75% 以上 |
| 3 | 平均スリッページ | 受領クレジットが backtest 推定の 80% 以上 |
| 4 | 約定エラー率 | 5% 以下 |
| 5 | 致命的事故ゼロ | 想定外例外 0、kill switch 発動 0 |

**4/5 PASS** → 本番判断 GO/NO-GO は KOH-453 (推定) で別途検討。

---

## Linear タスク化案

7 サブタスク or 1 大タスク（KOH-452）どちらでも可。

| Linear | スコープ | 依存 |
|---|---|---|
| KOH-452-A | Phase A 信号ロジック抽出 | KOH-451 |
| KOH-452-B | Phase B IBKR API 接続 | KOH-452-A |
| KOH-452-C | Phase C 発注 + 状態管理 | KOH-452-B |
| KOH-452-D | Phase D ロギング + 通知 + レポート | KOH-452-C |
| KOH-452-E | Phase E エラー処理 + テスト | KOH-452-D |
| KOH-452-F | 90 日 paper trading 観察 | KOH-452-E |
| KOH-452-G | 最終評価 + 本番判断 | KOH-452-F |

---

## YAGNI 原則による不採用一覧

- 動的パラメータ調整（VIX レジーム別の strike 選定等）
- 複数戦略の並行運用
- ML ベースの信号補正
- 監視ダッシュボード Web UI
- 自動 cron 化（最初は手動実行で動作確認）
- 24h 無人運用（最初は GUI ログイン必要）
- HTML / PDF レポート

## 次フェーズへの引き継ぎ

### 観察期間後（PASS の場合）
- KOH-453 (推定): 本番取引リリース
  - paper → live への切替（port 7497 → 7496）
  - リスク管理、緊急停止プロトコル
  - 段階的サイズアップ

### 観察期間後（FAIL の場合）
- 改善案 → 再観察 or 戦略再設計

## 参考

- 設計: `docs/plans/2026-04-28-credit-spread-tail-test-design.md`
- 改善設計: `docs/plans/2026-04-30-credit-spread-tail-improvement-design.md`
- step3b レポート: `docs/reports/credit-spread-tail-2026-04-30-step3b.md`
- KOH-447, KOH-448, KOH-449, KOH-450, KOH-451
