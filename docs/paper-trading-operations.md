# Paper Trading 運用ガイド

Phase F（90 日 paper trading 観察）の運用手順と設定。

ブローカーは **Alpaca Paper Trading（クラウド REST API）**、日次実行は **GitHub Actions**
（`paper-trading-daily.yml`）で回す。TWS 等の常時起動プロセスやローカル Mac の稼働は不要。

## 全体像

```
平日 (月-金):
  JST 7:00 頃   cron-job.org が paper-trading-daily.yml を workflow_dispatch
                  └─ GitHub Actions (ubuntu-latest) 上で daily-runner.ts 実行
                       ├─ kill switch / 重複発注チェック
                       ├─ position-syncer（Alpaca 実ポジと DB 照合）
                       ├─ close/expire 判定 → 発注
                       └─ entry 判定 → 発注
  JST 7:00 - 7:30   Slack 通知到着、ユーザーが目視確認

土曜:
  週次 Markdown レポート（`npm run paper-trading:weekly-report` を手動 or 別途起動）

日曜:
  休み（NY 市場休場）
```

> データ backfill（`us-daily.yml`）と paper trading（`paper-trading-daily.yml`）は別ワークフロー。
> どちらも GitHub Actions の cron が UTC 固定で DST に揺れる & 遅延するため、
> 外部の [cron-job.org](https://cron-job.org) から `workflow_dispatch` を叩いて起動する。

---

## 実行環境（GitHub Actions）

`paper-trading-daily.yml`:

- `runs-on: ubuntu-latest`、`timeout-minutes: 30`
- `actions/checkout` → Node 20 → `npm ci` → `npx prisma generate` → `npx tsx src/paper-trading/daily-runner.ts`
- 失敗時は `rtCamp/action-slack-notify` で Slack に通知

### 必要な Secrets

GitHub repository の Settings → Secrets:

| Secret | 用途 |
|---|---|
| `DATABASE_URL` | PostgreSQL 接続 URL（`?schema=` なしで登録。ワークフロー側で `?schema=auto_us_stock_trader` を合成）|
| `ALPACA_API_KEY` / `ALPACA_API_SECRET` | Alpaca Paper Trading API 認証 |
| `ALPACA_API_ENDPOINT` | Alpaca REST エンドポイント（例 `https://paper-api.alpaca.markets/v2`）|
| `SLACK_WEBHOOK_URL` | 日次サマリー / 失敗通知 |

---

## ローカルでの手動実行

デバッグ / 動作確認用:

```bash
# 接続 smoke test（口座 / ポジション / SPY quote / option chain）
npx tsx src/paper-trading/test-connection.ts

# 日次サイクル（--dry-run で発注スキップ）
npx tsx src/paper-trading/daily-runner.ts --dry-run

# 週次レポート（docs/paper-trading/weekly-YYYY-Www.md を生成）
npm run paper-trading:weekly-report
```

ローカル実行には `.env` に `ALPACA_API_KEY` / `ALPACA_API_SECRET` / `ALPACA_API_ENDPOINT`
（+ optional `ALPACA_DATA_ENDPOINT`）と `DATABASE_URL` が必要。

---

## NY 市場との関係

- NY 9:30-16:00 ET = JST 23:30-翌5:00 (EDT) / JST 翌0:30-6:00 (EST)
- 市場クローズ後の close データは 30〜60 分で Alpaca に反映
- JST 7:00 起動時点で当日 close を使えるが、戦略は既存 spread のクローズ判定 + エントリー判断ベースなので影響軽微

### NY 取引時間外の挙動

`daily-runner.ts` は時間外でも動く設計:
- live SPY/VIX が null なら early exit
- 発注は NY 取引時間のみ受理される（時間外は reject / timeout になり得る）
- JST 7:00 起動は close 後だが当日 fill は不可、翌取引日の約定を待つ仕様

---

## 監視タイミング（ユーザー確認）

| 頻度 | 内容 | タイミング |
|---|---|---|
| **毎朝** | 日次サマリー + entry/skip 通知 | JST 7:30 頃（ワークフロー完了後）|
| **異常時** | 致命的エラー（緊急色 mention 付き）+ ワークフロー失敗通知 | 即時 |
| **毎週土曜** | 週次 Markdown レポート | 手動生成後に確認 |

→ **朝食前後に Slack 1 通確認すれば運用回せる**設計。

---

## 緊急時の操作

### 運用を止める（GitHub Actions 実行を止める）

日次サイクルは cron-job.org → `workflow_dispatch` で起動しているため、**確実に止めるには
cron-job.org 側のジョブを一時停止**する（または GitHub の Actions を無効化 / Secrets を退避）。

### Kill switch（`.paper-trading-stop`）

`daily-runner.ts` は起動時に作業ディレクトリ直下の `.paper-trading-stop` ファイルを見て、
存在すれば即 exit する:

```bash
echo "緊急停止理由をここに" > .paper-trading-stop   # 停止
rm .paper-trading-stop                                # 解除
```

> ⚠️ **注意**: `.paper-trading-stop` は `.gitignore` 済みのため、GitHub Actions の
> fresh checkout には現れない。この kill switch が効くのは **ローカル実行のみ**。
> CI（GitHub Actions）で回している運用を止めるには、上記の cron-job.org 停止を使う。

### 二重発注 / 想定外例外

- Slack に緊急通知（`<!channel>` mention 付き）
- daily-runner の grand catch が ErrorLog に記録

手動対応:
1. Slack / GitHub Actions ログで事象把握
2. 必要なら Alpaca のダッシュボードで対象注文を手動キャンセル
3. DB（`TradingOrder` / `Position`）の状態を psql で確認・修正
4. 原因解消後に運用再開

---

## トラブルシューティング

### ワークフローが起動しない

- cron-job.org のジョブが有効か、`workflow_dispatch` の対象ブランチ / トークンが正しいか確認
- GitHub → Actions タブで手動 `Run workflow` して切り分け

### Alpaca への接続失敗

```bash
# ローカルで疎通確認
npx tsx src/paper-trading/test-connection.ts
```

- 401/403 → `ALPACA_API_KEY` / `ALPACA_API_SECRET` / `ALPACA_API_ENDPOINT` を確認
- paper と live のエンドポイント取り違えに注意（paper は `paper-api.alpaca.markets`）

### 発注が REJECTED / TIMEOUT

- NY 取引時間外 → 翌取引日まで待つ
- Buying Power 不足 → Alpaca Paper のアカウント設定を確認
- 流動性が低い strike → SPY ATM 周辺なら問題なし（`snapStrikesToChain` が listing 済み strike にスナップ）

---

## 参考

- 設計: [`docs/plans/2026-04-30-paper-trading-design.md`](plans/2026-04-30-paper-trading-design.md)
- Phase C/D/E 実装: [`docs/plans/2026-05-01-paper-trading-cde-implementation-plan.md`](plans/2026-05-01-paper-trading-cde-implementation-plan.md)
- Linear: KOH-457（Phase F 観察）
