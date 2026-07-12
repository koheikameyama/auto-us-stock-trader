# auto-us-stock-trader

米国株自動トレードシステム。データ収集・バックテスト・取引執行を統合（フェーズ的に拡張中）。

## ステータス

| フェーズ | 状態 | 内容 |
|---|---|---|
| **データ層** | ✅ 稼働中 | yfinance から OHLCV / 決算日 / 指数 / ETF を収集し、Risk-on/off レジーム・マクロイベントも算出。PostgreSQL `auto_us_stock_trader` schema に保存 |
| **バックテスト層** | ✅ 本リポに移管済 | 8 戦略移管完了。tail-test / walk-forward / portfolio 分析フレームワーク実装済。SPY Credit Spread は **skew+slippage 込みで edge 消滅（4/7 FAIL, CAGR -0.5%）と判明**（後述）|
| **Paper Trading 層** | ✅ 自律運用中 | Phase A〜E 完了。**Alpaca REST API** で entry/close/expire 発注・kill switch・Slack 通知・週次レポートまで自動化。現在 Phase F（90 日観察）|
| **本番取引層** | 📋 未着手 | Paper trading 90 日観察 PASS 後に Alpaca live で段階的にサイズアップ |

## アーキテクチャ

```
┌────────────────────────────────────────────────────────┐
│ auto-us-stock-trader (本リポ, US専用)                   │
│ ─────────────────────────────────                       │
│ scripts/data/         データ収集 (Python, GH Actions)   │
│ scripts/regime/       Risk-on/off レジーム計算 (Python) │
│ scripts/walk-forward/ WF backtest / 月次評価 (TS)       │
│ src/backtest/us/      Credit Spread 等 8 戦略           │
│ src/backtest/framework/ tail-test / portfolio 分析      │
│ src/paper-trading/    Alpaca REST クライアント + 日次実行│
│ src/core/             options-pricing / technical-analysis│
│ src/lib/              constants / Prisma client / etc.  │
│ prisma/               schema + migrations               │
│ docs/plans/           設計ドキュメント                  │
│ docs/paper-trading/   週次レポート出力先                │
└──────────┬─────────────────────────────────────────────┘
           │ Prisma (TS) / psycopg2 (Python)
           ↓
┌────────────────────────────────────────────────┐
│ PostgreSQL (Railway)                            │
│  auto_us_stock_trader.*                         │
│    StockDailyBar (S&P500/600 OHLCV + ETF)       │
│    IndexDailyBar (^GSPC / ^VIX, 2007〜)          │
│    EarningsDate (US 銘柄の決算日)               │
│    Stock (銘柄マスタ)                           │
│    RegimeSignal (Risk-on/off) / MacroEvent      │
│    TradingOrder / Position / DailyEquitySnapshot│
│    SignalLog / ErrorLog                          │
│  public.* ← JP (auto-stock-trader 別リポ管理)    │
└────────────────────────────────────────────────┘

       Paper Trading 系統:
┌──────────────────┐              ┌──────────────────────┐
│ src/paper-trading│ ──REST API──▶│ Alpaca Paper Trading │
│ (TS, daily cron) │              │ paper-api.alpaca...  │
└──────────────────┘              └──────────────────────┘
```

### 設計判断

- **JP と完全独立**: 別リポ、別デプロイ、別 cron。失敗ドメイン分離
- **`auto_us_stock_trader` schema で名前空間分離**: 同一 Railway DB 内で `public.*`（JP）と完全独立
- **データ収集は dedicated cron**: 取引コードと別ライフサイクル、yfinance 障害が取引を止めない
- **Python = データ、TypeScript = バックテスト + 取引**: 各言語の得意領域に集中
- **ブローカーは Alpaca REST API**: 常時起動プロセス（TWS 等）不要で GitHub Actions / cron から直接発注できる。オプション chain・quote・発注をすべて HTTP で完結
- **信号ロジックは純関数で共有**: `src/backtest/credit-spread/{signal-generator,spread-evaluator,dd-stop}.ts` を backtest と paper trading 双方が呼び出す（DRY、戦略変更時にズレない）

## データ収集スクリプト

| スクリプト | 内容 | データソース |
|---|---|---|
| `scripts/data/backfill_daily_bars.py` | S&P 500/600 OHLCV | yfinance + Wikipedia |
| `scripts/data/backfill_earnings.py` | 決算日 | yfinance |
| `scripts/data/backfill_index.py` | ^GSPC, ^VIX | yfinance |
| `scripts/data/backfill_vol_etfs.py` | VXX/SVXY/UVXY/SVIX/VIXY | yfinance |
| `scripts/data/backfill_rotation_etfs.py` | SPY/EFA/AGG/QQQ/IWM/TLT/GLD/BND + 11 SPDR セクター ETF | yfinance |
| `scripts/data/seed_macro_events.py` | FOMC/CPI/NFP/PPI 等のマクロイベント | `data/macro_events.csv` |
| `scripts/regime/compute_regime.py` | Risk-on/off レジーム判定（XLY/XLP・XLK/XLU の 50DMA クロス）| DB（ETF 価格）|

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
| `us-daily.yml` | 平日 JST 7:00 頃（cron-job.org から `workflow_dispatch`）| OHLCV / 指数 / ETF backfill + regime 計算 |
| `us-weekly.yml` | 毎週土曜 JST 8:00（cron）| 決算日 |
| `paper-trading-daily.yml` | 平日（cron-job.org から `workflow_dispatch`）| Alpaca daily cycle（entry/close/expire 発注）|
| `monthly-walk-forward.yml` | 毎月 1 日 JST 9:00（cron）| 全戦略の walk-forward 月次評価 |
| `db-migrate-deploy.yml` | `main` に `prisma/migrations/**` push 時 | 本番 DB へ `prisma migrate deploy` |
| `macro-events-seed.yml` | 手動 | `data/macro_events.csv` を MacroEvent へ UPSERT |
| `regime-init.yml` | 手動（初回のみ）| RegimeSignal テーブル作成 + 過去 10 年 backfill |

> us-daily / paper-trading-daily は GitHub Actions の cron が UTC 固定で DST に揺れる & 遅延するため、
> 外部の [cron-job.org](https://cron-job.org) から `workflow_dispatch` を叩く構成に移行済み。

### Secrets 設定

GitHub repository の Settings → Secrets で以下を設定:

- `DATABASE_URL`: PostgreSQL 接続 URL（`?schema=` なしで登録。ワークフロー側で合成）
- `SLACK_WEBHOOK_URL`: Slack 通知用 Webhook URL（成功 / 失敗通知）
- `ALPACA_API_KEY` / `ALPACA_API_SECRET`: Alpaca Paper Trading API 認証
- `ALPACA_API_ENDPOINT`: Alpaca REST エンドポイント（例 `https://paper-api.alpaca.markets/v2`）

## DB スキーマ

PostgreSQL の `auto_us_stock_trader` schema で JP データと完全独立。Prisma で管理。

詳細設計: [docs/database-schema.md](docs/database-schema.md)

```
Railway PostgreSQL
├── public.*                    ← JP (auto-stock-trader 別リポ所有)
└── auto_us_stock_trader.*      ← US (本リポ所有)
      データ収集:
      • StockDailyBar (S&P500/600 OHLCV、SPY/VXX 等の ETF 含む)
      • IndexDailyBar (^GSPC, ^VIX、2007 年から)
      • EarningsDate / Stock (銘柄マスタ)
      • RegimeSignal (Risk-on/off) / MacroEvent (FOMC/CPI/NFP/PPI)
      Paper Trading:
      • TradingOrder / Position / DailyEquitySnapshot
      • SignalLog / ErrorLog
```

ローカル / Railway とも `auto_us_stock_trader.IndexDailyBar` は 2007-01-03 〜 現在まで揃っている（リーマン期含む tail-test 検証用）。

## バックテスト戦略の検証結果

### 移管済 8 戦略

`src/backtest/us/us-{strategy}-{config,run,simulation,types}.ts`:
credit-spread / pead / gapup / momentum / mean-reversion / wheel / vix-contango / dual-momentum

実行: `npm run backtest:credit-spread -- --start YYYY-MM-DD --end YYYY-MM-DD`（同様に他戦略）

**共通フレームワーク**（`src/backtest/framework/`）: tail-test（リーマン等ストレス期間の DD/PnL 検証）、
portfolio 分析（`npm run portfolio-analysis`）、walk-forward（`scripts/walk-forward/`、パラメータグリッドを
in-sample 最適化 → out-of-sample 検証）。月次評価は `npm run walk-forward:monthly` / `monthly-walk-forward.yml` で自動実行。

### SPY Credit Spread（⚠️ 現行構成は edge なしと判明）

**結論: フラット IV backtest の 6/7 PASS は、entry クレジットの約 20% 過大評価が生んだ蜃気楼だった。**
実 fill を skew + slippage で織り込むと edge は消滅する。

| 指標 | 旧（flat IV, 6/7 PASS）| **新（skew+slippage）** | 閾値 | 判定 |
|---|---|---|---|---|
| Win Rate | 87.3% | 83.1% | ≥ 70% | ✅ |
| Profit Factor | 1.78 | **1.02** | ≥ 1.3 | ❌ |
| CAGR | 8.68% | **-0.51%** | ≥ 10% | ❌ |
| Max DD | 21.6% | **58.0%** | ≤ 25% | ❌ |
| CVaR 5% | -$216 | -$231 | ≥ -$250 | ✅ |
| テール DD（最悪）| 9.7% | 23.9% | ≤ 30% | ✅ |
| テール PnL%（最悪）| -9.6% | -23.9% | ≥ -50% | ✅ |

裏付けとなった 3 つの独立証拠:
1. **paper-trading 実 fill が BS モデル比 -21%**（[diff-report](src/paper-trading/diff-report.ts)、`npm run paper-trading:diff-report`）
2. **その乖離を backtest に入れると 4/7 FAIL・CAGR マイナス**（上表、2007-2026 tail-test）
3. **walk-forward は過学習判定・安定パラメータ無し**（直近 27ヶ月、`npm run walk-forward:credit-spread`）

主因は **skew（~17%）**: フラット IV で short/long を同一 IV 評価していたのが過大評価の正体（slippage は $0.04, ~5% のみ）。

backtest 忠実度パラメータ（[us-credit-spread-config.ts](src/backtest/us/us-credit-spread-config.ts) の `US_CREDIT_SPREAD_BACKTEST_FIDELITY`）:
`ivSkewSlope: 5.5`, `entrySlippage: $0.04`（paper-trading 実 fill で較正、平均乖離 ≈0%）。
**backtest / walk-forward / tail-test の入口だけで有効化し、paper-trading（live）は skew 未設定で挙動不変。**

戦略設定: `shortPutDelta: 0.20`, `spreadWidth: $5`, `dte: 35`, `profitTarget: 50%`, `stopLossMultiplier: 2.0`, `vixCap: 30`, `indexTrendSmaPeriod: 50`, `ddStopEnabled: true / threshold: 0.15 / cooldown: 252日`

実行:
```bash
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label skew-slip
```

改善履歴・設計:
- [docs/plans/2026-04-30-credit-spread-tail-improvement-design.md](docs/plans/2026-04-30-credit-spread-tail-improvement-design.md)（戦略改善履歴）
- [docs/spy-credit-spread-roadmap.md](docs/spy-credit-spread-roadmap.md)（本番投入ロードマップ。edge 再検証が前提条件に）

### 他戦略の tail-test

共通フレームワーク `src/backtest/framework/tail-test/` を各戦略に適用。
dual-momentum / pead / momentum は tail-test 実装済（`npm run tail-test:dual-momentum` 等、
各 `src/backtest/{strategy}/{run-tail-test,tail-test-thresholds}.ts`）。残り戦略への横展開は保留中。

## Paper Trading（Alpaca REST）

Phase A〜E 完了。Alpaca Paper Trading API に対し、entry/close/expire 発注・kill switch・
Slack 通知・週次レポートまで自律実行できる。現在 Phase F（90 日観察）。

`src/paper-trading/` の主なモジュール:

| ファイル | 役割 |
|---|---|
| `alpaca-client.ts` | Alpaca REST クライアント（口座 / ポジション / quote / option chain / 発注）|
| `daily-runner.ts` | 日次サイクル本体（entry/close/expire 判定 → 発注 → 通知）|
| `order-manager.ts` | スプレッド発注 / クローズ / OCC symbol 生成 |
| `position-syncer.ts` | ブローカー実ポジションと DB の照合 |
| `regime-multiplier.ts` | RegimeSignal に応じた発注枚数スケーリング |
| `kill-switch.ts` | 環境変数フラグによる緊急停止 |
| `slack-notifier.ts` | entry/close/DD stop/エラー等の Slack 通知 |
| `weekly-report.ts` | 週次 Markdown レポート生成（`docs/paper-trading/`）|
| `with-retry.ts` | 一時障害向けリトライヘルパー |

```bash
# 接続 smoke test（要 ALPACA_* env）
npx tsx src/paper-trading/test-connection.ts

# 日次サイクル（--dry-run で発注スキップ）
npx tsx src/paper-trading/daily-runner.ts --dry-run

# 週次レポート
npm run paper-trading:weekly-report
```

必要 env: `ALPACA_API_KEY` / `ALPACA_API_SECRET` / `ALPACA_API_ENDPOINT`（+ optional `ALPACA_DATA_ENDPOINT`）。

詳細:
- [docs/paper-trading-operations.md](docs/paper-trading-operations.md)（運用ガイド）
- [docs/plans/2026-04-30-paper-trading-design.md](docs/plans/2026-04-30-paper-trading-design.md)（全体設計）

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
| 9 | ブローカー API 接続 リードオンリー (Phase B) | ✅ 完了 | KOH-453 |
| 10 | IBKR TWS → **Alpaca REST** へ切替 | ✅ 完了 | - |
| 11 | 発注 + 状態管理 (Phase C) | ✅ 完了 | KOH-454 |
| 12 | ロギング + 通知 + 週次レポート (Phase D) | ✅ 完了 | KOH-455 |
| 13 | エラー処理 + kill switch + テスト (Phase E) | ✅ 完了 | KOH-456 |
| 14 | 90 日 paper trading 観察 (Phase F) | 🚧 インフラ検証として継続 | KOH-457 |
| 15 | **backtest 忠実度: skew+slippage 反映 → 現行構成 edge なしと判明** | ✅ 完了 | - |
| 16 | 最終評価 + 本番判断 (Phase G) | ⏸ 保留（edge 再構築が前提）| KOH-458 |
| 17 | 本番取引開始（Alpaca live、段階サイズアップ）| ⏸ 保留 | KOH-459 |

> **重要**: 現行 SPY credit spread（0.20δ / $5幅 / 35DTE）は skew 込みで edge なしと確定。
> live 移行は edge を再構築できるまで保留。Phase F の paper 観察はインフラ検証目的で継続する。

次の一手（要検討）:
- **戦略 pivot**: Iron Condor 化 / 別デルタ・DTE の再最適化（WF は δ0.3・pt0.8 方向に集まった）/ 別戦略
- 他 7 戦略（pead/gapup/momentum/mean-reversion/wheel/vix-contango/dual-momentum）の tail-test 横展開
- 監視ダッシュボード（実取引開始後）

詳細設計:
- [docs/plans/2026-04-30-paper-trading-design.md](docs/plans/2026-04-30-paper-trading-design.md)（Paper Trading 全体設計）
- [docs/plans/2026-04-30-credit-spread-tail-improvement-design.md](docs/plans/2026-04-30-credit-spread-tail-improvement-design.md)（戦略改善履歴）

## 注意事項

- yfinance は無償だがレート制限あり。並列度は1-3に抑える（既存スクリプト準拠）
- `ON CONFLICT DO NOTHING` で冪等性を確保しているので、同日に複数回実行してOK
- 米国市場のholiday判定は yfinance 任せ（取得結果が空ならスキップ）
