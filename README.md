# auto-us-stock-trader

米国株自動トレードシステム。データ収集・バックテスト・取引執行を統合（フェーズ的に拡張中）。

## ステータス

| フェーズ | 状態 | 内容 |
|---|---|---|
| **データ層** | ✅ 稼働中 | yfinance から OHLCV / 決算日 / 指数 / ETF を収集、PostgreSQL に保存 |
| **バックテスト層** | 🚧 [auto-stock-trader リポ](../auto-stock-trader/src/backtest/us/)に暫定配置中 | 8戦略検証済み（Phase 1: GapUp/Momentum/PEAD/MeanRev/Wheel + Phase 2: SPY Credit Spread / VIX Contango / Dual Momentum）。本リポへの移管は本番取引着手時に実施 |
| **取引層** | 📋 未着手 | IBKR / Webull API クライアント、注文執行、ポジション管理 |

## アーキテクチャ方針

```
┌────────────────────────────────────────────────┐
│ auto-us-stock-trader (本リポ, US専用)          │
│ ──────────────────                             │
│ scripts/data/   データ収集 (Python, GH Actions) │
│ scripts/lib/    共通ヘルパー                    │
│ src/            (将来) 取引コード TypeScript    │
│ docs/           設計ドキュメント                │
└──────────┬─────────────────────────────────────┘
           │ psycopg2 で読み書き
           ↓
┌──────────────────────────────────┐
│ PostgreSQL (Railway)             │
│  StockDailyBar (market="US")     │
│  EarningsDate                    │
│  (将来) USTradingOrder 等         │
└──────────┬───────────────────────┘
           │ Prisma で読み込み
           ↓
┌──────────────────────────────────┐
│ auto-stock-trader (JP専用リポ)    │
│ JP取引、立花API（独立稼働）       │
└──────────────────────────────────┘
```

### 設計判断

- **JPと完全独立**: 別リポ、別デプロイ、別cron。失敗ドメイン分離
- **共通DBスキーマは auto-stock-trader 側で管理**: 米国専用テーブル追加時のみ本リポでPrisma導入
- **データ収集は dedicated cron**: 取引コードと別ライフサイクル、yfinance障害が取引を止めない
- **Python = データ、TypeScript = 取引**: 各言語の得意領域に集中

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

| オプション | 内容 |
|---|---|
| `--yes` | 本番DB接続時の確認スキップ |
| `--index sp500` / `sp600` | 対象インデックス（daily_bars のみ） |

## GitHub Actions

| ワークフロー | スケジュール | 内容 |
|---|---|---|
| `us-daily.yml` | 平日 JST 7:00（米国close後）| OHLCV / 指数 / ETF |
| `us-weekly.yml` | 毎週土曜 JST 8:00 | 決算日 |

### Secrets 設定

GitHub repository の Settings → Secrets で以下を設定:

- `DATABASE_URL`: PostgreSQL接続URL（書き込み権限あり）
- `SLACK_WEBHOOK_URL`: Slack通知用Webhook URL（失敗時通知）

## DBスキーマ

**米国専用 PostgreSQL `us` schema を本リポで管理する方針**（Prisma 導入予定）。

詳細設計: [docs/database-schema.md](docs/database-schema.md)

```
Railway PostgreSQL
├── public.*   ← JP (auto-stock-trader 所有)
└── us.*       ← US (本リポ所有、新規構築中)
      • us.StockDailyBar
      • us.EarningsDate
      • us.IndexDailyBar
      • us.Stock
      • (将来) us.TradingOrder, us.OptionContract 等
```

現状: 暫定的に `public.StockDailyBar (market="US")` に投入されているが、
us schema 構築後にデータ移行 + backfill スクリプトの書き込み先変更を予定。

## バックテスト戦略の検証結果

詳細は [auto-stock-trader/docs/specs/backtest-us-stocks.md](../auto-stock-trader/docs/specs/backtest-us-stocks.md) 参照。

| 戦略 | WF判定 | 結論 |
|---|---|---|
| **SPY Credit Spread** | OOS PF 4.86, 勝率96% | **本番候補** |
| Dual Momentum (GEM) | 5/7正窓、SPY劣後 | 限定的有効 |
| GapUp / Momentum / PEAD / Mean Reversion / Wheel / VIX Contango | エッジなし | 不採用 |

## 関連リポジトリ

- [auto-stock-trader](https://github.com/koheikameyama/auto-stock-trader): 日本株取引システム（立花証券）
  - Prisma スキーマの所有者
  - 米国バックテストコードを暫定配置中（本番取引着手時に本リポへ移管）

## ロードマップ

1. ✅ 米国データ収集を別リポに分離（2026-04-27）
2. 📋 SPY Credit Spread のテール耐性検証（2018 Volmageddon, 2020 COVID 期間）
3. 📋 IBKR or Webull API クライアント実装（paper trading）
4. 📋 本リポへバックテストコード移管
5. 📋 本番取引開始（少額 → スケールアップ）

## 注意事項

- yfinance は無償だがレート制限あり。並列度は1-3に抑える（既存スクリプト準拠）
- `ON CONFLICT DO NOTHING` で冪等性を確保しているので、同日に複数回実行してOK
- 米国市場のholiday判定は yfinance 任せ（取得結果が空ならスキップ）
