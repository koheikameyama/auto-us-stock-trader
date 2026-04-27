# trading-data-collector

トレードシステム向け、市場データ収集専用リポジトリ。

取引ロジックは持たず、yfinance などから OHLCV / 決算日 / 指数 / ETF データを取得して
共有 PostgreSQL に書き込むだけの責務を担う。

## アーキテクチャ

```
┌──────────────────────────────────┐
│ trading-data-collector (本リポ)  │
│ Python + GitHub Actions          │
│ ──────────────────               │
│ • S&P 500/600 OHLCV              │
│ • 決算日                          │
│ • 指数（^GSPC, ^VIX）            │
│ • ETF（SPY, EFA, AGG, SVXY等）   │
└─────────┬────────────────────────┘
          │ psycopg2 で書き込み
          ↓
┌──────────────────────────────────┐
│ PostgreSQL (Railway)             │
│  StockDailyBar, EarningsDate     │
└─────────┬────────────────────────┘
          │ 各取引システムが読み込み
          ↓
┌────────────────────┐  ┌────────────────────┐
│ auto-stock-trader  │  │ auto-us-options    │
│ JP取引、立花API     │  │ (将来) US取引       │
└────────────────────┘  └────────────────────┘
```

## なぜ独立リポか

- **失敗ドメイン分離**: yfinance障害で取引システムを止めない
- **スケジュール独立**: 取引はマーケット時間連動、データは夜間バッチで十分
- **言語最適化**: データ収集はPython、取引はTypeScriptが得意な領域に集中
- **拡張性**: 米国データ追加が既存JP取引システムに影響しない

## スクリプト一覧

| スクリプト | 内容 | データソース |
|---|---|---|
| `scripts/us/backfill_daily_bars.py` | S&P 500/600 OHLCV | yfinance + Wikipedia |
| `scripts/us/backfill_earnings.py` | 決算日 | yfinance |
| `scripts/us/backfill_index.py` | ^GSPC, ^VIX | yfinance |
| `scripts/us/backfill_vol_etfs.py` | VXX/SVXY/UVXY/SVIX/VIXY | yfinance |
| `scripts/us/backfill_rotation_etfs.py` | SPY/EFA/AGG/QQQ/IWM/TLT/GLD/BND | yfinance |

## ローカル実行

```bash
# 仮想環境作成
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# .env を作成
cp .env.example .env
# → DATABASE_URL を編集

# 実行例
python scripts/us/backfill_daily_bars.py --index sp500 --yes
python scripts/us/backfill_index.py --yes
python scripts/us/backfill_vol_etfs.py
```

### コマンドラインオプション

| オプション | 内容 |
|---|---|
| `--yes` | 本番DB接続時の確認スキップ |
| `--index sp500` / `sp600` | 対象インデックス（daily_bars のみ） |

## GitHub Actions

| ワークフロー | スケジュール | 内容 |
|---|---|---|
| `us-daily.yml` | 平日 JST 7:00 | OHLCV / 指数 / ETF |
| `us-weekly.yml` | 毎週土曜 JST 8:00 | 決算日 |

### Secrets 設定

GitHub repository の Settings → Secrets で以下を設定:

- `DATABASE_URL`: PostgreSQL接続URL（書き込み権限あり）
- `SLACK_WEBHOOK_URL`: Slack通知用Webhook URL

## DBスキーマ

スキーマは取引システム側（`auto-stock-trader` の Prisma）で管理。
本リポは psycopg2 で直接書き込みするだけ。

主要テーブル:
- `StockDailyBar (id, tickerCode, date, open, high, low, close, volume, market)`
  - ユニーク制約: `(tickerCode, date)`
  - `market`: `"US"` で米国データを識別
- `EarningsDate (id, tickerCode, date)`
  - ユニーク制約: `(tickerCode, date)`

スキーマ変更時は本リポの該当スクリプトも合わせて更新する必要あり。

## 関連リポジトリ

- [auto-stock-trader](https://github.com/koheikameyama/auto-stock-trader): 日本株取引システム（立花証券）
- (将来) auto-us-options: 米国オプション取引システム

## 注意事項

- yfinance は無償だがレート制限あり。並列度は1-3に抑える（既存スクリプト準拠）
- ON CONFLICT DO NOTHING で冪等性を確保しているので、同日に複数回実行してOK
- 米国市場のholiday判定は yfinance 任せ（取得結果が空ならスキップ）
