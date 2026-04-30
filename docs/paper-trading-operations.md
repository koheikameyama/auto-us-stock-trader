# Paper Trading 運用ガイド

Phase F（90 日 paper trading 観察）の運用手順と設定。

## 全体像

```
平日 (月-金):
  JST 6:30 頃        Mac wake / TWS 起動状態確認（前夜から起動継続が理想）
  JST 7:00 (UTC 22:00) cron 自動実行
                       ├─ backfill (^GSPC/^VIX 等を DB に追加)
                       └─ daily-runner.ts (entry/close 判定 → 発注)
  JST 7:00 - 7:30    Slack 通知到着、ユーザーが目視確認
  JST 12:45 / 13:45  IBKR auto-logoff（要対策、後述）

土曜:
  JST 8:00           週次 Markdown レポート Slack 通知
                     必要に応じて TWS 再起動

日曜:
  休み（NY 市場休場、cron 動かない）
```

---

## TWS / IB Gateway の運用

### Auto-logoff の落とし穴

IBKR は規制上、毎日特定時刻に強制ログアウトする:
- 通常 NY 23:45 ET = JST 12:45 (EST) / 13:45 (EDT) 頃
- TWS 起動を続けてもログイン状態はリセットされる
- → JST 7:00 cron 時に未ログインで daily-runner が失敗する

### 対処（Paper なら可能）

**TWS の auto-logoff を無効化**:

```
TWS Configure → Settings → Lock and Exit
  → "Auto Log Off" をオフ または 朝 6:30 に設定
```

これで cron 起動前に再ログインが必要なくなる。Paper Trading では制限が緩く、無効化可能。Live の場合は時刻設定までしかできない。

---

## Mac の sleep 設定

cron が動くためには Mac が sleep していないこと。

### 充電中の sleep を無効化（推奨）

```bash
# 充電中 (AC 電源) は sleep しない
sudo pmset -c sleep 0

# 現在の設定確認
pmset -g
```

`-c` = AC 電源時、`sleep 0` = sleep 無効。

**注意**: ノート PC の蓋を閉じると `clamshellsleep` で sleep するので、蓋開けっぱなし or 外部モニター接続が必要。

### バッテリー時もカバーする場合（外出時）

```bash
sudo pmset -b sleep 0
```

ただしバッテリー消費激しいので非推奨。

### 元に戻す

```bash
# 既定値に戻す: AC 時 sleep 無効（もともと）、Battery 時 5 分
sudo pmset -c sleep 0
sudo pmset -b sleep 5
```

### 一時的な sleep 抑制（cron 単発用）

cron 起動時だけ sleep を防ぐ場合:

```bash
# 600 秒 (10 分) だけ sleep 抑制しながら実行
caffeinate -t 600 npx tsx src/paper-trading/daily-runner.ts
```

普段は通常 sleep、cron 時だけ wake → 実行 → 終了後 sleep に戻る、が可能。

### 関連の便利コマンド

| コマンド | 内容 |
|---|---|
| `pmset -g` | 現在の電源管理設定 |
| `pmset -g log \| head -30` | sleep/wake 履歴 |
| `caffeinate -i` | 一時的に sleep 無効（ターミナル起動中だけ）|
| `caffeinate -d` | display も含めて sleep 無効 |
| `caffeinate -t 600` | N 秒だけ sleep 無効 |

---

## cron 時間設計

### 想定スケジュール

| 時刻 (UTC) | 時刻 (JST) | ジョブ | 内容 |
|---|---|---|---|
| 22:00 (Mon-Fri) | 翌 7:00 | `us-daily.yml` (既存) | yfinance backfill |
| 22:30 (Mon-Fri) | 翌 7:30 | `daily-runner.ts` (Phase D 以降) | paper trading |
| 23:00 (Sat) | 翌 8:00 | weekly-report (Phase D) | 週次 Markdown 生成 |

### NY 市場の関係

- NY 9:30-16:00 ET = JST 23:30-翌5:00 (summer EDT) / JST 翌0:30-6:00 (winter EST)
- 市場クローズ後の close データは 30〜60 分で IBKR に反映
- JST 7:00 cron 時点で当日 close を使えるが、戦略は既存 spread のクローズ判定 + 翌日エントリー判断ベースなので影響軽微

### NY 取引時間外の挙動

`daily-runner.ts` は時間外でも動く設計:
- live SPY/VIX が null なら `early exit`（dry-run 動作確認済）
- 発注は NY 9:30-16:00 のみ受理される（時間外は `RejectedSignal` 等になる）
- JST 7:00 cron は close 後だが当日 fill は不可、翌日 open まで待つ仕様

---

## 監視タイミング（ユーザー確認）

| 頻度 | 内容 | タイミング |
|---|---|---|
| **毎朝** | 日次サマリー + entry/skip 通知 | JST 7:30 頃（cron 完了後）|
| **異常時** | 致命的エラー（緊急色 mention 付き）| 即時 |
| **毎週土曜** | 週次 Markdown レポート | JST 8:00 |

→ **朝食前後に Slack 1 通確認すれば運用回せる**設計。

---

## 完全自動化の選択肢

Phase F 開始時点では「手動 + auto-logoff オフ + Mac sleep オフ」で十分だが、本番に進むなら以下を検討:

| 方式 | メリット | デメリット |
|---|---|---|
| **A. TWS GUI を 24h 起動**（現状）| シンプル、視覚的確認可能 | Mac 常時起動必要、再起動忘れリスク |
| **B. IB Gateway**（軽量 GUI なし）+ launchd auto-restart | 半自動、メモリ消費少 | 設定やや複雑 |
| **C. AWS EC2 / VPS 上で IB Gateway**（推奨される本番運用）| 完全自動・冗長、24h ネット安定 | 月額費用、移行作業、IBKR の地理制限 |
| **D. クラウドホスティング型 IB（IB のサービス）**| 最も堅牢 | Live のみ、Paper では使えない |

Phase F (90 日観察) の最初は **A**。NG な日があっても冪等性で翌日復旧可能。本番（KOH-459）に進む時に **B or C** へ移行。

---

## 緊急時の操作

### Kill switch（即時停止）

```bash
echo "緊急停止理由をここに" > .paper-trading-stop
```

これだけで daily-runner は次回実行時に即 exit。

解除:

```bash
rm .paper-trading-stop
```

### 異常検知時

二重発注検知 / 想定外例外（Phase E で実装）が発生すると:
- Slack に緊急通知（`<!channel>` mention 付き）
- Phase E 実装後は kill switch 自動 ON

手動対応:
1. Slack を見て事象把握
2. 必要なら TWS で対象注文を手動キャンセル
3. DB の状態を psql で確認・修正
4. 原因解消後に kill switch 解除

---

## 推奨運用設定の組み合わせ

| 項目 | 設定 |
|---|---|
| TWS Lock and Exit | Auto Log Off **OFF**（または朝 6:30 に設定）|
| Mac sleep | `sudo pmset -c sleep 0`（充電時 sleep 無効）|
| TWS 再起動 | 週 1 回（土曜午後）— メモリ解放 + 強制セッション更新 |
| Slack 確認 | 毎朝 7:30、土曜 8:00 |
| Kill switch | 緊急時 `echo > .paper-trading-stop` |

---

## トラブルシューティング

### cron が動かない

```bash
# launchd ログ確認
log show --predicate 'subsystem == "com.apple.launchd"' --last 1h | grep paper-trading

# 直接実行で動作確認
npx tsx src/paper-trading/daily-runner.ts --dry-run
```

### TWS への接続失敗

```bash
# port 確認
nc -zv 127.0.0.1 7497

# TWS process 確認
pgrep -lf "Trader.Workstation\|tws"

# TWS 再起動 → ログイン
```

### IBKR auto-logoff された

TWS GUI でログイン画面が出ている場合:
1. ログイン
2. (Configure → Lock and Exit を未設定なら) Auto Log Off をオフに

### 発注が REJECTED

- NY 取引時間外 → 翌取引日まで待つ
- `Buying Power` 不足 → IBKR Paper の equity 設定変更（Configure → Settings → Account 等）
- 流動性低い strike を選択 → SPY ATM 周辺なら問題なし

---

## 参考

- 設計: [`docs/plans/2026-04-30-paper-trading-design.md`](plans/2026-04-30-paper-trading-design.md)
- Phase C 実装: [`docs/plans/2026-04-30-paper-trading-phase-c-implementation-plan.md`](plans/2026-04-30-paper-trading-phase-c-implementation-plan.md)
- Linear: KOH-454 (Phase C 実装中、Task 11 待ち)
