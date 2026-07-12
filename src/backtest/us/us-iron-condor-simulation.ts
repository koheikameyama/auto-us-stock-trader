/**
 * SPY/QQQ Iron Condor バックテスト
 *
 * Iron Condor サイクル（put credit spread + bear call credit spread、同一満期）:
 *   1. put/call 各ショート売り + ロング買い → totalCredit 受領（cash増）
 *   2. 日次で残 condor 価格を BS + skew で評価
 *   3. 早期決済 (50%利益)、ストップロス、満期消滅、満期最大損失で クローズ
 *
 * collateral は**片側分**（put/call は同時に max loss にならないため）= spreadWidth × 100 × contracts。
 * edge の源泉は同 collateral で put+call の 2倍プレミアムを取れる構造。
 *
 * 信号ロジックは 3 つの純関数に切り出し（credit-spread と同構成）:
 *   - evaluateCondor: 既存 condor の HOLD/CLOSE/EXPIRE 判定
 *   - calcDDStopState: DD hard stop の状態遷移（credit-spread と共有）
 *   - generateCondorEntrySignal: 新規エントリー判定 + skip reason
 *
 * regime sizing / event-aware filter を credit-spread-simulation と同様に継承する。
 */

import { calcDDStopState, type DDStopPrevState } from "../credit-spread/dd-stop";
import { evaluateCondor, priceCondor } from "../iron-condor/condor-evaluator";
import { generateCondorEntrySignal } from "../iron-condor/condor-signal-generator";
import { calculateMetrics } from "../metrics";
import type {
  USIronCondorBacktestConfig,
  USIronCondorBacktestResult,
  SimulatedCondor,
  IronCondorPerformanceMetrics,
  EventSkippedEntry,
} from "./us-iron-condor-types";
import type { SimulatedPosition, DailyEquity } from "../types";
import type { RegimeMap } from "./regime-fetcher";
import { nearestEvent, type EventCalendar, type EventType } from "./event-fetcher";

export interface EventAwareConfig {
  /** ±N 日のイベント近接で entry を skip する */
  windowDays: number;
  /** どの eventType を skip 対象にするか */
  skipTypes: EventType[];
}

const CONTRACT_SIZE = 100;

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** 開いてる condor の unrealized value（片側 collateral - 現在の負債） */
function calcUnrealizedCondorValue(
  openCondors: SimulatedCondor[],
  spotSpy: number,
  iv: number,
  config: USIronCondorBacktestConfig,
  today: string,
): number {
  const putSlope = config.putSkewSlope ?? 0;
  const callSlope = config.callSkewSlope ?? 0;
  let total = 0;
  for (const c of openCondors) {
    const tte = Math.max(daysBetween(today, c.expirationDate) / 365, 0);
    const currentValue = priceCondor(spotSpy, c, tte, config.riskFreeRate, iv, putSlope, callSlope);
    total += config.spreadWidth * CONTRACT_SIZE * c.contracts - currentValue * CONTRACT_SIZE * c.contracts;
  }
  return total;
}

export async function runUSIronCondorBacktest(
  config: USIronCondorBacktestConfig,
  gspcData: Map<string, number>,
  vixData: Map<string, number>,
  regimeData?: RegimeMap,
  eventCalendar?: EventCalendar,
  eventAware?: EventAwareConfig,
): Promise<USIronCondorBacktestResult> {
  const tradingDays = [...gspcData.keys()]
    .filter((d) => d >= config.startDate && d <= config.endDate)
    .sort();

  // SMA ウォームアップ用に過去データも保持
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
  const openCondors: SimulatedCondor[] = [];
  const closedCondors: SimulatedCondor[] = [];
  const equityCurve: DailyEquity[] = [];
  const eventSkips: EventSkippedEntry[] = [];

  for (const today of tradingDays) {
    const gspc = gspcData.get(today);
    const vix = vixData.get(today);
    if (gspc == null || vix == null) continue;

    const spotSpy = gspc / 10;
    const iv = (vix / 100) * config.ivScaleFactor;

    // ── 1. 既存 condor を evaluateCondor で評価・クローズ ──
    const stillOpen: SimulatedCondor[] = [];
    for (const c of openCondors) {
      const result = evaluateCondor(c, { today, spotSpy, vix, config });

      if (result.action === "EXPIRE") {
        const finalValue = result.finalValue;
        // 満期消滅は手数料発生せず（OCC の自動消滅）。ITM 部分があれば 4脚決済扱い。
        const isWorthless = result.reason === "expired_worthless";
        const commissionsThisLeg = isWorthless ? 0 : config.optionsCommission * 4 * c.contracts;
        const pnl = (c.creditReceived - finalValue) * CONTRACT_SIZE * c.contracts - commissionsThisLeg;

        cash += config.spreadWidth * CONTRACT_SIZE * c.contracts; // 片側 collateral 解放
        cash -= finalValue * CONTRACT_SIZE * c.contracts; // 終値支払い
        cash -= commissionsThisLeg;

        c.state = "CLOSED";
        c.closeDate = today;
        c.closeCondorPrice = finalValue;
        c.totalCommissions += commissionsThisLeg;
        c.netPnl = pnl;
        c.closeReason = result.reason;
        closedCondors.push(c);
      } else if (result.action === "CLOSE") {
        const currentValue = result.currentValue;
        const exitCommission = config.optionsCommission * 4 * c.contracts; // 4脚買い戻し
        const pnl = (c.creditReceived - currentValue) * CONTRACT_SIZE * c.contracts - exitCommission;

        cash += config.spreadWidth * CONTRACT_SIZE * c.contracts; // 片側 collateral 解放
        cash -= currentValue * CONTRACT_SIZE * c.contracts; // 買い戻し
        cash -= exitCommission;

        c.state = "CLOSED";
        c.closeDate = today;
        c.closeReason = result.reason;
        c.closeCondorPrice = currentValue;
        c.totalCommissions += exitCommission;
        c.netPnl = pnl;
        closedCondors.push(c);
      } else {
        stillOpen.push(c);
      }
    }
    openCondors.length = 0;
    openCondors.push(...stillOpen);

    // ── 1.5. DD hard stop 状態遷移 ──
    const equityForDD = cash + calcUnrealizedCondorValue(openCondors, spotSpy, iv, config, today);
    const newDDState = calcDDStopState({ today, totalEquity: equityForDD, prevState: ddState, config });
    ddState = {
      runningPeak: newDDState.runningPeak,
      ddStopActive: newDDState.ddStopActive,
      ddStopActivatedDate: newDDState.ddStopActivatedDate,
    };

    // ── 2. 新規エントリー判定 ──
    const signal = generateCondorEntrySignal({
      today,
      gspc,
      spotSpy,
      vix,
      smaGspc: gspcSmaCache.get(today) ?? null,
      cash,
      openPositionCount: openCondors.length,
      ddStopActive: ddState.ddStopActive,
      tradingDays,
      config,
    });

    if (signal.reason === "ENTERED") {
      // Event-aware filter: ±window 日に対象イベントがあれば skip
      let eventHit: { eventType: string; daysAway: number } | null = null;
      if (eventCalendar && eventAware && eventAware.skipTypes.length > 0) {
        const hit = nearestEvent(eventCalendar, today, eventAware.windowDays);
        if (hit && eventAware.skipTypes.includes(hit.eventType)) {
          eventHit = { eventType: hit.eventType, daysAway: hit.daysAway };
        }
      }

      if (eventHit) {
        eventSkips.push({ date: today, ...eventHit });
      } else {
        // Regime filter: 当日の RegimeSignal で contracts をスケール（fail-safe で multiplier=1.0）
        const regimeRecord = regimeData?.get(today);
        const multiplier = regimeRecord?.multiplier ?? 1.0;
        const regimeState = regimeRecord?.state ?? null;
        const finalContracts = Math.floor(config.contractsPerCondor * multiplier);

        if (finalContracts > 0) {
          const creditScale = config.creditScale ?? 1;
          const entryPutCredit = signal.putCredit * creditScale;
          const entryCallCredit = signal.callCredit * creditScale;
          const entryCredit = entryPutCredit + entryCallCredit;
          const collateralRequired = config.spreadWidth * CONTRACT_SIZE * finalContracts;
          const entryCommission = config.optionsCommission * 4 * finalContracts; // 4脚
          cash -= collateralRequired;
          cash += entryCredit * CONTRACT_SIZE * finalContracts;
          cash -= entryCommission;

          const newCondor: SimulatedCondor = {
            underlyingSymbol: config.underlyingSymbol,
            entryDate: today,
            expirationDate: signal.expirationDate,
            entrySpotPrice: spotSpy,
            entryIV: iv,
            putShortStrike: signal.putShortStrike,
            putLongStrike: signal.putLongStrike,
            callShortStrike: signal.callShortStrike,
            callLongStrike: signal.callLongStrike,
            putShortDeltaAtEntry: signal.putShortDelta,
            callShortDeltaAtEntry: signal.callShortDelta,
            putCredit: entryPutCredit,
            callCredit: entryCallCredit,
            creditReceived: entryCredit,
            contracts: finalContracts,
            state: "OPEN",
            totalCommissions: entryCommission,
            regime: regimeState,
            eventProximity: null,
          };
          openCondors.push(newCondor);
        }
        // finalContracts <= 0 (RISK_OFF) の場合は entry skip
      }
    }

    // ── 3. equity curve 計算 ──
    const unrealizedValue = calcUnrealizedCondorValue(openCondors, spotSpy, iv, config, today);
    const totalEquity = cash + unrealizedValue;
    equityCurve.push({
      date: today,
      cash,
      positionsValue: unrealizedValue,
      totalEquity,
      openPositionCount: openCondors.length,
    });
  }

  // ── 4. メトリクス計算 ──
  const allCondors = [...closedCondors, ...openCondors];

  const mapExitReason = (
    r: SimulatedCondor["closeReason"],
  ): SimulatedPosition["exitReason"] => {
    if (r === "profit_target" || r === "expired_worthless") return "take_profit";
    if (r === "stop_loss" || r === "expired_max_loss") return "stop_loss";
    if (r === "expired_partial") return "time_stop";
    return "still_open";
  };

  const tradeShape: SimulatedPosition[] = closedCondors.map((c) => {
    const grossPnl = (c.creditReceived - (c.closeCondorPrice ?? 0)) * CONTRACT_SIZE * c.contracts;
    const netPnl = c.netPnl ?? 0;
    const holdingDays = c.closeDate ? daysBetween(c.entryDate, c.closeDate) : 0;
    const maxLossDollar = config.spreadWidth * CONTRACT_SIZE * c.contracts; // 片側
    return {
      ticker: c.underlyingSymbol,
      entryDate: c.entryDate,
      entryPrice: c.entrySpotPrice,
      takeProfitPrice: 0,
      stopLossPrice: 0,
      quantity: c.contracts,
      volumeSurgeRatio: 0,
      regime: null,
      maxHighDuringHold: c.entrySpotPrice,
      minLowDuringHold: c.entrySpotPrice,
      trailingStopPrice: null,
      entryAtr: null,
      exitDate: c.closeDate ?? null,
      exitPrice: c.entrySpotPrice,
      exitReason: mapExitReason(c.closeReason),
      pnl: netPnl,
      pnlPct: (netPnl / maxLossDollar) * 100,
      holdingDays,
      limitLockDays: 0,
      entryCommission: config.optionsCommission * 4 * c.contracts,
      exitCommission: c.totalCommissions - config.optionsCommission * 4 * c.contracts,
      totalCost: c.totalCommissions,
      tax: 0,
      grossPnl,
      netPnl,
    };
  });

  const baseMetrics = calculateMetrics(tradeShape, equityCurve, config.initialBudget);

  const totalCredit = closedCondors.reduce((s, c) => s + c.creditReceived * CONTRACT_SIZE * c.contracts, 0);
  const expiredWorthless = closedCondors.filter((c) => c.closeReason === "expired_worthless").length;
  const maxLossCount = closedCondors.filter((c) => c.closeReason === "expired_max_loss").length;
  const profitTargetHits = closedCondors.filter((c) => c.closeReason === "profit_target").length;
  const stopLossHits = closedCondors.filter((c) => c.closeReason === "stop_loss").length;
  const avgCreditRatio = closedCondors.length > 0
    ? closedCondors.reduce((s, c) => s + c.creditReceived / config.spreadWidth, 0) / closedCondors.length
    : 0;
  const avgHolding = closedCondors.length > 0
    ? closedCondors.reduce((s, c) => s + (c.closeDate ? daysBetween(c.entryDate, c.closeDate) : 0), 0) / closedCondors.length
    : 0;

  const metrics: IronCondorPerformanceMetrics = {
    ...baseMetrics,
    totalCondors: closedCondors.length,
    expiredWorthless,
    maxLossCount,
    profitTargetHits,
    stopLossHits,
    totalCreditReceived: totalCredit,
    avgCreditRatio,
    avgHoldingDays: avgHolding,
  };

  return { config, condors: allCondors, equityCurve, metrics, eventSkips };
}
