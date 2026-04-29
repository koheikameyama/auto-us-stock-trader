# Credit Spread Step #1 (DD Hard Stop) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SPY Credit Spread に Equity DD ハードストップを追加し、累積 DD を 54% → 25% 以内に圧縮することで tail-test 7/7 PASS を目指す（Step #1 のみのスコープ）。

**Architecture:** `USCreditSpreadBacktestConfig` に `ddStopEnabled / ddStopThreshold / ddStopReentryPct` を追加。`us-credit-spread-simulation.ts` の day-loop に DD ステート（runningPeak, ddStopActive）と判定ロジックを挿入。equity 計算を「close 後 / new entry 前」に行うため小さなリファクタを伴う。各 Step のレポート区別のため `run-credit-spread-tail-test.ts` に `--label` オプションを追加。

**Tech Stack:** TypeScript 6, vitest, dayjs, tsx

**前提:**
- KOH-449 (Phase 3 検証) 完了 — 結果 ❌ FAIL（5/7 checks）、Max DD 54.43%、CVaR 5% -$415
- 設計書: `docs/plans/2026-04-30-credit-spread-tail-improvement-design.md` (Step #1)
- 既存テスト 15/15 PASS、tail-test 動作確認済

---

## ロールバック方法

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
git status

# Task 1〜5 (実装) のコミットを丸ごと revert する場合
git log --oneline | head -20  # SHA を確認
git revert <最新の SHA>..<開始 SHA>

# まだ commit していない変更を破棄
git checkout -- src/backtest/us/ src/backtest/tail-test/run-credit-spread-tail-test.ts

# tail-test レポートを削除
rm -f docs/reports/credit-spread-tail-*-step1.*
```

---

## Task 1: types.ts に DD stop フィールドを追加

**Files:**
- Modify: `src/backtest/us/us-credit-spread-types.ts:53`（`verbose: boolean;` の直前に追加）

### Step 1: フィールド追加

`src/backtest/us/us-credit-spread-types.ts` の `verbose: boolean;`（line 53）の**直前**に以下を挿入:

```typescript
  /** Equity DD ハードストップを有効化 */
  ddStopEnabled: boolean;
  /** DD 閾値（peak からの下落比率、0.15 = 15%）。ddStopEnabled=false 時無視 */
  ddStopThreshold: number;
  /** 再開条件: equity が peak の何 % まで戻ったら再開（hysteresis、0.95 = 95%） */
  ddStopReentryPct: number;

```

### Step 2: 検証

Run: `npm run typecheck`
Expected: コンパイルエラーが**多数**出る（`config.ts` で defaults を満たしていない、`simulation.ts` で参照されていない、ただし型必須なので `Property 'ddStopEnabled' is missing in type ...` 系のエラー）。

これは想定内。Task 2 で defaults を追加するまで一時的にエラー。

### Step 3: 一時コミット（型のみ）

NOTE: typecheck エラーが残るため、一時的に commit せず Task 2 と組み合わせるのが安全。**コミットは Task 2 まで完了後に1回**で行う。

---

## Task 2: config.ts の DEFAULTS に既定値追加

**Files:**
- Modify: `src/backtest/us/us-credit-spread-config.ts:35`（`verbose: false,` の直前に追加）

### Step 1: 既定値追加

`src/backtest/us/us-credit-spread-config.ts` の `verbose: false,`（line 35）の**直前**に以下を挿入:

```typescript
  // DD hard stop（Step #1）
  ddStopEnabled: true,
  ddStopThreshold: 0.15,
  ddStopReentryPct: 0.95,

```

### Step 2: 検証

Run: `npm run typecheck`
Expected: エラーなし（types.ts のフィールドが defaults で全て満たされる）

### Step 3: コミット（Task 1 + 2 をまとめて）

```bash
git add src/backtest/us/us-credit-spread-types.ts src/backtest/us/us-credit-spread-config.ts
git commit -m "feat(credit-spread): DD hard stop の config フィールドを追加

- ddStopEnabled: true (Step #1 で有効化)
- ddStopThreshold: 0.15 (peak から 15% 下落で停止)
- ddStopReentryPct: 0.95 (peak の 95% まで戻って再開)

simulation.ts でのロジック実装は次タスク。

Refs: KOH-450 (予定)"
```

---

## Task 3: simulation.ts に equity 計算ヘルパーを追加（リファクタ）

**Files:**
- Modify: `src/backtest/us/us-credit-spread-simulation.ts`

### 背景

現状の day-loop は equity 計算を末尾で行うため、新規エントリー判定時点では当日 equity が未確定。DD stop は新規エントリー判定の**前**に必要なので、equity 計算をループ中盤に持ってくる必要がある。重複計算を避けるためにヘルパー関数を抽出する。

### Step 1: ヘルパー関数を simulation.ts に追加

`src/backtest/us/us-credit-spread-simulation.ts` 内、トップレベル関数のうち `priceSpread` の直後（line 49 直後）に以下を挿入:

```typescript
/** 開いてるスプレッドの unrealized value（collateral - 現在の負債） */
function calcUnrealizedSpreadValue(
  openSpreads: SimulatedSpread[],
  spotSpy: number,
  iv: number,
  riskFreeRate: number,
  spreadWidth: number,
  today: string,
): number {
  let total = 0;
  for (const sp of openSpreads) {
    const tte = Math.max(daysBetween(today, sp.expirationDate) / 365, 0);
    const currentValue = priceSpread(spotSpy, sp.shortStrike, sp.longStrike, tte, riskFreeRate, iv);
    total += spreadWidth * CONTRACT_SIZE * sp.contracts - currentValue * CONTRACT_SIZE * sp.contracts;
  }
  return total;
}
```

### Step 2: 既存の equity 計算ループを置換（line 244-260 付近）

現在の `// ── 3. equity curve 計算 ──` ブロック (line 243〜260) を以下に置換:

**変更前** (line 243-260):
```typescript
    // ── 3. equity curve 計算 ──
    let unrealizedSpreadValue = 0;
    for (const sp of openSpreads) {
      const tte = daysToYears(daysBetween(today, sp.expirationDate));
      const currentValue = priceSpread(
        spotSpy,
        sp.shortStrike,
        sp.longStrike,
        tte,
        config.riskFreeRate,
        iv,
      );
      // ロック中の collateral - 現在の負債 (= 買い戻しコスト)
      // unrealized = collateral - currentValue × CONTRACT_SIZE × contracts
      unrealizedSpreadValue +=
        config.spreadWidth * CONTRACT_SIZE * sp.contracts -
        currentValue * CONTRACT_SIZE * sp.contracts;
    }
    const totalEquity = cash + unrealizedSpreadValue;
```

**変更後**:
```typescript
    // ── 3. equity curve 計算 ──
    const unrealizedSpreadValue = calcUnrealizedSpreadValue(
      openSpreads,
      spotSpy,
      iv,
      config.riskFreeRate,
      config.spreadWidth,
      today,
    );
    const totalEquity = cash + unrealizedSpreadValue;
```

### Step 3: 検証（リファクタ後の動作確認）

Run: `npm run typecheck`
Expected: エラーなし

Run: `npm test 2>&1 | tail -10`
Expected: 全 15 件 PASS（リファクタは挙動を変えない）

Run: `npm run backtest:credit-spread -- --start 2024-01-01 --end 2024-06-30 2>&1 | tail -15`
Expected: 既存と同じ結果（31 spreads / 96.77% win / +32.33% return など、ただしランダム性ない決定論的計算なので完全一致するはず）

### Step 4: コミット

```bash
git add src/backtest/us/us-credit-spread-simulation.ts
git commit -m "refactor(credit-spread): equity 計算をヘルパー関数に抽出

calcUnrealizedSpreadValue() を切り出し。次タスクで DD stop 判定にも
同関数を使うため、重複計算を避ける。

挙動変更なし（既存テスト 15/15 PASS、smoke run も同結果）。

Refs: KOH-450 (予定)"
```

---

## Task 4: simulation.ts に DD stop ロジックを追加

**Files:**
- Modify: `src/backtest/us/us-credit-spread-simulation.ts`

### Step 1: ステート変数追加（main loop の前、line 74 付近）

`let cash = config.initialBudget;` の直後（line 74 直後）に以下を挿入:

```typescript
  // DD hard stop ステート（Step #1）
  let runningPeak = config.initialBudget;
  let ddStopActive = false;
```

### Step 2: 新規エントリー判定の前に DD ステート更新を挿入

現在の `// ── 2. 新規エントリー判定 ──`（line 176 付近）の**直前**に以下を挿入:

```typescript
    // ── 1.5. DD hard stop 判定（新規エントリーの前）──
    const equityForDD = cash + calcUnrealizedSpreadValue(
      openSpreads,
      spotSpy,
      iv,
      config.riskFreeRate,
      config.spreadWidth,
      today,
    );
    if (equityForDD > runningPeak) runningPeak = equityForDD;
    if (config.ddStopEnabled) {
      const dd = (runningPeak - equityForDD) / runningPeak;
      if (!ddStopActive && dd > config.ddStopThreshold) {
        ddStopActive = true;
      } else if (ddStopActive && equityForDD / runningPeak >= config.ddStopReentryPct) {
        ddStopActive = false;
      }
    }
```

### Step 3: 新規エントリー判定の条件に `!ddStopActive` を追加

現在の `if (openSpreads.length < config.maxPositions) {`（line 177）を:

```typescript
    if (openSpreads.length < config.maxPositions && !ddStopActive) {
```

に変更。

### Step 4: 検証

Run: `npm run typecheck`
Expected: エラーなし

Run: `npm test 2>&1 | tail -10`
Expected: 全 15 件 PASS（既存テストはロジック変更を意識しない）

### Step 5: 直近期間で smoke run（DD stop が動くか軽く確認）

Run:
```bash
npm run backtest:credit-spread -- --start 2008-01-01 --end 2009-12-31 2>&1 | tail -20
```

Expected:
- リーマン期（2008-09 以降）の DD が以前より小さくなる、または同程度
- Total Spreads は減少傾向（DD stop で entry 停止される分）
- Net P&L は KOH-449 時の同期間より改善 or 悪化、いずれにせよ動作している

### Step 6: コミット

```bash
git add src/backtest/us/us-credit-spread-simulation.ts
git commit -m "feat(credit-spread): DD hard stop ロジックを追加（Step #1）

- runningPeak と ddStopActive をステート保持
- 新規エントリー判定前に equity を計算、DD > threshold で停止
- equity / peak >= reentryPct で再開（hysteresis）
- 既存スプレッドは満期まで保持（force-close しない）

ddStopEnabled=false で従来挙動に戻る（後方互換）。

Refs: KOH-450 (予定)"
```

---

## Task 5: run-credit-spread-tail-test.ts に --label オプション追加

**Files:**
- Modify: `src/backtest/tail-test/run-credit-spread-tail-test.ts`

### Step 1: --label 引数の取得とファイル名 suffix 反映

ファイル冒頭の `getArg` ヘルパー直後に以下を追加（既存の `startDate / endDate` パース処理の付近）:

```typescript
  const stepLabel = getArg("label");
  const suffix = stepLabel ? `-${stepLabel}` : "";
```

そして既存の以下の3箇所（`reportPath`, `equity-curve-XXX.csv`, `spreads-XXX.csv`）を:

**変更前**:
```typescript
  const reportPath = path.join(outDir, `credit-spread-tail-${today}.md`);
  // ...
  fs.writeFileSync(
    path.join(outDir, `equity-curve-${today}.csv`),
    // ...
  fs.writeFileSync(
    path.join(outDir, `spreads-${today}.csv`),
```

**変更後**:
```typescript
  const reportPath = path.join(outDir, `credit-spread-tail-${today}${suffix}.md`);
  // ...
  fs.writeFileSync(
    path.join(outDir, `equity-curve-${today}${suffix}.csv`),
    // ...
  fs.writeFileSync(
    path.join(outDir, `spreads-${today}${suffix}.csv`),
```

### Step 2: 検証

Run: `npm run typecheck`
Expected: エラーなし

Run（軽い動作確認）:
```bash
npm run tail-test:credit-spread -- --start 2024-01-01 --end 2024-06-30 --label test 2>&1 | tail -3
```

Expected:
- 完走
- `docs/reports/credit-spread-tail-YYYY-MM-DD-test.md` などが生成されている

確認:
```bash
ls docs/reports/ | grep test | head -3
```
Expected: 3 ファイル（md + 2 CSV）

確認後、テストファイルを削除:
```bash
rm docs/reports/*-test.md docs/reports/*-test.csv
```

### Step 3: コミット

```bash
git add src/backtest/tail-test/run-credit-spread-tail-test.ts
git commit -m "feat(tail-test): --label オプションを追加（レポート/CSV ファイル名 suffix）

ステップワイズ運用で複数の検証結果を区別するため。
--label step1 で credit-spread-tail-YYYY-MM-DD-step1.{md,csv} を生成。

Refs: KOH-450 (予定)"
```

---

## Task 6: 全期間 tail-test 実行（Step #1 検証）

**Files:** なし（実行のみ）

### Step 1: 全期間 tail-test 実行

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label step1 2>&1 | tail -20
```

Expected (ターミナル出力):
- 完走（エラーなし）
- 7 つの閾値判定が出力される
- 結果は `[PASS]` か `[FAIL]` で示される
- Report: `docs/reports/credit-spread-tail-YYYY-MM-DD-step1.md`

### Step 2: 結果の判定

ターミナル末尾の `verdict` を確認:
- `✅ PASS: 7/7 checks` なら → Step #1 で目標達成、Task 7 へ
- `❌ FAIL: X/7 checks` なら → Step #1 では不十分、Task 7 でレポート確認後、Step #2 を別途検討

特に注目すべき指標:
- Max DD: 54.43% → ?%
- CVaR 5%: -$415 → -$??
- CAGR: 10.53% → ?%（DD stop で機会損失して下がる可能性あり、≥ 10% 維持できるか）

### Step 3: レポート目視確認

```bash
head -50 docs/reports/credit-spread-tail-*-step1.md
```

確認ポイント:
- DD 上位 5 期間の最大 DD%
- 事前定義イベント（Lehman / COVID 等）での DD/PnL
- DD stop が機能しているなら、Lehman 期の DD が大幅に減少しているはず

### Step 4: 結果のコミット

PASS でも FAIL でも以下のように commit:

```bash
git add docs/reports/credit-spread-tail-*-step1.*
git commit -m "report: Credit Spread Step #1 (DD hard stop) 検証結果

期間: 2007-01-03 〜 2026-04-28
判定: <PASS|FAIL> (X/7 checks)

主要指標の変化:
- Max DD:  54.43% → XX.XX% (PASS|FAIL)
- CVaR 5%: -\$415 → -\$XXX (PASS|FAIL)
- CAGR:    10.53% → XX.XX%
- 総 spread 数: 786 → XXX

詳細: docs/reports/credit-spread-tail-YYYY-MM-DD-step1.md

Refs: KOH-450 (予定)"
```

実際の数字を埋めて commit。

---

## Task 7: Linear KOH-450 作成 + 結果反映

**Files:** なし（Linear 操作のみ）

### Step 1: Linear タスク作成

Linear MCP で `KOH-450` を以下の内容で作成:

- **Title:** `Credit Spread 戦略リファクタ + 再検証 - Step #1 DD hard stop`
- **Project:** Auto US Stock Trader
- **State:** Done（PASS の場合）/ In Progress（FAIL の場合、Step #2 へ続行）

**Description テンプレート（PASS 時）:**

```markdown
## 概要

KOH-449 の FAIL（Max DD 54%, CVaR 5% -$415）を受けて、
DD hard stop（peak から 15% 下落で停止、95% 戻りで再開）を追加。

## 変更

- `us-credit-spread-types.ts`: `ddStopEnabled / ddStopThreshold / ddStopReentryPct` 追加
- `us-credit-spread-config.ts`: defaults に `ddStopEnabled: true / 0.15 / 0.95`
- `us-credit-spread-simulation.ts`: equity 計算ヘルパー抽出 + DD ステート判定 + 新規エントリー条件追加
- `run-credit-spread-tail-test.ts`: `--label` オプション追加

## 検証結果（Step #1）

判定: ✅ **PASS (7/7 checks)**

| 指標 | KOH-449 | Step #1 | 改善幅 |
|---|---|---|---|
| Win Rate | 93.77% | XX.XX% | - |
| Profit Factor | 1.86 | X.XX | - |
| CAGR | 10.53% | XX.XX% | - |
| Max DD | **54.43%** | **XX.XX%** | -XX.XX pt |
| CVaR 5% | **-$415** | **-$XXX** | -$XXX |
| テール期間 DD | 29.12% | XX.XX% | - |
| テール期間 PnL% | -27% | -XX% | - |

## 実取引判断

**YES**。Step #1 のみで全閾値クリア → Step #2-#4 の実装は YAGNI で見送り。

## 次フェーズ

ロードマップ #4: IBKR / Webull API クライアント実装

## 参考

- 設計: `docs/plans/2026-04-30-credit-spread-tail-improvement-design.md`
- 実装プラン: `docs/plans/2026-04-30-credit-spread-step1-implementation-plan.md`
- レポート: `docs/reports/credit-spread-tail-YYYY-MM-DD-step1.md`
- KOH-447, KOH-448, KOH-449
```

**Description テンプレート（FAIL 時）:**

```markdown
## 概要

KOH-449 の FAIL を受けて Step #1（DD hard stop）を実装。
判定 ❌ **FAIL (X/7 checks)** のため Step #2（VIX cap 30→20）へ進む。

## 変更（Step #1）

[同上]

## 検証結果（Step #1）

| 指標 | KOH-449 | Step #1 | 判定 |
|---|---|---|---|
| ... | ... | ... | ... |

DD は **大幅改善 / 改善小** のためまだ閾値未達。

## 次フェーズ

Step #2: VIX cap 30→20 を Step #1 の上に積み上げ実装。
別 Linear タスク KOH-451 で進めるか、KOH-450 内で続行するかは要相談。
```

### Step 2: KOH-449 とリンク

KOH-450 description 内で `KOH-449` を mention し、KOH-449 のコメントにも「KOH-450 で改善版を実装、結果 ...」と追記する。

---

## 全 Task 完了基準

### PASS 時（理想）
- ✅ Task 1〜5 全て typecheck エラーなし
- ✅ 既存 15 件のユニットテスト全 PASS（リグレッション無し）
- ✅ Task 6 で `verdict.overallPass === true`
- ✅ Max DD ≤ 25%、CVaR 5% ≥ -$250、CAGR ≥ 10% 維持
- ✅ KOH-450 が Done

### FAIL 時（次フェーズへ）
- ✅ Task 1〜5 全て完了、コミット済
- ✅ Task 6 で結果レポート出力済（PASS/FAIL 関係なく）
- ✅ KOH-450 が In Progress、結果コメント追加済
- → 別途 Step #2 のミニ実装プラン作成 or KOH-450 内で続行

---

## DRY / YAGNI 原則の確認

- DD stop ロジックは Credit Spread 専用（他戦略への汎用化は YAGNI、必要時に refactor）
- Step #1 のユニットテストは省略（tail-test 実行で動作検証）
- 閾値振り感度分析（10%, 15%, 20% 比較）は YAGNI、本タスクでは設計書通り 0.15 のみ

## 次フェーズ（Step #1 で FAIL の場合のみ）

設計書 `2026-04-30-credit-spread-tail-improvement-design.md` の Step #2-#4 を参照。

- **Step #2**: `vixCap: 30 → 20` (config.ts 1 行変更)
- **Step #3**: `indexTrendSmaPeriod: 50 → 20` (config.ts 1 行変更)
- **Step #4**: `vixHighRegimeContractMultiplier: 0.5` 追加 + simulation.ts の `tryOpenSpread` 修正

各 Step は 30 分〜1 時間で実装可能。実行時に都度ユーザーと相談。

## 参考

- 設計書: `docs/plans/2026-04-30-credit-spread-tail-improvement-design.md`
- KOH-449 結果: `docs/reports/credit-spread-tail-2026-04-30.md`
- 関連 Linear: KOH-447, KOH-448, KOH-449
