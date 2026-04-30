/**
 * SPY/QQQ Credit Spread バックテスト
 *
 * Bull Put Credit Spread サイクル:
 *   1. ショートput売り + ロングput買い → クレジット受領（cash増）
 *   2. 日次で残スプレッド価格を BS で評価
 *   3. 早期決済 (50%利益)、ストップロス、満期消滅、満期最大損失で クローズ
 *
 * 原資産: ^GSPC ÷ 10 = SPY 換算（実SPYと数%以内の誤差）
 * IV: VIX / 100 × ivScaleFactor
 *
 * 信号ロジックは 3 つの純関数に切り出し済み（Phase A）:
 *   - evaluateSpread: 既存スプレッドの HOLD/CLOSE/EXPIRE 判定
 *   - calcDDStopState: DD hard stop の状態遷移
 *   - generateEntrySignal: 新規エントリー判定 + skip reason
 *
 * 本ファイルは 3 関数を呼ぶ薄いラッパーで、cash 更新・spread 配列管理・
 * equity curve push・メトリクス計算を担当する。
 */

import { bsPutPrice } from "../../core/options-pricing";
import { calcDDStopState, type DDStopPrevState } from "../credit-spread/dd-stop";
import { evaluateSpread } from "../credit-spread/spread-evaluator";
import { generateEntrySignal } from "../credit-spread/signal-generator";
import { calculateMetrics } from "../metrics";
import type { USCreditSpreadBacktestConfig, USCreditSpreadBacktestResult, SimulatedSpread, CreditSpreadPerformanceMetrics } from "./us-credit-spread-types";
import type { SimulatedPosition, DailyEquity } from "../types";

const CONTRACT_SIZE = 100;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** スプレッドの現在価格（売値ベース、close時に支払う） */
function priceSpread(
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

export async function runUSCreditSpreadBacktest(
  config: USCreditSpreadBacktestConfig,
  gspcData: Map<string, number>,
  vixData: Map<string, number>,
): Promise<USCreditSpreadBacktestResult> {
  // tradingDays: ^GSPC のある日付セット
  const tradingDays = [...gspcData.keys()]
    .filter((d) => d >= config.startDate && d <= config.endDate)
    .sort();

  // SMAウォームアップ用に過去データも保持（lookback前から計算可能）
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
  // DD hard stop ステート（純関数 calcDDStopState に渡す）
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
        // 満期消滅の場合は手数料発生せず（OCCの自動消滅）
        const isWorthless = result.reason === "expired_worthless";
        const commissionsThisLeg = isWorthless ? 0 : exitCommission;
        const pnl = (sp.creditReceived - finalSpreadValue) * CONTRACT_SIZE * sp.contracts - commissionsThisLeg;

        cash += config.spreadWidth * CONTRACT_SIZE * sp.contracts; // collateral 解放
        cash -= finalSpreadValue * CONTRACT_SIZE * sp.contracts; // 終値支払い
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

        cash += config.spreadWidth * CONTRACT_SIZE * sp.contracts; // collateral 解放
        cash -= currentSpreadPrice * CONTRACT_SIZE * sp.contracts; // 買い戻し
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

    // ── 1.5. DD hard stop 状態遷移（calcDDStopState 純関数に委譲）──
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

    // ── 2. 新規エントリー判定（generateEntrySignal 純関数に委譲）──
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
    equityCurve.push({
      date: today,
      cash,
      positionsValue: unrealizedSpreadValue,
      totalEquity,
      openPositionCount: openSpreads.length,
    });
  }

  // ── 4. メトリクス計算 ──
  const allSpreads = [...closedSpreads, ...openSpreads];

  // metrics.ts は SimulatedPosition の特定 exitReason のみカウントするため、
  // クレジットスプレッドのクローズ理由を以下の通りマッピング:
  //   profit_target / expired_worthless → "take_profit"
  //   stop_loss / expired_max_loss → "stop_loss"
  //   expired_partial → "time_stop"（PnLは計上、勝敗判定は pnl の正負で）
  const mapExitReason = (
    r: SimulatedSpread["closeReason"],
  ): SimulatedPosition["exitReason"] => {
    if (r === "profit_target" || r === "expired_worthless") return "take_profit";
    if (r === "stop_loss" || r === "expired_max_loss") return "stop_loss";
    if (r === "expired_partial") return "time_stop";
    return "still_open";
  };

  const tradeShape: SimulatedPosition[] = closedSpreads.map((sp) => {
    const grossPnl = (sp.creditReceived - (sp.closeSpreadPrice ?? 0)) * CONTRACT_SIZE * sp.contracts;
    const netPnl = sp.netPnl ?? 0;
    const holdingDays = sp.closeDate ? daysBetween(sp.entryDate, sp.closeDate) : 0;
    const maxLossDollar = config.spreadWidth * CONTRACT_SIZE * sp.contracts;
    return {
      ticker: sp.underlyingSymbol,
      entryDate: sp.entryDate,
      entryPrice: sp.entrySpotPrice,
      takeProfitPrice: 0,
      stopLossPrice: 0,
      quantity: sp.contracts,
      volumeSurgeRatio: 0,
      regime: null,
      maxHighDuringHold: sp.entrySpotPrice,
      minLowDuringHold: sp.entrySpotPrice,
      trailingStopPrice: null,
      entryAtr: null,
      exitDate: sp.closeDate ?? null,
      exitPrice: sp.entrySpotPrice,
      exitReason: mapExitReason(sp.closeReason),
      pnl: netPnl,
      pnlPct: (netPnl / maxLossDollar) * 100,
      holdingDays,
      limitLockDays: 0,
      entryCommission: config.optionsCommission * 2 * sp.contracts,
      exitCommission: sp.totalCommissions - config.optionsCommission * 2 * sp.contracts,
      totalCost: sp.totalCommissions,
      tax: 0,
      grossPnl,
      netPnl,
    };
  });

  const baseMetrics = calculateMetrics(tradeShape, equityCurve, config.initialBudget);

  const totalCredit = closedSpreads.reduce((s, sp) => s + sp.creditReceived * CONTRACT_SIZE * sp.contracts, 0);
  const expiredWorthless = closedSpreads.filter((sp) => sp.closeReason === "expired_worthless").length;
  const maxLossCount = closedSpreads.filter((sp) => sp.closeReason === "expired_max_loss").length;
  const profitTargetHits = closedSpreads.filter((sp) => sp.closeReason === "profit_target").length;
  const stopLossHits = closedSpreads.filter((sp) => sp.closeReason === "stop_loss").length;
  const avgCreditRatio = closedSpreads.length > 0
    ? closedSpreads.reduce((s, sp) => s + sp.creditReceived / config.spreadWidth, 0) / closedSpreads.length
    : 0;
  const avgHolding = closedSpreads.length > 0
    ? closedSpreads.reduce((s, sp) => s + (sp.closeDate ? daysBetween(sp.entryDate, sp.closeDate) : 0), 0) /
      closedSpreads.length
    : 0;

  const metrics: CreditSpreadPerformanceMetrics = {
    ...baseMetrics,
    totalSpreads: closedSpreads.length,
    expiredWorthless,
    maxLossCount,
    profitTargetHits,
    stopLossHits,
    totalCreditReceived: totalCredit,
    avgCreditRatio,
    avgHoldingDays: avgHolding,
  };

  return { config, spreads: allSpreads, equityCurve, metrics };
}
