# Credit Spread テール耐性改善 設計ドキュメント

作成日: 2026-04-30
ロードマップ位置: KOH-449 (Phase 3 検証 FAIL) を受けた戦略リファクタ → KOH-450

## 目的

KOH-449 のテール耐性検証で判定 ❌ FAIL（5/7 checks）となった SPY Credit Spread 戦略を、**最小限のパラメータ調整**で 7/7 PASS に持ち込む。実取引判断を「YES」へ転換する。

## KOH-449 の問題サマリー

| 指標 | 実測値 | 閾値 | 判定 |
|---|---|---|---|
| Win Rate | 93.77% | ≥ 70% | ✅ |
| Profit Factor | 1.86 | ≥ 1.3 | ✅ |
| CAGR | 10.53% | ≥ 10% | ✅ |
| **Max DD** | **54.43%** | ≤ 25% | ❌ |
| **CVaR 5%** | **-$415** | ≥ -$250 | ❌ |
| テール期間 DD（最悪）| 29.12% | ≤ 30% | ✅ (ギリ) |
| テール期間 PnL%（最悪）| -27% | ≥ -50% | ✅ |

**根本原因:** Lehman 前後（2007-07 → 2009-05 → 2010-12、673 日）の累積 DD。VIX cap=30 + SMA50 フィルタは個別ストレス期で機能するが、**フィルタ発動前の早期エントリー**（2008-05〜08、VIX 18〜25）が Lehman 直撃で max loss 化。

## 方針サマリー

- **ステップワイズ運用**: 4 つの調整候補を効きそうな順に1つずつ追加、PASS で即停止
- **積み上げ式**: 前 Step の変更を残したまま次 Step 追加
- **設定駆動**: 全変更を config に追加し既存挙動を破壊しない（既定値で OFF も可能）
- **最小限の変更**: PASS 達成後の追加調整は YAGNI で見送り

## 全体プロセス

```
Step #1: DD hard stop 追加
   tail-test 再実行
       PASS → 終了
       FAIL → Step #2 へ
       │
       ▼
Step #2: VIX cap 30→20
   tail-test 再実行
       PASS → 終了
       FAIL → Step #3 へ
       │
       ▼
Step #3: SMA50→SMA20
   tail-test 再実行
       PASS → 終了
       FAIL → Step #4 へ
       │
       ▼
Step #4: VIX 20-30 帯のポジション半減
   tail-test 再実行
       PASS → 終了
       FAIL → 戦略根本見直し（KOH-451 へ）
```

各 Step で `docs/reports/credit-spread-tail-YYYY-MM-DD-stepN.md` を残す。

---

## Step #1: DD hard stop（最優先・最も効果見込み大）

### 仕様

- equity が peak からの DD で **15% を超えた時点で新規エントリー停止**
- 既存スプレッドは満期まで保持（強制クローズしない）
- equity が peak の **95%** まで戻ったら再開（hysteresis）

### 期待効果

- Lehman 前後で 1〜2 回 max loss 後、自動停止 → 復活待ち
- 累積 DD を 54% → 15〜25% に圧縮見込み
- 2011, 2018, 2020 の他のテール期も同様に保護

### 実装

#### `src/backtest/us/us-credit-spread-types.ts`

`USCreditSpreadBacktestConfig` に追加:

```typescript
/** Equity DD ハードストップを有効化 */
ddStopEnabled: boolean;
/** DD 閾値（peak からの下落比率、0.15 = 15%）*/
ddStopThreshold: number;
/** 再開条件: equity が peak の何 % まで戻ったら再開（0.95 = 95%）*/
ddStopReentryPct: number;
```

#### `src/backtest/us/us-credit-spread-config.ts`

`US_CREDIT_SPREAD_DEFAULTS` に追加:

```typescript
ddStopEnabled: true,
ddStopThreshold: 0.15,
ddStopReentryPct: 0.95,
```

#### `src/backtest/us/us-credit-spread-simulation.ts`

main loop の構造をリファクタ:

1. Equity 計算を**ループ先頭**に移動（既存はループ末尾）
2. 既存スプレッド評価・クローズ → equity 計算 → DD ステート更新 → 新規エントリー判定 → equity curve push

擬似コード:

```typescript
let runningPeak = config.initialBudget;
let ddStopActive = false;

for (const today of tradingDays) {
  // 1. 既存スプレッド評価・クローズ（既存）
  // ... (existing)

  // 2. Equity 計算（既存ロジックをループ先頭へ移動）
  let unrealizedSpreadValue = 0;
  for (const sp of openSpreads) {
    // ... existing pricing
  }
  const totalEquity = cash + unrealizedSpreadValue;

  // 3. DD hard stop 判定（新規）
  if (totalEquity > runningPeak) runningPeak = totalEquity;
  const dd = (runningPeak - totalEquity) / runningPeak;
  if (config.ddStopEnabled) {
    if (!ddStopActive && dd > config.ddStopThreshold) ddStopActive = true;
    else if (ddStopActive && totalEquity / runningPeak >= config.ddStopReentryPct) ddStopActive = false;
  }

  // 4. 新規エントリー判定（既存に !ddStopActive を追加）
  if (openSpreads.length < config.maxPositions && !ddStopActive) {
    // ... existing VIX cap / SMA filter / tryOpenSpread
  }

  // 5. equity curve push（既存）
  equityCurve.push({ date: today, cash, positionsValue: unrealizedSpreadValue, totalEquity, openPositionCount: openSpreads.length });
}
```

### Step #1 完了基準

- typecheck エラーなし
- `npm test` 全 15 件 PASS
- `npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label step1` 完走
- `docs/reports/credit-spread-tail-YYYY-MM-DD-step1.md` 出力
- 比較: Max DD が 54% から大幅に減少

---

## Step #2: VIX cap 30→20（Step #1 で FAIL の場合のみ）

### 変更

`us-credit-spread-config.ts` の `vixCap: 30` → `vixCap: 20`

既存ロジック（`vix > config.vixCap` で skip）はそのまま機能。

### 期待効果

2008 年 5〜8 月のエントリー停止（VIX 18〜25 帯で警戒）。max loss スプレッド大幅減少。

### Step #2 完了基準

- レポート `credit-spread-tail-YYYY-MM-DD-step2.md` 出力
- 平時 CAGR ≥ 10% を維持しつつ Max DD と CVaR が PASS

---

## Step #3: SMA50→SMA20（Step #2 で FAIL の場合のみ）

### 変更

`us-credit-spread-config.ts` の `indexTrendSmaPeriod: 50` → `indexTrendSmaPeriod: 20`

### 期待効果

トレンド転換を 30 営業日早く捕捉。2007 後半〜2008 前半の高値圏入場を阻止。

### リスク

- ホイップソー増加 → 平時 Win Rate / CAGR 低下
- もし PASS しないなら Step #4 へ

---

## Step #4: VIX 20-30 帯のポジション半減（Step #3 で FAIL の場合のみ）

### 仕様

- VIX > 20 かつ ≤ 30 の時、`contractsPerSpread` を `0.5 × 元の contracts`（最低 1）にする
- VIX ≤ 20 帯は通常維持

### 実装

#### `us-credit-spread-types.ts`

```typescript
/** VIX 高ボラ帯（20-30）のポジション縮小率 */
vixHighRegimeContractMultiplier: number;
```

#### `us-credit-spread-config.ts`

```typescript
vixHighRegimeContractMultiplier: 0.5,
```

#### `us-credit-spread-simulation.ts` の `tryOpenSpread()`

```typescript
let effectiveContracts = config.contractsPerSpread;
if (vix > 20 && vix <= 30) {
  effectiveContracts = Math.max(1, Math.floor(config.contractsPerSpread * config.vixHighRegimeContractMultiplier));
}
const collateralRequired = config.spreadWidth * CONTRACT_SIZE * effectiveContracts;
// 以降の credit / commission / spread 構築で effectiveContracts を使用
```

### 期待効果

- VIX 20-30 帯（テール準備期）のリスク露出半減
- Step #2-#3 で削れた CAGR を補完

---

## ループ運用

### 中間成果物

`run-credit-spread-tail-test.ts` に `--label` オプションを追加:

```typescript
const stepLabel = getArg("label");
const suffix = stepLabel ? `-${stepLabel}` : "";
const reportPath = path.join(outDir, `credit-spread-tail-${today}${suffix}.md`);
// CSV も同様に suffix 付加
```

実行例:
```bash
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label step1
# → docs/reports/credit-spread-tail-2026-04-30-step1.md
```

### コミット規約

各 Step で 1 コミット。メッセージ形式:

```
feat(credit-spread): Step N - <調整内容> (PASS|FAIL)

変更: <パラメータ追加/変更内容>

結果:
- Max DD: AA% → BB% (PASS|FAIL)
- CVaR 5%: -$AAA → -$BBB (PASS|FAIL)
- CAGR: AA% → BB%
- 詳細: docs/reports/credit-spread-tail-YYYY-MM-DD-stepN.md
```

### Linear タスク

- **KOH-450** (In Progress): 本ドキュメントに対応
- 各 Step 結果をコメントで追記（任意）
- 最終 PASS 時に Done
- 4 回 FAIL なら **KOH-451**（戦略根本見直し、Iron Condor 化等）を Backlog で新規作成

---

## テスト戦略

### 各 Step 共通

- `npm run typecheck` エラーなし
- `npm test` 全 15 件 + 新規（あれば）すべて PASS
- tail-test 実行で `verdict.overallPass` が true → PASS

### Step #1 のユニットテスト

**省略**（YAGNI、tail-test 実行で動作検証）。

検証根拠:
- DD stop ロジック自体 < 30 行
- 「Max DD が 54% → 15〜25% 程度に下がる」で動作確認
- 下がらなければ実装バグが疑われる

### Step #2-#4 のユニットテスト

不要（パラメータ定数変更のみ、または小さな contract 計算追加）。

### リグレッション検出

各 Step 後、既存 15 件の tail-test ユニットテストが PASS することを確認。

### 失敗時の切り分け

| 観察 | 想定原因 | 対処 |
|---|---|---|
| DD が変わらない | DD stop 判定が走っていない | console.log で `ddStopActive` 状態を出力、デバッグ |
| DD は下がったが Spreads 数も激減 | reentryPct が厳しすぎる | 0.95 → 0.92 に緩める |
| Spreads 数は維持されたが DD 改善小 | threshold が緩すぎる | 0.15 → 0.10 に厳しく |
| typecheck エラー | 型追加漏れ | エラーメッセージに従い修正 |

---

## YAGNI 原則による不採用一覧

- 他戦略（pead, gapup 等）への横展開（DD stop の汎用化）→ 別タスクで
- DD stop の閾値振り感度分析（10%, 15%, 20%, 25% 比較）→ 必要なら別タスクで
- 動的ポジションサイジング（VIX 連続値ベースの段階調整）→ Step #4 は離散的でシンプル化
- ML ベースの取引タイミング判定 → スコープ外
- 監視ダッシュボード（リアルタイム DD 表示等）→ 不要
- HTML レポート / グラフ画像 → Markdown のみ
- パラメータグリッドサーチ → YAGNI

## 次フェーズ

### 4 Step 全 PASS の場合
- KOH-450 Done、本ドキュメントを成功事例として保管
- ロードマップ #4（IBKR/Webull API クライアント実装）へ進む

### 4 Step 全 FAIL の場合
- KOH-450 を Cancelled でクローズ
- KOH-451: 「戦略根本見直し」を Backlog 作成
  - 候補:
    - Iron Condor 化（bull put + bear call で両側ヘッジ）
    - Calendar Spread（DTE を分散）
    - 別戦略（VIX ETN short volatility 等）
  - 別ブレストセッションから着手

## 参考

- `docs/plans/2026-04-28-credit-spread-tail-test-design.md` (Phase 3 設計)
- `docs/plans/2026-04-30-credit-spread-tail-test-implementation-plan.md` (Phase 3 実装プラン)
- `docs/reports/credit-spread-tail-2026-04-30.md` (KOH-449 検証結果)
- KOH-447, KOH-448, KOH-449
