# DB スキーマ設計

## 方針: PostgreSQL `auto_us_stock_trader` schema で完全分離

物理的に同じ Railway DB だが、PostgreSQL の schema 機能で logical 分離する。
JP（auto-stock-trader）と US（本リポ）でテーブルを名前空間レベルで完全独立させる。

```
Railway PostgreSQL
├── public.*                    ← JP (auto-stock-trader 所有、既存)
│     • StockDailyBar (JP銘柄のみ、market カラム廃止)
│     • EarningsDate
│     • Stock, TradingOrder, Position 等
│
└── auto_us_stock_trader.*      ← US (本リポ所有、新規)
      • StockDailyBar (S&P 500/600 OHLCV)
      • EarningsDate (US決算日)
      • IndexDailyBar (^GSPC, ^VIX)
      • Stock (銘柄マスタ)
      • (将来) TradingOrder, Position, OptionContract 等
```

### なぜ schema 分離か

| 比較項目 | schema 分離（採用） | 別DB | テーブル名 prefix |
|---|---|---|---|
| 名前衝突 | なし（`auto_us_stock_trader.StockDailyBar` と `public.StockDailyBar` 共存可）| なし | あり（`us_stock_daily_bar` 冗長） |
| Railway コスト | 1 service で済む | 2 service 必要 | 1 service |
| 権限分離 | 可能 | 完全分離 | 不可 |
| Prisma 設定 | `multiSchema` preview feature | URLが2つ | 通常通り |
| 所有権の明確さ | ✓ schema単位で明確 | ✓ DB単位 | ✗ 同じschemaに混在 |
| 移行コスト | 中（migrate + データ移行） | 高（DB切替+migrate） | 低（テーブル追加のみ） |

→ schema 分離が最適バランス。

### なぜ table 名に `US` prefix を付けないか

schema が `auto_us_stock_trader` で名前空間分離されているので JP 側と衝突しない。
JPと**同じ命名**にすることで認知負荷を下げる。

## テーブル設計

### 短期（データ層、現在着手）

#### `auto_us_stock_trader.StockDailyBar`

S&P 500/600 銘柄の日足 OHLCV。

| カラム | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | String | PK, cuid | |
| `tickerCode` | String | | 例: "AAPL", "MSFT" |
| `date` | Date | | 取引日 |
| `open` / `high` / `low` / `close` | Float | | OHLC |
| `volume` | BigInt | | 出来高 |
| `createdAt` | DateTime | default now | |

- ユニーク制約: `(tickerCode, date)`
- インデックス: `(tickerCode, date DESC)`, `(date)`

**JP との違い**: `market` カラムなし（schema自体がUS専用）。

#### `auto_us_stock_trader.EarningsDate`

| カラム | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | String | PK, cuid | |
| `tickerCode` | String | | |
| `date` | Date | | 決算発表日 |
| `createdAt` | DateTime | default now | |

- ユニーク制約: `(tickerCode, date)`
- インデックス: `(date)`

#### `auto_us_stock_trader.IndexDailyBar`

`^GSPC` (S&P 500) / `^VIX` 等の指数。

JP側では `StockDailyBar` に `market="INDEX"` で混在していたが、US schema では分離。

| カラム | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | String | PK, cuid | |
| `tickerCode` | String | | "^GSPC", "^VIX" |
| `date` | Date | | |
| `open` / `high` / `low` / `close` | Float | | |
| `volume` | BigInt | | 指数では基本0 |
| `createdAt` | DateTime | default now | |

- ユニーク制約: `(tickerCode, date)`
- インデックス: `(date)`

#### `auto_us_stock_trader.Stock`

S&P 500/600 銘柄マスタ（任意、いますぐは作らなくてもよい）。

| カラム | 型 | 制約 | 内容 |
|---|---|---|---|
| `id` | String | PK, cuid | |
| `tickerCode` | String | unique | |
| `name` | String | | 会社名 |
| `sector` | String? | | GICS sector |
| `industry` | String? | | GICS industry |
| `marketCap` | BigInt? | | 時価総額 |
| `indexNames` | String[] | | ["SP500", "SP600"] |
| `isActive` | Boolean | default true | |
| `createdAt` / `updatedAt` | DateTime | | |

### 中長期（取引層、本番開始時に追加）

| テーブル | 内容 |
|---|---|
| `auto_us_stock_trader.TradingOrder` | 注文履歴（買・売、現物・オプション）|
| `auto_us_stock_trader.Position` | 保有ポジション |
| `auto_us_stock_trader.OptionContract` | オプション契約（Credit Spread 用、strike/expiry/delta/IV等）|
| `auto_us_stock_trader.MarketAssessment` | 市場評価（VIXレジーム、SPYトレンド等）|

## Prisma 設定（本リポ）

`auto_us_stock_trader` リポに Prisma を導入。
JP 側の Prisma スキーマには触れない（責務分離）。

### `prisma/schema.prisma`（予定）

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["multiSchema"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["auto_us_stock_trader"]
}

model StockDailyBar {
  id         String   @id @default(cuid())
  tickerCode String
  date       DateTime @db.Date
  open       Float
  high       Float
  low        Float
  close      Float
  volume     BigInt
  createdAt  DateTime @default(now())

  @@unique([tickerCode, date])
  @@index([tickerCode, date(sort: Desc)])
  @@index([date])
  @@schema("auto_us_stock_trader")
}

model EarningsDate {
  id         String   @id @default(cuid())
  tickerCode String
  date       DateTime @db.Date
  createdAt  DateTime @default(now())

  @@unique([tickerCode, date])
  @@index([date])
  @@schema("auto_us_stock_trader")
}

model IndexDailyBar {
  id         String   @id @default(cuid())
  tickerCode String
  date       DateTime @db.Date
  open       Float
  high       Float
  low        Float
  close      Float
  volume     BigInt
  createdAt  DateTime @default(now())

  @@unique([tickerCode, date])
  @@index([date])
  @@schema("auto_us_stock_trader")
}

model Stock {
  id          String   @id @default(cuid())
  tickerCode  String   @unique
  name        String
  sector      String?
  industry    String?
  marketCap   BigInt?
  indexNames  String[]
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([tickerCode])
  @@schema("auto_us_stock_trader")
}
```

## 既存データの扱い

### Railway DB の現状（推定）

JP リポ時代に投入された米国データが `public.StockDailyBar (market="US")` 等に残っている可能性あり。

```sql
-- 確認クエリ
SELECT market, COUNT(*), MIN(date), MAX(date)
FROM public."StockDailyBar"
GROUP BY market;
```

### 移行戦略

| 選択肢 | メリット | デメリット | 推奨 |
|---|---|---|---|
| **A: SQL移行** | 速い（数秒）、yfinance呼び出し不要 | 1回限りの SQL | ✓ |
| B: 破棄して再収集 | クリーン | yfinance API消費、30分 | |
| C: 放置（並行運用） | 無作業 | 二重管理、混乱 | ✗ |

**推奨: A**

```sql
-- 1. auto_us_stock_trader schema にデータ移行
INSERT INTO auto_us_stock_trader."StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume, "createdAt")
SELECT id, "tickerCode", date, open, high, low, close, volume, "createdAt"
FROM public."StockDailyBar"
WHERE market = 'US';

INSERT INTO auto_us_stock_trader."IndexDailyBar" (id, "tickerCode", date, open, high, low, close, volume, "createdAt")
SELECT id, "tickerCode", date, open, high, low, close, volume, "createdAt"
FROM public."StockDailyBar"
WHERE market = 'INDEX';

-- VIX関連ETF/ローテーションETFは「US」にfallbackして入る想定
-- もしSP500/600以外の market="US" もあれば、それも auto_us_stock_trader."StockDailyBar" に流入

-- 2. EarningsDate は public/us 分離が無いので全件移行
INSERT INTO auto_us_stock_trader."EarningsDate" (id, "tickerCode", date, "createdAt")
SELECT id, "tickerCode", date, "createdAt"
FROM public."EarningsDate"
WHERE "tickerCode" NOT LIKE '%.T'  -- 日本株(.T サフィックス)を除外
  AND "tickerCode" NOT ~ '^[0-9]{4}$';  -- 4桁数字(JPコード)を除外

-- 3. 移行後、JP側のUS関連データを削除（任意、容量節約のため）
DELETE FROM public."StockDailyBar" WHERE market IN ('US', 'INDEX');
DELETE FROM public."EarningsDate"
WHERE "tickerCode" NOT LIKE '%.T'
  AND "tickerCode" NOT ~ '^[0-9]{4}$';
```

### JP 側 (auto-stock-trader) の変更

US データを auto_us_stock_trader schema に移したので、JP 側で以下の対応が必要:

1. **バックテストコードの参照先変更**
   - `src/backtest/us/us-data-fetcher.ts` の `fetchUSHistoricalFromDB` などが
     `prisma.stockDailyBar.findMany({ where: { market: "US" } })` を使っている
   - これを **auto_us_stock_trader schema 直接参照** または **本リポからのデータ取得** に書き換え
   - 選択肢:
     - (a) JP 側でも multiSchema 設定して `auto_us_stock_trader.*` を読む
     - (b) US バックテストコードを本リポ（auto-us-stock-trader）へ移管
   - **推奨: (b)**（責務分離の徹底）。本番取引着手時に併せて移管

2. **`StockDailyBar.market` カラムの扱い**
   - JP データのみ `public.StockDailyBar` に残るので、 `market` カラムは "JP" 固定 or 削除
   - 当面は触らない（JP system に影響しないため）。将来クリーンアップ

## 実装手順

### Phase 1: ローカル検証

```bash
cd ~/development/auto-us-stock-trader

# Prisma 導入
npm init -y
npm install -D prisma
npx prisma init --datasource-provider postgresql

# schema.prisma を上記設計通りに編集

# ローカル DB に migrate
DATABASE_URL="postgresql://kouheikameyama@localhost:5432/auto_stock_trader?schema=auto_us_stock_trader" \
  npx prisma migrate dev --name init_auto_us_stock_trader_schema

# auto_us_stock_trader schema が作成されたことを確認
psql -U kouheikameyama -h localhost -d auto_stock_trader \
  -c "\\dn"  # schema一覧
psql -U kouheikameyama -h localhost -d auto_stock_trader \
  -c "\\dt auto_us_stock_trader.*"  # auto_us_stock_trader schema のテーブル一覧
```

### Phase 2: backfill スクリプトの書き込み先変更

`scripts/data/*.py` の `INSERT INTO "StockDailyBar"` を `INSERT INTO auto_us_stock_trader."StockDailyBar"` に修正。
`market` カラム参照を削除（schema自体がUS専用なので不要）。

```python
# 変更前
"""
INSERT INTO "StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume, market)
VALUES %s
ON CONFLICT ("tickerCode", date) DO NOTHING
"""

# 変更後
"""
INSERT INTO auto_us_stock_trader."StockDailyBar" (id, "tickerCode", date, open, high, low, close, volume)
VALUES %s
ON CONFLICT ("tickerCode", date) DO NOTHING
"""
```

`backfill_index.py` は `auto_us_stock_trader."IndexDailyBar"` に変更。

### Phase 3: ローカル動作確認

```bash
# 5スクリプトを順次実行、auto_us_stock_trader schema にデータが入ることを確認
DATABASE_URL=local python scripts/data/backfill_daily_bars.py --index sp500 --yes
# ...

# 行数確認
psql -c "SELECT COUNT(*) FROM auto_us_stock_trader.\"StockDailyBar\";"
```

### Phase 4: Railway へ migrate deploy

```bash
DATABASE_URL="$RAILWAY_URL" npx prisma migrate deploy
```

### Phase 5: 既存データを Railway 上で移行

```bash
psql "$RAILWAY_URL" < migrate_us_data.sql
```

### Phase 6: GitHub Actions で動作確認

`workflow_dispatch:` で手動 trigger → Railway の auto_us_stock_trader schema に書き込まれることを確認。

### Phase 7: JP側のクリーンアップ（任意、後日）

`auto-stock-trader` 側で `public.StockDailyBar.market="US"` データを削除。
バックテストコードの参照先を auto_us_stock_trader schema に変更（または本リポへ移管）。

## 注意事項

- **本番DB（Railway）への migrate deploy は十分テスト後に**
  - ローカルで完全に動作確認してから
  - Prisma の `prisma migrate resolve --applied` は使わない（過去の事故あり、CLAUDE.md参照）
- **`auto-stock-trader` リポ側の Prisma スキーマには触らない**
  - 完全に独立した schema 管理
  - JP 側の migration 履歴に US テーブルが混入しないよう注意
- **データ移行 SQL は事前に dry-run**
  ```sql
  -- 件数だけ確認
  SELECT COUNT(*) FROM public."StockDailyBar" WHERE market = 'US';
  SELECT COUNT(*) FROM public."StockDailyBar" WHERE market = 'INDEX';
  ```
- **GitHub Actions の Secrets**
  - `DATABASE_URL`: Railway URL を設定。Prisma が自動で auto_us_stock_trader schema を使う

## ロードマップ上の位置付け

| ロードマップ項目 | 本ドキュメントの関与 |
|---|---|
| 1. ✅ 米国データ収集を別リポに分離 | 完了 |
| **2. 📋 auto_us_stock_trader schema 構築 + データ移行** | **本ドキュメント** |
| 3. 📋 SPY Credit Spread のテール耐性検証 | データ整備後 |
| 4. 📋 IBKR / Webull API クライアント実装 | 取引テーブル追加 |
| 5. 📋 バックテストコード本リポへ移管 | auto_us_stock_trader schema 確立後 |
| 6. 📋 本番取引開始 | 全段階完了後 |
