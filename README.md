# auto-us-stock-trader

米国株自動トレードシステム。データ収集・バックテスト・取引執行を統合（フェーズ的に拡張中）。

## ステータス

| フェーズ | 状態 | 内容 |
|---|---|---|
| **データ層** | ✅ 稼働中 | yfinance から OHLCV / 決算日 / 指数 / ETF を収集、PostgreSQL `auto_us_stock_trader` schema に保存 |
| **バックテスト層** | ✅ 本リポに移管済 | 8 戦略移管完了。SPY Credit Spread は tail-test で **6/7 PASS**（Max DD 21.6%、CVaR -$216、CAGR 8.83%）|
| **Paper Trading 層** | 🚧 構築中 | Phase A 信号ロジック純関数化 ✅、Phase B IBKR TWS API 接続 ✅、Phase C 発注は次フェーズ |
| **本番取引層** | 📋 未着手 | Paper trading 90 日観察 PASS 後に IBKR live で段階的にサイズアップ |

## アーキテクチャ

```
┌────────────────────────────────────────────────────────┐
│ auto-us-stock-trader (本リポ, US専用)                   │
│ ─────────────────────────────────                       │
│ scripts/data/        データ収集 (Python, GH Actions)    │
│ scripts/walk-forward/ WF backtest スクリプト (TS)       │
│ src/backtest/        Credit Spread 等 8 戦略 + tail-test │
│ src/paper-trading/   IBKR API クライアント (Phase B 完了)│
│ src/lib/             constants / Prisma client / etc.   │
│ src/core/            options-pricing / technical-analysis│
│ prisma/              schema + migrations                │
│ docs/plans/          設計ドキュメント                   │
│ docs/reports/        backtest / tail-test レポート       │
└──────────┬─────────────────────────────────────────────┘
           │ Prisma (TS) / psycopg2 (Python)
           ↓
┌────────────────────────────────────────────────┐
│ PostgreSQL (Railway)                            │
│  auto_us_stock_trader.*                         │
│    StockDailyBar (S&P500/600 OHLCV, 859k 行)    │
│    IndexDailyBar (^GSPC / ^VIX, 2007〜)          │
│    EarningsDate (US 銘柄の決算日)               │
│    Stock (銘柄マスタ)                           │
│  public.* ← JP (auto-stock-trader 別リポ管理)    │
└────────────────────────────────────────────────┘

       Paper Trading 系統:
┌──────────────────┐                ┌──────────────────┐
│ src/paper-trading│ ───TWS API───▶ │ IBKR TWS Paper   │
│ (TS, daily cron) │                │ (localhost:7497) │
└──────────────────┘                └──────────────────┘
```

### 設計判断

- **JP と完全独立**: 別リポ、別デプロイ、別 cron。失敗ドメイン分離
- **`auto_us_stock_trader` schema で名前空間分離**: 同一 Railway DB 内で `public.*`（JP）と完全独立
- **データ収集は dedicated cron**: 取引コードと別ライフサイクル、yfinance 障害が取引を止めない
- **Python = データ、TypeScript = バックテスト + 取引**: 各言語の得意領域に集中
- **信号ロジックは純関数で共有**: `src/backtest/credit-spread/{signal-generator,spread-evaluator,dd-stop}.ts` を backtest と paper trading 双方が呼び出す（DRY、戦略変更時にズレない）

## データ収集スクリプト

| スクリプト | 内容 | データソース |
|---|---|---|
| `scripts/data/backfill_daily_bars.py` | S&P 500/600 OHLCV | yfinance + Wikipedia |
| `scripts/data/backfill_earnings.py` | 決算日 | yfinance |
| `scripts/data/backfill_index.py` | ^GSPC, ^VIX | yfinance |
| `scripts/data/backfill_vol_etfs.py` | VXX/SVXY/UVXY/SVIX/VIXY | yfinance |
| `scripts/data/backfill_rotation_etfs.py` | SPY/EFA/AGG/QQQ/IWM/TLT/GLD/BND | yfinance |

## ローカル実行

```bash
# 仮想環境
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# .env 作成
cp .env.example .env  # → DATABASE_URL を編集

# 実行例
python scripts/data/backfill_daily_bars.py --index sp500 --yes
python scripts/data/backfill_index.py --yes
python scripts/data/backfill_vol_etfs.py
```

### コマンドラインオプション

| オプション | 対応スクリプト | 内容 |
|---|---|---|
| `--yes` | 全 backfill | 本番 DB 接続時の確認スキップ |
| `--index sp500` / `sp600` | `backfill_daily_bars.py` | 対象インデックス |
| `--start YYYY-MM-DD` | `backfill_daily_bars.py` / `backfill_index.py` | 開始日。省略時は直近 3 年 |
| `--end YYYY-MM-DD` | 同上 | 終了日。省略時は今日 |
| `--limit N` | `backfill_daily_bars.py` | 先頭 N 銘柄だけ処理（サンプル実行用） |

## GitHub Actions

| ワークフロー | スケジュール | 内容 |
|---|---|---|
| `us-daily.yml` | 平日 JST 7:00（米国close後）| OHLCV / 指数 / ETF |
| `us-weekly.yml` | 毎週土曜 JST 8:00 | 決算日 |

### Secrets 設定

GitHub repository の Settings → Secrets で以下を設定:

- `DATABASE_URL`: PostgreSQL接続URL（書き込み権限あり）
- `SLACK_WEBHOOK_URL`: Slack通知用Webhook URL（失敗時通知）

## DB スキーマ

PostgreSQL の `auto_us_stock_trader` schema で JP データと完全独立。Prisma で管理。

詳細設計: [docs/database-schema.md](docs/database-schema.md)

```
Railway PostgreSQL
├── public.*                    ← JP (auto-stock-trader 別リポ所有)
└── auto_us_stock_trader.*      ← US (本リポ所有)
      • StockDailyBar (S&P500/600 OHLCV、SPY/VXX 等の ETF 含む)
      • IndexDailyBar (^GSPC, ^VIX、2007 年から)
      • EarningsDate
      • Stock (銘柄マスタ)
      • (Phase C 以降) TradingOrder, Position, DailyEquitySnapshot, SignalLog, ErrorLog
```

ローカル / Railway とも `auto_us_stock_trader.IndexDailyBar` は 2007-01-03 〜 現在まで揃っている（リーマン期含む tail-test 検証用）。

## バックテスト戦略の検証結果

### 移管済 8 戦略

`src/backtest/us/us-{strategy}-{config,run,simulation,types}.ts`:
credit-spread / pead / gapup / momentum / mean-reversion / wheel / vix-contango / dual-momentum

実行: `npm run backtest:credit-spread -- --start YYYY-MM-DD --end YYYY-MM-DD`（同様に他戦略）

### SPY Credit Spread（本番候補、tail-test 6/7 PASS）

期間 2007-01-03 〜 2026-04-28（19 年強）の検証結果（KOH-451 / KOH-452 改修後）:

| 指標 | 値 | 閾値 | 判定 |
|---|---|---|---|
| Win Rate | 87.33% | ≥ 70% | ✅ |
| Profit Factor | 1.78 | ≥ 1.3 | ✅ |
| CAGR | 8.68% | ≥ 10% | ❌ あと 1.32 pt |
| Max DD | 21.61% | ≤ 25% | ✅ |
| CVaR 5% | -$216 | ≥ -$250 | ✅ |
| テール期間 DD（最悪） | 9.65% | ≤ 30% | ✅ |
| テール期間 PnL%（最悪） | -9.59% | ≥ -50% | ✅ |

設定: `shortPutDelta: 0.20`, `spreadWidth: $5`, `dte: 35`, `profitTarget: 50%`, `stopLossMultiplier: 2.0`, `vixCap: 30`, `indexTrendSmaPeriod: 50`, `ddStopEnabled: true / threshold: 0.15 / cooldown: 252日`

実行コマンド:
```bash
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label step3b-fixed
```

詳細レポート:
- [docs/reports/credit-spread-tail-2026-04-30-step3b-fixed.md](docs/reports/credit-spread-tail-2026-04-30-step3b-fixed.md)（最新、KOH-452 のバグ修正反映済）
- [docs/reports/credit-spread-tail-2026-04-30-step1f.md](docs/reports/credit-spread-tail-2026-04-30-step1f.md)（KOH-450、Step #1 best）
- [docs/reports/credit-spread-tail-2026-04-30.md](docs/reports/credit-spread-tail-2026-04-30.md)（KOH-449、初回検証）

### 他 7 戦略の tail-test

未実施（KOH-449 のフレームワーク `src/backtest/tail-test/` を他戦略にも適用する作業は保留中）。

## Paper Trading（IBKR TWS）

Phase A〜B 完了。Phase C 以降は次フェーズ。

```bash
# 接続テスト（要 TWS Paper Trading 起動 + ログイン）
nc -zv 127.0.0.1 7497    # port 確認
npx tsx src/paper-trading/test-connection.ts
```

詳細: [docs/plans/2026-04-30-paper-trading-design.md](docs/plans/2026-04-30-paper-trading-design.md)

## 関連リポジトリ

- [auto-stock-trader](https://github.com/koheikameyama/auto-stock-trader): 日本株取引システム（立花証券、独立リポ）
  - Prisma `public.*` schema の所有者
  - 米国データ収集 / バックテスト / 取引はすべて本リポへ移管済（KOH-447）

## ロードマップ

| # | 項目 | 状態 | Linear |
|---|---|---|---|
| 1 | 米国データ収集を別リポに分離（2026-04-27） | ✅ 完了 | - |
| 2 | `auto_us_stock_trader` schema 構築 + データ移行 | ✅ 完了 | KOH-446 |
| 3 | バックテストコード本リポへ移管 | ✅ 完了 | KOH-447 |
| 4 | 2007〜長期データ backfill (^GSPC / ^VIX) | ✅ 完了 | KOH-448 |
| 5 | SPY Credit Spread tail-test 実装 | ✅ 完了 | KOH-449 |
| 6 | 戦略リファクタ #1（DD hard stop）| ✅ 完了（4/7 PASS）| KOH-450 |
| 7 | 戦略の根本見直し（個別 SL 導入）| ✅ 完了（**6/7 PASS**） | KOH-451 |
| 8 | 信号ロジック純関数化 (Phase A) | ✅ 完了 | KOH-452 |
| 9 | IBKR TWS API 接続 リードオンリー (Phase B) | ✅ 完了 | KOH-453 |
| **10** | **発注 + 状態管理 (Phase C)** | 📋 **次** | KOH-454 (予定) |
| 11 | ロギング + 通知 + 週次レポート (Phase D) | 📋 | KOH-455 |
| 12 | エラー処理 + kill switch + テスト (Phase E) | 📋 | KOH-456 |
| 13 | 90 日 paper trading 観察 (Phase F) | 📋 | KOH-457 |
| 14 | 最終評価 + 本番判断 (Phase G) | 📋 | KOH-458 |
| 15 | 本番取引開始（live、段階サイズアップ） | 📋 | KOH-459 |

並行検討候補（保留中）:
- 他 7 戦略（pead/gapup/momentum/mean-reversion/wheel/vix-contango/dual-momentum）の tail-test 横展開
- Iron Condor 化（Credit Spread の CAGR 未達への代替策）
- 監視ダッシュボード（実取引開始後）

詳細設計:
- [docs/plans/2026-04-30-paper-trading-design.md](docs/plans/2026-04-30-paper-trading-design.md)（Paper Trading 全体設計）
- [docs/plans/2026-04-30-credit-spread-tail-improvement-design.md](docs/plans/2026-04-30-credit-spread-tail-improvement-design.md)（戦略改善履歴）

## 注意事項

- yfinance は無償だがレート制限あり。並列度は1-3に抑える（既存スクリプト準拠）
- `ON CONFLICT DO NOTHING` で冪等性を確保しているので、同日に複数回実行してOK
- 米国市場のholiday判定は yfinance 任せ（取得結果が空ならスキップ）
