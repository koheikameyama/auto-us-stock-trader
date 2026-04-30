# Paper Trading Phase A: 信号ロジック抽出 実装プラン

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `us-credit-spread-simulation.ts` から信号ロジックを 3 つの純関数（`signal-generator`, `spread-evaluator`, `dd-stop`）に抽出し、backtest と paper trading で共有可能にする。挙動は完全に同等を維持（step3b の数値と完全一致）。

**Architecture:** TDD で 3 つの純関数をファイル単位に切り出してから、`simulation.ts` をそれらを呼ぶ薄いラッパー化。各関数は context オブジェクトを受け取り、新しい状態 or アクションを返す。実装中・実装後とも `npm run tail-test:credit-spread` を全期間で走らせ、step3b の数値と完全一致を確認。

**Tech Stack:** TypeScript 6, vitest, dayjs, tsx

**前提:**
- KOH-451 完了 — backtest 6/7 PASS（`stopLossMultiplier: 2.0`, `ddStopThreshold: 0.15`, `ddStopCooldownDays: 252`）
- 設計書: `docs/plans/2026-04-30-paper-trading-design.md` (Phase A セクション)
- 既存テスト 25 件全 PASS（5 test files: dd-extractor, window-analyzer, tail-metrics, pass-fail, report）

---

## ロールバック方法

```bash
cd /Users/kouheikameyama/development/auto-us-stock-trader
git status

# 全変更を破棄して開始前に戻す
git restore --staged .
git checkout -- src/backtest/us/us-credit-spread-simulation.ts
rm -rf src/backtest/credit-spread/

# 既コミット済みの場合
git log --oneline | head -10
git revert <SHA range>
```

`auto-stock-trader` リポは触らない（読み取りもしない、本タスクは self-contained）。

---

## Task 0: ベースライン確立（step3b 数値を保存）

**Files:** なし（実行のみ + 一時ファイル）

リファクタ後の数値同等性を担保するため、現状（step3b 設定）の backtest 出力を「正解」として記録する。

### Step 1: 現状の config を確認

Run:
```bash
grep -E "stopLossMultiplier|ddStopThreshold|ddStopCooldownDays|ddStopEnabled" src/backtest/us/us-credit-spread-config.ts
```
Expected: 以下が表示される（KOH-451 の最終状態）
```
  stopLossMultiplier: 2.0,
  ddStopEnabled: true,
  ddStopThreshold: 0.15,
  ddStopCooldownDays: 252,
```

### Step 2: ベースライン backtest 実行

Run:
```bash
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label phaseA-baseline 2>&1 | tail -15
```

Expected出力（step3b と一致するはず）:
```
Total spreads: 821
  Win Rate                           0.8733 (...) [PASS]
  Profit Factor                        1.78 (...) [PASS]
  CAGR                           0.0882... (...) [FAIL]
  Max DD                             0.2161 (...) [PASS]
  CVaR 5%                        -216.17... (...) [PASS]
```

実数値を以下のメモとして記録（次タスクで比較に使う）:
- Total spreads: **821**
- Win Rate: **0.8733**
- Profit Factor: **1.78**
- CAGR: **0.08826...** (8.83%)
- Max DD: **0.2161** (21.61%)
- CVaR 5%: **-216.17...**

### Step 3: 一時ファイル削除（コミット不要）

```bash
rm docs/reports/credit-spread-tail-*-phaseA-baseline.*
```

### Step 4: コミットなし（次タスクで一緒に管理）

---

## Task 1: dd-stop.ts (TDD、最小スコープ)

**Files:**
- Create: `src/backtest/credit-spread/dd-stop.ts`
- Create: `src/backtest/credit-spread/__tests__/dd-stop.test.ts`

DD stop の状態遷移を純関数化。最も小さい関数なので最初に切り出す。

### Step 1: failing テストを書く

```typescript
// src/backtest/credit-spread/__tests__/dd-stop.test.ts
import { describe, it, expect } from "vitest";
import { calcDDStopState } from "../dd-stop";
import type { USCreditSpreadBacktestConfig } from "../../us/us-credit-spread-types";

const baseConfig: Pick<USCreditSpreadBacktestConfig, "ddStopEnabled" | "ddStopThreshold" | "ddStopCooldownDays"> = {
  ddStopEnabled: true,
  ddStopThreshold: 0.15,
  ddStopCooldownDays: 252,
};

describe("calcDDStopState", () => {
  it("does nothing when ddStopEnabled=false", () => {
    const result = calcDDStopState({
      today: "2024-01-15",
      totalEquity: 800,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: { ...baseConfig, ddStopEnabled: false },
    });
    expect(result.ddStopActive).toBe(false);
    expect(result.transition).toBe("UNCHANGED");
    expect(result.runningPeak).toBe(1000); // 入力 peak のまま（更新なし）
  });

  it("activates when DD exceeds threshold", () => {
    // peak 1000, equity 840 → DD = 16% > 15% threshold → activate
    const result = calcDDStopState({
      today: "2024-01-15",
      totalEquity: 840,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(true);
    expect(result.ddStopActivatedDate).toBe("2024-01-15");
    expect(result.transition).toBe("ACTIVATED");
  });

  it("does not activate when DD is exactly at threshold", () => {
    // peak 1000, equity 850 → DD = 15.0% = threshold (not >) → no activation
    const result = calcDDStopState({
      today: "2024-01-15",
      totalEquity: 850,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(false);
    expect(result.transition).toBe("UNCHANGED");
  });

  it("updates runningPeak when totalEquity exceeds it", () => {
    const result = calcDDStopState({
      today: "2024-02-01",
      totalEquity: 1100,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: baseConfig,
    });
    expect(result.runningPeak).toBe(1100);
  });

  it("stays active during cooldown period", () => {
    // activated on 2024-01-15, today is 2024-06-01 (~138 days), threshold 252 → still active
    const result = calcDDStopState({
      today: "2024-06-01",
      totalEquity: 850,
      prevState: { runningPeak: 1000, ddStopActive: true, ddStopActivatedDate: "2024-01-15" },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(true);
    expect(result.transition).toBe("UNCHANGED");
  });

  it("deactivates after cooldown elapses + resets peak to current equity", () => {
    // activated on 2024-01-15, today is 2024-09-23 (252+ days later) → deactivate
    const result = calcDDStopState({
      today: "2024-09-23",
      totalEquity: 850,
      prevState: { runningPeak: 1000, ddStopActive: true, ddStopActivatedDate: "2024-01-15" },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(false);
    expect(result.ddStopActivatedDate).toBeNull();
    expect(result.runningPeak).toBe(850); // peak がリセットされる
    expect(result.transition).toBe("DEACTIVATED");
  });
});
```

### Step 2: テスト失敗を確認

Run: `npm test -- src/backtest/credit-spread/__tests__/dd-stop.test.ts 2>&1 | tail -10`
Expected: FAIL（モジュール未実装）

### Step 3: 実装

```typescript
// src/backtest/credit-spread/dd-stop.ts
import type { USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";

export interface DDStopPrevState {
  runningPeak: number;
  ddStopActive: boolean;
  ddStopActivatedDate: string | null;
}

export interface DDStopContext {
  today: string;
  totalEquity: number;
  prevState: DDStopPrevState;
  config: Pick<USCreditSpreadBacktestConfig, "ddStopEnabled" | "ddStopThreshold" | "ddStopCooldownDays">;
}

export interface DDStopState {
  runningPeak: number;
  ddStopActive: boolean;
  ddStopActivatedDate: string | null;
  transition: "ACTIVATED" | "DEACTIVATED" | "UNCHANGED";
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function calcDDStopState(ctx: DDStopContext): DDStopState {
  const { today, totalEquity, prevState, config } = ctx;

  // peak 更新（常に行う、ddStopEnabled に関係なく）
  let runningPeak = prevState.runningPeak;
  if (totalEquity > runningPeak) runningPeak = totalEquity;

  // ddStopEnabled = false なら何もせず透過
  if (!config.ddStopEnabled) {
    return {
      runningPeak,
      ddStopActive: prevState.ddStopActive,
      ddStopActivatedDate: prevState.ddStopActivatedDate,
      transition: "UNCHANGED",
    };
  }

  // 状態遷移
  if (!prevState.ddStopActive) {
    // OFF → ON 判定
    const dd = (runningPeak - totalEquity) / runningPeak;
    if (dd > config.ddStopThreshold) {
      return {
        runningPeak,
        ddStopActive: true,
        ddStopActivatedDate: today,
        transition: "ACTIVATED",
      };
    }
    return {
      runningPeak,
      ddStopActive: false,
      ddStopActivatedDate: null,
      transition: "UNCHANGED",
    };
  } else {
    // ON → OFF 判定（cooldown 経過チェック）
    if (prevState.ddStopActivatedDate != null) {
      const daysSinceStop = daysBetween(prevState.ddStopActivatedDate, today);
      if (daysSinceStop >= config.ddStopCooldownDays) {
        return {
          runningPeak: totalEquity, // 新基準にリセット
          ddStopActive: false,
          ddStopActivatedDate: null,
          transition: "DEACTIVATED",
        };
      }
    }
    return {
      runningPeak,
      ddStopActive: true,
      ddStopActivatedDate: prevState.ddStopActivatedDate,
      transition: "UNCHANGED",
    };
  }
}
```

### Step 4: テスト成功を確認

Run: `npm test -- src/backtest/credit-spread/__tests__/dd-stop.test.ts 2>&1 | tail -10`
Expected: 6 passed

### Step 5: 全テスト実行（リグレッション確認）

Run: `npm test 2>&1 | tail -5`
Expected: 全 31 件 PASS（既存 25 + 新規 6）

### Step 6: コミット

```bash
git add src/backtest/credit-spread/dd-stop.ts src/backtest/credit-spread/__tests__/dd-stop.test.ts
git commit -m "feat(credit-spread): calcDDStopState を純関数として TDD 抽出

simulation.ts から DD stop の状態遷移ロジックを切り出し。
今後 paper trading でも同関数を呼んで挙動を完全共有する。

simulation.ts のリファクタは Task 4 で行う（本コミットでは未変更）。

Refs: KOH-452-A (予定)"
```

---

## Task 2: spread-evaluator.ts (TDD)

**Files:**
- Create: `src/backtest/credit-spread/spread-evaluator.ts`
- Create: `src/backtest/credit-spread/__tests__/spread-evaluator.test.ts`

既存スプレッドの「HOLD / CLOSE / EXPIRE」判定を純関数化。

### Step 1: failing テスト

```typescript
// src/backtest/credit-spread/__tests__/spread-evaluator.test.ts
import { describe, it, expect } from "vitest";
import { evaluateSpread } from "../spread-evaluator";
import type { SimulatedSpread } from "../../us/us-credit-spread-types";
import type { USCreditSpreadBacktestConfig } from "../../us/us-credit-spread-types";

const baseConfig: Pick<USCreditSpreadBacktestConfig, "spreadWidth" | "profitTarget" | "stopLossMultiplier" | "riskFreeRate" | "ivScaleFactor"> = {
  spreadWidth: 5,
  profitTarget: 0.5,
  stopLossMultiplier: 2.0,
  riskFreeRate: 0.045,
  ivScaleFactor: 1.0,
};

function spread(p: Partial<SimulatedSpread>): SimulatedSpread {
  return {
    underlyingSymbol: "SPY",
    entryDate: "2024-01-01",
    expirationDate: "2024-02-01",
    entrySpotPrice: 470,
    entryIV: 0.15,
    shortStrike: 450,
    longStrike: 445,
    shortDeltaAtEntry: -0.2,
    creditReceived: 0.85,
    contracts: 1,
    state: "OPEN",
    totalCommissions: 1.3,
    ...p,
  };
}

describe("evaluateSpread", () => {
  it("returns EXPIRE/expired_worthless when spotSpy is far above shortStrike at expiry", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01" });
    const result = evaluateSpread(sp, {
      today: "2024-02-01",
      spotSpy: 480,
      vix: 15,
      config: baseConfig,
    });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_worthless");
      expect(result.finalValue).toBe(0);
    }
  });

  it("returns EXPIRE/expired_max_loss when spotSpy is far below longStrike at expiry", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01" });
    const result = evaluateSpread(sp, {
      today: "2024-02-01",
      spotSpy: 400,
      vix: 30,
      config: baseConfig,
    });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_max_loss");
      expect(result.finalValue).toBe(5); // spreadWidth full
    }
  });

  it("returns EXPIRE/expired_partial when spotSpy is between strikes at expiry", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01" });
    const result = evaluateSpread(sp, {
      today: "2024-02-01",
      spotSpy: 447,
      vix: 20,
      config: baseConfig,
    });
    expect(result.action).toBe("EXPIRE");
    if (result.action === "EXPIRE") {
      expect(result.reason).toBe("expired_partial");
      expect(result.finalValue).toBeCloseTo(3, 1); // 450 - 447 = 3
    }
  });

  it("returns CLOSE/profit_target when currentValue is below profitTargetPrice", () => {
    // credit 0.85, profitTarget 0.5 → profitTargetPrice = 0.85 * 0.5 = 0.425
    // 大きな OTM スプレッド + 低 IV で十分時間経過 → spread 価値が小さい
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01", creditReceived: 0.85 });
    const result = evaluateSpread(sp, {
      today: "2024-01-25",  // 7 日残
      spotSpy: 470,         // OTM 大
      vix: 12,              // 低 IV
      config: baseConfig,
    });
    expect(result.action).toBe("CLOSE");
    if (result.action === "CLOSE") {
      expect(result.reason).toBe("profit_target");
    }
  });

  it("returns HOLD when not at expiry and not at PT/SL", () => {
    const sp = spread({ shortStrike: 450, longStrike: 445, expirationDate: "2024-02-01", creditReceived: 0.85 });
    const result = evaluateSpread(sp, {
      today: "2024-01-15",  // ~17 日残
      spotSpy: 458,         // ATM 近め
      vix: 18,
      config: baseConfig,
    });
    expect(result.action).toBe("HOLD");
  });
});
```

### Step 2: テスト失敗確認

Run: `npm test -- spread-evaluator 2>&1 | tail -10`
Expected: FAIL（未実装）

### Step 3: 実装

```typescript
// src/backtest/credit-spread/spread-evaluator.ts
import { bsPutPrice } from "../../lib/options-pricing";
import type { SimulatedSpread, USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";

export interface SpreadEvalContext {
  today: string;
  spotSpy: number;
  vix: number;
  config: Pick<USCreditSpreadBacktestConfig, "spreadWidth" | "profitTarget" | "stopLossMultiplier" | "riskFreeRate" | "ivScaleFactor">;
}

export type SpreadAction =
  | { action: "HOLD"; currentValue: number }
  | { action: "CLOSE"; reason: "profit_target" | "stop_loss"; currentValue: number }
  | { action: "EXPIRE"; reason: "expired_worthless" | "expired_max_loss" | "expired_partial"; finalValue: number };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function priceSpreadInternal(
  spotSpy: number,
  shortStrike: number,
  longStrike: number,
  tte: number,
  riskFreeRate: number,
  iv: number,
): number {
  const shortPx = bsPutPrice(spotSpy, shortStrike, tte, riskFreeRate, iv);
  const longPx = bsPutPrice(spotSpy, longStrike, tte, riskFreeRate, iv);
  return Math.max(shortPx - longPx, 0);
}

export function evaluateSpread(spread: SimulatedSpread, ctx: SpreadEvalContext): SpreadAction {
  const { today, spotSpy, vix, config } = ctx;
  const iv = (vix / 100) * config.ivScaleFactor;

  // 満期判定
  if (today >= spread.expirationDate) {
    const shortIntrinsic = Math.max(spread.shortStrike - spotSpy, 0);
    const longIntrinsic = Math.max(spread.longStrike - spotSpy, 0);
    const finalSpreadValue = Math.max(shortIntrinsic - longIntrinsic, 0);

    let reason: "expired_worthless" | "expired_max_loss" | "expired_partial";
    if (finalSpreadValue < 0.01) reason = "expired_worthless";
    else if (finalSpreadValue >= config.spreadWidth - 0.01) reason = "expired_max_loss";
    else reason = "expired_partial";

    return { action: "EXPIRE", reason, finalValue: finalSpreadValue };
  }

  // 通常日
  const tte = Math.max(daysBetween(today, spread.expirationDate) / 365, 0);
  const currentSpreadPrice = priceSpreadInternal(
    spotSpy,
    spread.shortStrike,
    spread.longStrike,
    tte,
    config.riskFreeRate,
    iv,
  );

  const profitTargetPrice = spread.creditReceived * (1 - config.profitTarget);
  const stopLossPrice = config.stopLossMultiplier > 0
    ? spread.creditReceived * (1 + config.stopLossMultiplier)
    : Number.POSITIVE_INFINITY;

  if (currentSpreadPrice <= profitTargetPrice) {
    return { action: "CLOSE", reason: "profit_target", currentValue: currentSpreadPrice };
  } else if (currentSpreadPrice >= stopLossPrice) {
    return { action: "CLOSE", reason: "stop_loss", currentValue: currentSpreadPrice };
  } else {
    return { action: "HOLD", currentValue: currentSpreadPrice };
  }
}
```

### Step 4: テスト成功確認

Run: `npm test -- spread-evaluator 2>&1 | tail -10`
Expected: 5 passed

### Step 5: 全テスト実行

Run: `npm test 2>&1 | tail -5`
Expected: 全 36 件 PASS（既存 31 + 新規 5）

### Step 6: コミット

```bash
git add src/backtest/credit-spread/spread-evaluator.ts src/backtest/credit-spread/__tests__/spread-evaluator.test.ts
git commit -m "feat(credit-spread): evaluateSpread を純関数として TDD 抽出

既存スプレッドの HOLD / CLOSE / EXPIRE 判定を切り出し。
満期 (expired_worthless / max_loss / partial) と
通常日 (profit_target / stop_loss / HOLD) を網羅。

simulation.ts のリファクタは Task 4 で行う。

Refs: KOH-452-A (予定)"
```

---

## Task 3: signal-generator.ts (TDD)

**Files:**
- Create: `src/backtest/credit-spread/signal-generator.ts`
- Create: `src/backtest/credit-spread/__tests__/signal-generator.test.ts`

新規エントリー判定を純関数化。skip reason を返すことで paper trading のログに「なぜ entry しなかったか」を残せる。

### Step 1: failing テスト

```typescript
// src/backtest/credit-spread/__tests__/signal-generator.test.ts
import { describe, it, expect } from "vitest";
import { generateEntrySignal } from "../signal-generator";
import { US_CREDIT_SPREAD_DEFAULTS } from "../../us/us-credit-spread-config";
import type { USCreditSpreadBacktestConfig } from "../../us/us-credit-spread-types";

const fullConfig: USCreditSpreadBacktestConfig = {
  ...US_CREDIT_SPREAD_DEFAULTS,
  startDate: "2024-01-01",
  endDate: "2024-12-31",
};

const baseTradingDays = ["2024-01-15", "2024-01-22", "2024-01-29", "2024-02-05", "2024-02-12", "2024-02-19", "2024-02-26"];

describe("generateEntrySignal", () => {
  it("returns SKIP_MAX_POSITIONS when at max", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 2,  // == maxPositions (2)
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_MAX_POSITIONS");
  });

  it("returns SKIP_DD_STOP when ddStopActive=true", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: true,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_DD_STOP");
  });

  it("returns SKIP_VIX_CAP when vix > vixCap", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 35,  // > vixCap 30
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_VIX_CAP");
  });

  it("returns SKIP_TREND_FILTER when gspc < smaGspc", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4400,         // < smaGspc 4500
      spotSpy: 440,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_TREND_FILTER");
  });

  it("returns SKIP_INSUFFICIENT_CASH when cash is too low", () => {
    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 100,  // not enough for $5 spread × 100 × 1 = $500
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays: baseTradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("SKIP_INSUFFICIENT_CASH");
  });

  it("returns ENTERED with strikes when conditions are met", () => {
    // Generous trading days for findExpirationDate (DTE=35 → ~5 weeks ahead)
    const tradingDays: string[] = [];
    for (let i = 0; i < 100; i++) {
      const d = new Date("2024-01-15");
      d.setDate(d.getDate() + i);
      tradingDays.push(d.toISOString().slice(0, 10));
    }

    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4700,
      spotSpy: 470,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays,
      config: fullConfig,
    });
    expect(result.reason).toBe("ENTERED");
    if (result.reason === "ENTERED") {
      expect(result.shortStrike).toBeGreaterThan(440);
      expect(result.shortStrike).toBeLessThan(470);
      expect(result.longStrike).toBe(result.shortStrike - 5);
      expect(result.estimatedCredit).toBeGreaterThan(0.05);
    }
  });

  it("respects indexTrendFilter=false (no SMA check)", () => {
    const tradingDays: string[] = [];
    for (let i = 0; i < 100; i++) {
      const d = new Date("2024-01-15");
      d.setDate(d.getDate() + i);
      tradingDays.push(d.toISOString().slice(0, 10));
    }

    const result = generateEntrySignal({
      today: "2024-01-15",
      gspc: 4400,         // < smaGspc 4500（普通なら SKIP_TREND_FILTER）
      spotSpy: 440,
      vix: 15,
      smaGspc: 4500,
      cash: 10000,
      openPositionCount: 0,
      ddStopActive: false,
      tradingDays,
      config: { ...fullConfig, indexTrendFilter: false },  // フィルタ無効
    });
    expect(result.reason).toBe("ENTERED");
  });
});
```

### Step 2: テスト失敗確認

Run: `npm test -- signal-generator 2>&1 | tail -10`
Expected: FAIL

### Step 3: 実装

```typescript
// src/backtest/credit-spread/signal-generator.ts
import dayjs from "dayjs";
import { bsPutPrice, findStrikeForTargetDelta } from "../../lib/options-pricing";
import type { USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";

const CONTRACT_SIZE = 100;

export interface EntryContext {
  today: string;
  gspc: number;             // 生 ^GSPC（SMA との比較用）
  spotSpy: number;          // gspc / 10（オプション pricing 用）
  vix: number;
  smaGspc: number | null;   // SMA of GSPC（lookback 計算済み）
  cash: number;
  openPositionCount: number;
  ddStopActive: boolean;
  tradingDays: string[];    // findExpirationDate 用
  config: USCreditSpreadBacktestConfig;
}

export type EntryResult =
  | {
      reason: "ENTERED";
      shortStrike: number;
      longStrike: number;
      expirationDate: string;
      estimatedCredit: number;
      shortDelta: number;
    }
  | {
      reason:
        | "SKIP_MAX_POSITIONS"
        | "SKIP_DD_STOP"
        | "SKIP_VIX_CAP"
        | "SKIP_TREND_FILTER"
        | "SKIP_INSUFFICIENT_CASH"
        | "SKIP_LOW_CREDIT"
        | "SKIP_INVALID_STRIKE";
    };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function findExpirationDate(entryDate: string, dte: number, tradingDays: string[]): string {
  const target = dayjs(entryDate).add(dte, "day").format("YYYY-MM-DD");
  for (const d of tradingDays) {
    if (d >= target) return d;
  }
  return tradingDays[tradingDays.length - 1];
}

export function generateEntrySignal(ctx: EntryContext): EntryResult {
  const { today, gspc, spotSpy, vix, smaGspc, cash, openPositionCount, ddStopActive, tradingDays, config } = ctx;

  // 1. position 数チェック
  if (openPositionCount >= config.maxPositions) return { reason: "SKIP_MAX_POSITIONS" };
  // 2. DD stop チェック
  if (ddStopActive) return { reason: "SKIP_DD_STOP" };
  // 3. VIX cap
  if (vix > config.vixCap) return { reason: "SKIP_VIX_CAP" };
  // 4. SMA トレンドフィルタ
  if (config.indexTrendFilter) {
    if (smaGspc == null || gspc < smaGspc) return { reason: "SKIP_TREND_FILTER" };
  }

  // 5. 満期日決定
  const expirationDate = findExpirationDate(today, config.dte, tradingDays);
  const tte = Math.max(daysBetween(today, expirationDate) / 365, 0);
  if (tte <= 0) return { reason: "SKIP_INVALID_STRIKE" };

  // 6. ショート put strike を delta で決定
  const iv = (vix / 100) * config.ivScaleFactor;
  const shortInfo = findStrikeForTargetDelta({
    spotPrice: spotSpy,
    targetDelta: -Math.abs(config.shortPutDelta),
    tte,
    riskFreeRate: config.riskFreeRate,
    iv,
    optionType: "put",
    strikeStep: 1,
  });
  const shortStrike = shortInfo.strike;
  const longStrike = shortStrike - config.spreadWidth;
  if (longStrike <= 0) return { reason: "SKIP_INVALID_STRIKE" };

  // 7. credit 計算
  const shortPremium = shortInfo.premium;
  const longPremium = bsPutPrice(spotSpy, longStrike, tte, config.riskFreeRate, iv);
  const credit = shortPremium - longPremium;
  if (credit <= 0.05) return { reason: "SKIP_LOW_CREDIT" };

  // 8. cash チェック
  const collateralRequired = config.spreadWidth * CONTRACT_SIZE * config.contractsPerSpread;
  if (cash < collateralRequired + 50) return { reason: "SKIP_INSUFFICIENT_CASH" };

  return {
    reason: "ENTERED",
    shortStrike,
    longStrike,
    expirationDate,
    estimatedCredit: credit,
    shortDelta: shortInfo.delta,
  };
}
```

### Step 4: テスト成功確認

Run: `npm test -- signal-generator 2>&1 | tail -10`
Expected: 7 passed

### Step 5: 全テスト実行

Run: `npm test 2>&1 | tail -5`
Expected: 全 43 件 PASS（既存 36 + 新規 7）

### Step 6: コミット

```bash
git add src/backtest/credit-spread/signal-generator.ts src/backtest/credit-spread/__tests__/signal-generator.test.ts
git commit -m "feat(credit-spread): generateEntrySignal を純関数として TDD 抽出

新規エントリー判定を切り出し、SKIP の理由を返すように設計。
paper trading のログに 'なぜ entry しなかったか' を残せる。

skip reason の種類:
- SKIP_MAX_POSITIONS / SKIP_DD_STOP
- SKIP_VIX_CAP / SKIP_TREND_FILTER
- SKIP_INSUFFICIENT_CASH / SKIP_LOW_CREDIT / SKIP_INVALID_STRIKE

simulation.ts のリファクタは Task 4 で行う。

Refs: KOH-452-A (予定)"
```

---

## Task 4: simulation.ts のリファクタ（純関数を呼ぶラッパー化）

**Files:**
- Modify: `src/backtest/us/us-credit-spread-simulation.ts`

3 つの純関数を呼ぶ薄いラッパーに書き換える。**挙動を完全同等に保つ**こと（数値が 1 円ずれても NG）。

### Step 1: 既存 simulation.ts を全文 Read

Run: `wc -l src/backtest/us/us-credit-spread-simulation.ts`
Expected: 約 360 行

ファイルを精読し、以下のリファクタ計画を確認:

**置き換え対象**:
1. day-loop 内の「既存スプレッド評価・クローズ」ブロック（line 109-194）→ `evaluateSpread()` を呼ぶ
2. day-loop 内の「DD stop 判定」ブロック（line 198-221）→ `calcDDStopState()` を呼ぶ
3. day-loop 内の「新規エントリー判定 + tryOpenSpread」ブロック（line 223-278）→ `generateEntrySignal()` を呼ぶ

**残すロジック**:
- ヘルパー関数（`daysToYears`, `daysBetween`, `priceSpread`, `findExpirationDate`, `calcUnrealizedSpreadValue`）
- cash の更新（spread close / open 時）
- spreads 配列の管理（push to closedSpreads / openSpreads）
- equity curve の push
- メトリクス計算

### Step 2: simulation.ts のリファクタ実装

`runUSCreditSpreadBacktest()` 関数の day-loop を以下に書き換える:

```typescript
// import を追加
import { calcDDStopState, type DDStopPrevState } from "../credit-spread/dd-stop";
import { evaluateSpread } from "../credit-spread/spread-evaluator";
import { generateEntrySignal } from "../credit-spread/signal-generator";

// ... 既存のヘルパー（calcUnrealizedSpreadValue 等）はそのまま ...

export async function runUSCreditSpreadBacktest(
  config: USCreditSpreadBacktestConfig,
  gspcData: Map<string, number>,
  vixData: Map<string, number>,
): Promise<USCreditSpreadBacktestResult> {
  const tradingDays = [...gspcData.keys()]
    .filter((d) => d >= config.startDate && d <= config.endDate)
    .sort();

  // SMA キャッシュ（既存通り）
  const allGspcDays = [...gspcData.keys()].sort();
  const gspcSmaCache = new Map<string, number>();
  if (config.indexTrendFilter) {
    for (let i = config.indexTrendSmaPeriod - 1; i < allGspcDays.length; i++) {
      let sum = 0;
      for (let j = 0; j < config.indexTrendSmaPeriod; j++) {
        sum += gspcData.get(allGspcDays[i - j])!;
      }
      gspcSmaCache.set(allGspcDays[i], sum / config.indexTrendSmaPeriod);
    }
  }

  let cash = config.initialBudget;
  let ddState: DDStopPrevState = {
    runningPeak: config.initialBudget,
    ddStopActive: false,
    ddStopActivatedDate: null,
  };
  const openSpreads: SimulatedSpread[] = [];
  const closedSpreads: SimulatedSpread[] = [];
  const equityCurve: DailyEquity[] = [];

  for (const today of tradingDays) {
    const gspc = gspcData.get(today);
    const vix = vixData.get(today);
    if (gspc == null || vix == null) continue;

    const spotSpy = gspc / 10;
    const iv = (vix / 100) * config.ivScaleFactor;

    // ── 1. 既存スプレッドを evaluateSpread で評価・クローズ ──
    const stillOpen: SimulatedSpread[] = [];
    for (const sp of openSpreads) {
      const result = evaluateSpread(sp, { today, spotSpy, vix, config });

      if (result.action === "EXPIRE") {
        // 満期処理
        const finalSpreadValue = result.finalValue;
        const exitCommission = config.optionsCommission * 2 * sp.contracts;
        const isWorthless = result.reason === "expired_worthless";
        const commissionsThisLeg = isWorthless ? 0 : exitCommission;
        const pnl = (sp.creditReceived - finalSpreadValue) * CONTRACT_SIZE * sp.contracts - commissionsThisLeg;

        cash += config.spreadWidth * CONTRACT_SIZE * sp.contracts;
        cash -= finalSpreadValue * CONTRACT_SIZE * sp.contracts;
        cash -= commissionsThisLeg;

        sp.state = "CLOSED";
        sp.closeDate = today;
        sp.closeSpreadPrice = finalSpreadValue;
        sp.totalCommissions += commissionsThisLeg;
        sp.netPnl = pnl;
        sp.closeReason = result.reason;
        closedSpreads.push(sp);
      } else if (result.action === "CLOSE") {
        // 利確 / SL クローズ
        const currentSpreadPrice = result.currentValue;
        const exitCommission = config.optionsCommission * 2 * sp.contracts;
        const pnl = (sp.creditReceived - currentSpreadPrice) * CONTRACT_SIZE * sp.contracts - exitCommission;

        cash += config.spreadWidth * CONTRACT_SIZE * sp.contracts;
        cash -= currentSpreadPrice * CONTRACT_SIZE * sp.contracts;
        cash -= exitCommission;

        sp.state = "CLOSED";
        sp.closeDate = today;
        sp.closeReason = result.reason;
        sp.closeSpreadPrice = currentSpreadPrice;
        sp.totalCommissions += exitCommission;
        sp.netPnl = pnl;
        closedSpreads.push(sp);
      } else {
        // HOLD
        stillOpen.push(sp);
      }
    }
    openSpreads.length = 0;
    openSpreads.push(...stillOpen);

    // ── 1.5. DD hard stop 状態遷移 ──
    const equityForDD = cash + calcUnrealizedSpreadValue(
      openSpreads,
      spotSpy,
      iv,
      config.riskFreeRate,
      config.spreadWidth,
      today,
    );
    const newDDState = calcDDStopState({
      today,
      totalEquity: equityForDD,
      prevState: ddState,
      config,
    });
    ddState = {
      runningPeak: newDDState.runningPeak,
      ddStopActive: newDDState.ddStopActive,
      ddStopActivatedDate: newDDState.ddStopActivatedDate,
    };

    // ── 2. 新規エントリー判定 ──
    const signal = generateEntrySignal({
      today,
      gspc,
      spotSpy,
      vix,
      smaGspc: gspcSmaCache.get(today) ?? null,
      cash,
      openPositionCount: openSpreads.length,
      ddStopActive: ddState.ddStopActive,
      tradingDays,
      config,
    });

    if (signal.reason === "ENTERED") {
      const collateralRequired = config.spreadWidth * CONTRACT_SIZE * config.contractsPerSpread;
      const entryCommission = config.optionsCommission * 2 * config.contractsPerSpread;
      cash -= collateralRequired;
      cash += signal.estimatedCredit * CONTRACT_SIZE * config.contractsPerSpread;
      cash -= entryCommission;

      const newSpread: SimulatedSpread = {
        underlyingSymbol: config.underlyingSymbol,
        entryDate: today,
        expirationDate: signal.expirationDate,
        entrySpotPrice: spotSpy,
        entryIV: iv,
        shortStrike: signal.shortStrike,
        longStrike: signal.longStrike,
        shortDeltaAtEntry: signal.shortDelta,
        creditReceived: signal.estimatedCredit,
        contracts: config.contractsPerSpread,
        state: "OPEN",
        totalCommissions: entryCommission,
      };
      openSpreads.push(newSpread);
    }

    // ── 3. equity curve ──
    const unrealizedSpreadValue = calcUnrealizedSpreadValue(
      openSpreads,
      spotSpy,
      iv,
      config.riskFreeRate,
      config.spreadWidth,
      today,
    );
    const totalEquity = cash + unrealizedSpreadValue;
    equityCurve.push({
      date: today,
      cash,
      positionsValue: unrealizedSpreadValue,
      totalEquity,
      openPositionCount: openSpreads.length,
    });
  }

  // ── 4. メトリクス計算（既存通り、変更なし）──
  // ... (前のコードをそのまま残す: const allSpreads = ..., mapExitReason, tradeShape, baseMetrics, metrics) ...

  return { config, spreads: allSpreads, equityCurve, metrics };
}
```

### Step 3: typecheck

Run: `npm run typecheck 2>&1 | tail -5`
Expected: エラーなし

### Step 4: 全テスト実行

Run: `npm test 2>&1 | tail -5`
Expected: 全 43 件 PASS（既存テストも全部 PASS、リグレッション無し）

### Step 5: 短期 smoke run（数値確認）

Run:
```bash
npm run backtest:credit-spread -- --start 2024-01-01 --end 2024-06-30 2>&1 | tail -15
```

Expected（リファクタ前と完全一致するはず、KOH-451 時の数値）:
```
Total Spreads: <X>
Win Rate: 87.33% （または近い値）
Net P&L: <Y>
Max Drawdown: <Z>
```

数値が変わったら停止して原因調査（リファクタにバグ）。

### Step 6: コミット

```bash
git add src/backtest/us/us-credit-spread-simulation.ts
git commit -m "refactor(credit-spread): simulation を純関数を呼ぶラッパー化

day-loop 内のロジックを 3 つの純関数で置き換え:
- evaluateSpread (既存スプレッドの HOLD/CLOSE/EXPIRE 判定)
- calcDDStopState (DD stop の状態遷移)
- generateEntrySignal (新規エントリー判定 + skip reason)

cash の更新、spread 配列の管理、equity curve push、メトリクス計算は
simulation.ts に残す（純関数は判断のみ、副作用は呼び出し側）。

挙動完全同等を保証（既存テスト 43/43 PASS、smoke run 数値一致）。
全期間検証は次タスク (Task 5) で実施。

Refs: KOH-452-A (予定)"
```

---

## Task 5: 全期間 backtest で step3b と完全一致を確認

**Files:** なし（実行のみ + ベースライン比較）

### Step 1: 全期間 tail-test 実行

Run:
```bash
npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28 --label phaseA-final 2>&1 | tail -20
```

Expected（Task 0 で記録した step3b と完全一致）:
```
Total spreads: 821
  Win Rate                           0.8733 (...) [PASS]
  Profit Factor                        1.78 (...) [PASS]
  CAGR                           0.0882... (...) [FAIL]
  Max DD                             0.2161 (...) [PASS]
  CVaR 5%                        -216.17... (...) [PASS]
```

**全数値が桁レベルで完全一致する必要あり**。1 つでも違えば停止して原因調査。

### Step 2: 既存 step3b レポートと diff（任意検証）

Run:
```bash
diff <(grep -E "Total spreads|Win Rate|Profit Factor|CAGR|Max DD|CVaR 5%" docs/reports/credit-spread-tail-2026-04-30-step3b.md) \
     <(grep -E "Total spreads|Win Rate|Profit Factor|CAGR|Max DD|CVaR 5%" docs/reports/credit-spread-tail-2026-04-30-phaseA-final.md)
```

Expected: 何も表示されない（完全一致）

### Step 3: 一時レポート削除（コミットしない）

phaseA-final レポートは確認用のみ、git に残さない:

```bash
rm docs/reports/credit-spread-tail-*-phaseA-final.*
```

### Step 4: 動作確認の証跡コミット（empty commit）

```bash
git commit --allow-empty -m "verify(credit-spread): Phase A リファクタ後 backtest が step3b と完全一致

期間: 2007-01-03 〜 2026-04-28
Total spreads: 821 / Win Rate: 87.33% / CAGR: 8.83% / Max DD: 21.61% / CVaR 5%: -\$216

3 つの純関数 (calcDDStopState, evaluateSpread, generateEntrySignal) への
リファクタが挙動を完全に保存していることを確認。

Refs: KOH-452-A"
```

---

## Task 6: Linear KOH-452-A 作成

**Files:** なし（Linear 操作のみ）

### Step 1: Linear タスク作成

`mcp__linear-server__save_issue` で以下を作成:

- **Title:** `Paper Trading Phase A: 信号ロジック抽出（リファクタ）`
- **Project:** Auto US Stock Trader
- **State:** Done
- **Description**:

```markdown
## 概要

KOH-451 完了を受けて、Paper Trading 実装の Phase A として信号ロジックを純関数化。
挙動完全同等を維持しつつ、backtest と paper trading で共有可能な構造に。

## 実装内容

### 新規ファイル（3 純関数）

| ファイル | 関数 | 責任 |
|---|---|---|
| `src/backtest/credit-spread/dd-stop.ts` | `calcDDStopState` | DD hard stop の状態遷移 |
| `src/backtest/credit-spread/spread-evaluator.ts` | `evaluateSpread` | 既存 spread の HOLD/CLOSE/EXPIRE 判定 |
| `src/backtest/credit-spread/signal-generator.ts` | `generateEntrySignal` | 新規エントリー判定 + skip reason |

### リファクタ

- `src/backtest/us/us-credit-spread-simulation.ts` の day-loop を上記 3 関数を呼ぶ薄ラッパー化
- cash 更新、配列管理、equity curve、メトリクス計算は simulation.ts に残存

### テスト

合計 18 件追加（dd-stop 6 + spread-evaluator 5 + signal-generator 7）。
既存 25 + 新規 18 = **全 43 件 PASS**。

## 完全一致検証

期間: 2007-01-03 〜 2026-04-28、step3b と全指標完全一致:
- Total spreads: 821
- Win Rate: 87.33%
- Profit Factor: 1.78
- CAGR: 8.83%
- Max DD: 21.61%
- CVaR 5%: -$216

## 次フェーズ

KOH-452-B: IBKR TWS API 接続（リードオンリー）

## 参考

- 設計: `docs/plans/2026-04-30-paper-trading-design.md`
- 実装プラン: `docs/plans/2026-04-30-paper-trading-phase-a-implementation-plan.md`
- KOH-447 〜 KOH-451
```

### Step 2: 完了確認

Linear で KOH-452-A が Done になっていることを確認。

---

## 全 Task 完了基準

- ✅ `find src/backtest/credit-spread -name "*.ts" | wc -l` が 6（types は既存、3 関数 + 3 テスト）
- ✅ `npm run typecheck` エラーなし
- ✅ `npm test` で全 43 件 PASS
- ✅ `npm run tail-test:credit-spread -- --start 2007-01-03 --end 2026-04-28` の結果が step3b と桁レベル完全一致
- ✅ git history が読みやすい（1 タスク = 1 コミットを基本に、Task 4 のリファクタは大きいので注意）

## DRY / YAGNI 原則の確認

- 純関数は paper trading でも使える（Phase B-E で再利用）
- 各関数の責任は単一（dd-stop、spread eval、entry signal）
- skip reason の enum は paper trading のログ・通知で活用予定
- ユニットテストは「境界条件 + 主要パス」のみ、過剰テストは書かない（既存 simulation の挙動が真実なので、それに合わせるテストは Task 5 の全期間検証で十分）

## 次フェーズ

Phase A 完了後、ユーザーと相談:
- **Phase B（IBKR TWS API 接続、リードオンリー）** に進む
  - 別プラン `2026-04-XX-paper-trading-phase-b-implementation-plan.md` 作成
- もしくは別タスク（戦略改善の継続、別戦略の tail-test 等）を優先

## 参考

- 設計書: `docs/plans/2026-04-30-paper-trading-design.md`
- KOH-451 (前提): `docs/reports/credit-spread-tail-2026-04-30-step3b.md`
