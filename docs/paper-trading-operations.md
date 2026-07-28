# Paper Trading 運用ガイド

Phase F（90 日 paper trading 観察）の運用手順と設定。

ブローカーは **Alpaca Paper Trading（クラウド REST API）**、日次実行は **GitHub Actions**
（`paper-trading-daily.yml`）で回す。TWS 等の常時起動プロセスやローカル Mac の稼働は不要。

## 全体像

```
平日 (月-金):
  NY 10:00      cron-job.org が paper-trading-daily.yml を workflow_dispatch
  (JST 23:00 /    └─ GitHub Actions (ubuntu-latest) 上で daily-runner.ts 実行
   冬時間 翌0:00)      ├─ kill switch / 重複発注チェック
                       ├─ position-syncer（Alpaca 実ポジと DB 照合）
                       ├─ close/expire 判定 → 発注
                       └─ entry 判定 → 発注
                  └─ record-skew.ts（IV skew スナップショットを DB に記録）
  起動 +5〜10 分   Slack 通知到着、ユーザーが目視確認

土曜:
  週次 Markdown レポート（`npm run paper-trading:weekly-report` を手動 or 別途起動）

日曜:
  休み（NY 市場休場）
```

> データ backfill（`us-daily.yml`、NY 18:00）と paper trading（`paper-trading-daily.yml`、NY 10:00）は
> 別ワークフロー。どちらも GitHub Actions の cron が UTC 固定で DST に揺れる & 遅延するため、
> 外部の [cron-job.org](https://cron-job.org) から `workflow_dispatch` を叩いて起動する
> （タイムゾーン `America/New_York` 指定で DST 自動追従。登録は [scripts/setup-cron-job.ts](../scripts/setup-cron-job.ts)）。
>
> 起動が寄り（09:30）でなく 10:00 なのは、opening rotation 中は spread が広く quote が荒れて
> limit が touch されにくいため。

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

# IV skew スナップショットを DB に記録（同日同 DTE は上書き）
npm run paper-trading:record-skew
```

ローカル実行には `.env` に `ALPACA_API_KEY` / `ALPACA_API_SECRET` / `ALPACA_API_ENDPOINT`
（+ optional `ALPACA_DATA_ENDPOINT`）と `DATABASE_URL` が必要。

---

## IV skew の日次記録（record-skew.ts）

`callSkewSlope` は VIX regime 依存だが、較正値 4.05 は低 VIX（~11-13%）の単一スナップショットのみ
（KOH-544）。**スパイク時の skew は事後に再現できない**ため、毎営業日スナップを貯める。

- `paper-trading-daily.yml` の最終ステップで実行。`if: always()` + `continue-on-error: true` のため、
  **取引サイクルが失敗しても / kill switch で停止中でも記録は走り、逆に記録が失敗しても取引には影響しない**
- 保存先: `IvSkewSnapshot`（`@@unique([date, dte])`。同日同 DTE の再実行は上書き）
- 失敗時は Slack に warning 通知（当日分が欠測する）
- **市場時間中に走ることが前提**。Alpaca の snapshot は時間外だと `impliedVol` が付かず、
  その場合は記録せずスキップ扱いで正常終了する（cron-job.org 登録は NY 10:00 平日）
- `vix` 列は DB の最新 close なので NY 10:00 時点では前営業日の値。live の regime 指標には
  同時取得の `baseIv`（ATM IV）を使うこと。`vixDate` 列で lag を確認できる
- `points` 列に生 smile（strike / x / iv / delta）を保持しているため、
  後から別の delta band 定義で再フィットできる

VIX スパイク当日に追加サンプルが欲しい場合は、市場時間中に手動実行してよい（`npm run paper-trading:record-skew`）。

## NY 市場との関係

- NY 9:30-16:00 ET = JST 22:30-翌5:00 (EDT) / JST 23:30-翌6:00 (EST)
- 日次サイクルは NY 10:00 起動 = **取引時間内**。SPY は live quote を使い、当日約定を狙う
  （limit が touch されなければ TIMEOUT で翌営業日に持ち越し）
- VIX は DB の最新 close を使う。backfill（`us-daily.yml`）が NY 18:00 のため、
  起動時点で DB にあるのは**前営業日の close**

### NY 取引時間外の挙動

手動実行など時間外に走らせた場合:
- live SPY/VIX が null なら early exit
- 発注は NY 取引時間のみ受理される（時間外は reject / timeout になり得る）
- option snapshot に `impliedVol` が付かないため、`record-skew.ts` は記録せずスキップする

---

## 監視タイミング（ユーザー確認）

| 頻度 | 内容 | タイミング |
|---|---|---|
| **毎営業日** | 日次サマリー + entry/skip 通知 | JST 23:10 頃 / 冬時間 翌0:10 頃（ワークフロー完了後）|
| **異常時** | 致命的エラー（緊急色 mention 付き）+ ワークフロー失敗通知 | 即時 |
| **毎週土曜** | 週次 Markdown レポート | 手動生成後に確認 |

→ **1 日 1 通の Slack を確認すれば運用回せる**設計（NY 寄り後なので JST では就寝前）。

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
