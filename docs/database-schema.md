# DB スキーマ設計

## 方針: PostgreSQL `auto_us_stock_trader` schema で完全分離

物理的に同じ Railway DB だが、PostgreSQL の schema 機能で logical 分離。
JP（[auto-stock-trader](https://github.com/koheikameyama/auto-stock-trader)）と US（本リポ）でテーブルを名前空間レベルで完全独立させる。

```
Railway PostgreSQL
├── public.*                    ← JP (auto-stock-trader 別リポ所有)
│     • StockDailyBar           （JP 銘柄、`market` カラムあり）
│     • EarningsDate
│     • Stock, TradingOrder, Position 等
│
└── auto_us_stock_trader.*      ← US (本リポ所有)
      • StockDailyBar           （S&P 500/600 + ETF）
      • IndexDailyBar           （^GSPC, ^VIX、2007 年〜）
      • EarningsDate
      • Stock                   （銘柄マスタ）
      • _prisma_migrations
```

### なぜ schema 分離か

| 比較項目 | schema 分離（採用） | 別 DB | テーブル名 prefix |
|---|---|---|---|
| 名前衝突 | なし（`auto_us_stock_trader.StockDailyBar` と `public.StockDailyBar` 共存可）| なし | あり（`us_stock_daily_bar` 冗長） |
| Railway コスト | 1 service で済む | 2 service 必要 | 1 service |
| 権限分離 | 可能 | 完全分離 | 不可 |
| Prisma 設定 | `multiSchema` (Prisma 6+ で GA) | URL が 2 つ | 通常通り |
| 所有権の明確さ | ✓ schema 単位で明確 | ✓ DB 単位 | ✗ 同じ schema に混在 |

→ schema 分離が最適バランス。

### なぜ table 名に `US` prefix を付けないか

schema が `auto_us_stock_trader` で名前空間分離されているので JP 側と衝突しない。
JP と**同じ命名**にすることで認知負荷を下げる。

---

## 現状のテーブル

実体は [`prisma/schema.prisma`](../prisma/schema.prisma) を参照。要約:

### `auto_us_stock_trader.StockDailyBar`

S&P 500/600 銘柄 + ETF（SPY/VXX/UVXY 等）の日足 OHLCV。

| カラム | 型 | 内容 |
|---|---|---|
| `id` | String (cuid) | PK |
| `tickerCode` | String | 例: "AAPL", "SPY", "UVXY" |
| `date` | Date | 取引日 |
| `open` / `high` / `low` / `close` | Float | OHLC |
| `volume` | BigInt | 出来高 |
| `createdAt` | DateTime | デフォルト now() |

- ユニーク: `(tickerCode, date)`
- インデックス: `(tickerCode, date DESC)`, `(date)`
- 件数（2026-04-30 現在）: 約 86 万行 / 1,119 銘柄

**JP との違い**: `market` カラムなし（schema 自体が US 専用）。

### `auto_us_stock_trader.IndexDailyBar`

`^GSPC` (S&P 500) と `^VIX` 等の指数。JP の `public.StockDailyBar` では `market="INDEX"` で混在していたが、本リポでは別テーブルに分離。

| カラム | 型 | 内容 |
|---|---|---|
| `id` | String (cuid) | PK |
| `tickerCode` | String | "^GSPC", "^VIX" |
| `date` / OHLC / volume | （StockDailyBar と同じ） | volume は基本 0 |

- 件数: 約 4,860 行 × 2 銘柄、**2007-01-03 〜 現在**（リーマン期含む tail-test 検証用）

### `auto_us_stock_trader.EarningsDate`

| カラム | 型 | 内容 |
|---|---|---|
| `id` | String (cuid) | PK |
| `tickerCode` | String | |
| `date` | Date | 決算発表日 |

- ユニーク: `(tickerCode, date)`
- 件数: 約 11,000 行 / 448 銘柄

### `auto_us_stock_trader.Stock`

S&P 500/600 銘柄マスタ（現状 0 行、銘柄リストは Wikipedia から都度取得しており本テーブルは未使用）。

| カラム | 型 | 内容 |
|---|---|---|
| `tickerCode` | String (unique) | |
| `name`, `sector`, `industry` | String | |
| `marketCap` | BigInt? | |
| `indexNames` | String[] | ["SP500", "SP600"] |
| `isActive` | Boolean | |

将来: 銘柄リストの定期同期、外部データ（GICS sector）の取り込み等で活用予定。

---

## Phase C 以降で追加予定のテーブル

Paper Trading 実装（KOH-454+）で以下を migration 追加予定:

| テーブル | 内容 |
|---|---|
| `TradingOrder` | IBKR 注文履歴（symbol, strikes, expiry, fill price, status 等） |
| `Position` | 保有 spread（entry/close 日付、credit, netPnl 等） |
| `DailyEquitySnapshot` | 日次 EOD の cash/equity/DD 状態 |
| `SignalLog` | 各日の信号生成結果（ENTERED / SKIP_* + 当日の VIX/SPY/SMA） |
| `ErrorLog` | 接続エラー / 約定失敗 / 想定外例外の記録 |

詳細設計: [`docs/plans/2026-04-30-paper-trading-design.md`](plans/2026-04-30-paper-trading-design.md)

中長期（本番取引で更に追加）:

| テーブル | 内容 |
|---|---|
| `OptionContract` | オプション契約マスタ（IBKR conId キャッシュ等） |
| `MarketAssessment` | 市場評価（VIX レジーム、SPY トレンド判定の履歴） |

---

## Prisma 設定

実体: [`prisma/schema.prisma`](../prisma/schema.prisma)

抜粋:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  schemas  = ["auto_us_stock_trader"]
}
```

すべてのモデルに `@@schema("auto_us_stock_trader")` を付ける。

### Migration 運用

- 開発: `npx prisma migrate dev --name <name>` でローカル DB に適用
- 本番: `npx prisma migrate deploy`（Railway URL を指定）
- ⚠️ `prisma migrate resolve --applied` は使わない（過去の事故事例あり、[グローバル CLAUDE.md](https://github.com/koheikameyama/auto-us-stock-trader#claudemd) 参照）

### npm scripts

```bash
npm run prisma:generate           # Prisma client 生成
npm run prisma:migrate:dev        # ローカル migrate
npm run prisma:migrate:deploy     # 本番 migrate
npm run prisma:studio             # Prisma Studio (GUI)
```

---

## 移行履歴（参考）

KOH-446 で完了した移行作業の記録。再実行不要。

<details>
<summary>当時の移行手順</summary>

1. ローカル検証: `npm install -D prisma` → `prisma init` → schema 編集 → `migrate dev`
2. backfill スクリプトの書き込み先を `auto_us_stock_trader.*` に変更（KOH-447）
3. Railway へ `prisma migrate deploy`
4. ローカルの `public.StockDailyBar (market='US'/'INDEX')` を `auto_us_stock_trader.*` に SQL 移行
5. ローカルから Railway へ pg_dump / restore で投入（yfinance API 消費ゼロ）
6. GitHub Actions で動作確認

ローカル `public.*` の US 残存データは未削除（影響なし、必要なら別途 DELETE）。
JP 側 `auto-stock-trader` リポの `public.StockDailyBar` には `market="JP"` で JP 銘柄のみ残存。

</details>

---

## 注意事項

- **本番 DB への migrate は十分テスト後**: ローカルで完全動作確認 → `npx prisma migrate deploy`
- **JP 側 `auto-stock-trader` リポの schema には触らない**: 完全に独立した管理、migration 履歴も別
- **GitHub Actions Secrets**: `DATABASE_URL` を本番 Railway URL に設定。Python スクリプトは `auto_us_stock_trader.*` を fully qualified で書き込むため、URL に `?schema=` パラメータは**不要**（むしろ psycopg2 が認識せずエラー）
- **Prisma だけは `?schema=auto_us_stock_trader` を要求**することがある（migrate 実行時など）

ロードマップは [README.md](../README.md#ロードマップ) に集約。
