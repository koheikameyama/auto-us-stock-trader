# breadth ダイバージェンス開示 — 設計ドキュメント

作成日: 2026-07-16
ロードマップ位置: 相場局面サブスク Phase 0（需要検証）の強化
前提: US 相場局面モニター公開済み（KOH-545 / stock-buddy.net 米国版）、有料化トラックは KOH-515 で段取り定義済み

## 目的

公開ページの breadth 表示を「生値の陳列」から「結論を出す指標」へ引き上げ、**Phase 0 の測定対象であるウェイトリスト登録の動機を作る**。同時に、その計算資産がそのまま Phase 1（有料）のフックになる構成にする。

## 背景 — なぜ今これなのか

現状 breadth は 3 箇所で使われているが、価値を出しきれていない。

| 用途 | 状態 |
|---|---|
| 株式戦略 BT のマーケットフィルター | live 化していない（ポートフォリオ補完候補として評価中） |
| paper trading（SPY IC） | **breadth を使わない**（VIX / SMA50 / DD-stop / セクター regime で判断） |
| 公開ページ・SNS | **生値を出しているだけ** |

公開ページの `breadth 62%` は、閾値（54%）の文脈がないと素人には意味が読めず、かつ signal count（N/5）と情報が重複している。breadth 単独の最大の価値は **ダイバージェンス（指数は高値なのに breadth が未追随）** の検出だが、生値表示ではそれが伝わらない。

## 制約 — 既存の 2 つのゲート（KOH-515）

本設計はこのゲートを跨がない範囲に収める。

1. **需要ゲート**: 「Phase 0 でウェイトリストが積み上がらなければ Phase 1（LINE / 課金）は作らない」
   → 本設計では**認証・課金・配信基盤を作らない**。作るのは Phase 0 の導線強化のみ。
2. **法務ゲート**: KOH-500（投資助言業の線引き）が課金開始の前提
   → 本設計では**文言を客観記述に限定**する（後述 Layer 3）。

## 方針サマリー

- breadth の divergence 判定を純関数として core に切り出す（BT / API / SNS で共用）
- 無料は「**事実の提示**」まで（閾値の文脈 + divergence の有無）
- 有料は「**中身**」（継続日数・乖離幅・起点・履歴）
- 文言は売買推奨に踏み込まない

---

## Layer 1: 計算 — `src/core/breadth-divergence.ts`（新規）

既存の `fetchBreadthSeries`（`core/breadth-history.ts`）と `fetchIndexFromDB("^GSPC")` を入力に取る純関数として実装する。credit-spread を decomposed 化したのと同じパターン（純関数 = テスト可能・BT と live で共用可能）。

```
入力: breadthSeries: BreadthHistoryPoint[]
      gspcSeries:    { date, close }[]
      lookback:      number（既定 20 営業日）

判定: S&P 500 が lookback 日高値圏にある か つ breadth が同期間で未追随

出力: {
  state: "DIVERGING" | "CONFIRMING" | "NONE"
  spxHighDays:    number   // 何日高値か
  breadthTrendPP: number   // 同期間の breadth 変化（pp）
  sinceDate:      Date | null  // divergence 継続の起点
}
```

- `DIVERGING`: 指数が高値更新、breadth は未追随（= 中身が伴っていない上昇）
- `CONFIRMING`: 指数の高値に breadth も追随（= 健全な上昇）
- `NONE`: 指数が高値圏にない

閾値（lookback 日数、breadth 未追随の判定幅）は定数として切り出し、後から調整可能にする。

## Layer 2: 開示レイヤー（無料 / 有料の線引き）

| 項目 | 無料 `/api/regime` | 有料 `/api/regime/full` |
|---|---|---|
| breadth 生値 | ✅ 既存 | ✅ 既存 |
| **閾値の文脈**（「62%・強気ライン 54% 超」） | ✅ **追加** | ✅ |
| **divergence の有無（フラグのみ）** | ✅ **teaser 追加** | ✅ |
| divergence の中身（継続日数 / 乖離幅 / 起点） | ❌ | ✅ **追加** |
| breadthChange30d | ❌ 既存通り | ✅ 既存 |
| 30 日スパークライン / 履歴 | ❌ | ✅ **将来** |

### 設計意図

- **閾値の文脈を無料に置く理由**: 数字の意味が読めないと、課金導線に乗る前に離脱する。生値 → 興味 → 登録 の導線には最低限の文脈が要る。
- **divergence を「有無だけ」無料に置く理由**: 「⚠️ ダイバージェンス検知中」という**事実**は見せるが、中身（いつから・どれだけ）は伏せる。これが Phase 0 のウェイトリスト登録動機 = ゲートの測定対象そのものになる。
- **signal count との重複回避**: breadth はすでに 5 シグナル中 2 つに織り込まれている。有料側で breadth を推すなら「signal count とは別に breadth 単独で何が言えるか」を立てる必要があり、その答えが divergence。

### 変更対象

- `src/web/routes/regime.ts` — `/` に divergence フラグ、`/full` に詳細
- `src/web/views/public-regime.ts` — 生値に閾値文脈、divergence teaser

## Layer 3: 法務ガード（必須の設計制約）

既存コードの規約をそのまま継承する。`core/regime-shift-detector.ts` の `LEVEL_SUMMARY` に既に明記されている:

> 客観的な「相場の状態」の記述に留め、売買推奨（「買い時」等）は含めない。

divergence は「天井警告」と書きたくなる領域であり、ここが KOH-500（投資助言業）との衝突ポイント。**文言は客観記述に統一する**。

| | 例 |
|---|---|
| ❌ 不可 | 「天井サイン」「売り時」「利確推奨」「危険」 |
| ✅ 可 | 「S&P 500 は 20 日高値、breadth は未追随」「指数の上昇に breadth が追随していない状態」 |

state 名（`DIVERGING` / `CONFIRMING`）も内部表現に留め、UI ラベルは事実の記述に落とす。

---

## スコープ

### やること（Phase 0 の範囲）

1. `src/core/breadth-divergence.ts` 新規 + ユニットテスト
2. `/api/regime` に divergence フラグ（bool）追加
3. `/api/regime/full` に divergence 詳細追加
4. `public-regime` view に閾値文脈 + divergence teaser

### やらないこと（意図的な非スコープ）

| | 理由 |
|---|---|
| Stripe / LINE / 認証 | 需要ゲート未通過。ウェイトリストが積んでから（KOH-515 Phase 1） |
| 30 日スパークライン / 履歴 UI | Phase 1 の有料ページ側で。今は API に土台があれば十分 |
| breadth を IC の売買判断に入れる | 別トラック。まず BT で効くか検証してから（現状 credit-spread 系 BT は breadth 不使用） |
| 株式戦略の live 化 | ポートフォリオ評価（Phase F）の結論待ち + 現物執行パスが未実装 |

## 判断ポイント（実装前に決めること）

- **lookback の既定値**: 20 営業日で始めるが、divergence が出っぱなし / 出なさすぎにならないか実データで確認してから確定する。
- **teaser の強度**: 「検知中」だけ出すか、「N 日継続」まで無料に出すか。前者を既定とするが、登録率が動かなければ後者を試す余地がある。
- **SNS への展開**: 日次投稿（`jobs/us-social-post.ts`）にも divergence を載せるかは、公開ページでの反応を見てから。

## 関連

- KOH-515 — 相場局面サブスク（Phase 0 → Phase 1 の段取り・ゲート定義）
- KOH-500 — 法規制リサーチ（投資助言業の線引き）= 課金開始前の前提
- KOH-545 — US 相場局面モニター構築（本設計の土台）
