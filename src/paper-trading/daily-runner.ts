// src/paper-trading/daily-runner.ts
/**
 * Alpaca Paper Trading 日次実行
 *
 * Usage:
 *   npx tsx src/paper-trading/daily-runner.ts                 # 通常実行
 *   npx tsx src/paper-trading/daily-runner.ts --dry-run        # 発注スキップ
 *
 * Required env:
 *   ALPACA_API_KEY
 *   ALPACA_API_SECRET
 *   ALPACA_API_ENDPOINT  (e.g. https://paper-api.alpaca.markets/v2)
 *   ALPACA_DATA_ENDPOINT (optional; default https://data.alpaca.markets)
 */

import { pathToFileURL } from "url";
import dayjs from "dayjs";
import { PrismaClient } from "@prisma/client";
import { AlpacaClient, type OptionContract } from "./alpaca-client";
import { bsPutPrice } from "../core/options-pricing";
import { isKillSwitchActive, getKillSwitchInfo } from "./kill-switch";
import { reconcilePositions } from "./position-syncer";
import { withRetry } from "./with-retry";
import { evaluateSpread } from "../backtest/credit-spread/spread-evaluator";
import { calcDDStopState } from "../backtest/credit-spread/dd-stop";
import { generateEntrySignal } from "../backtest/credit-spread/signal-generator";
import { US_CREDIT_SPREAD_DEFAULTS } from "../backtest/us/us-credit-spread-config";
import type { SimulatedSpread } from "../backtest/us/us-credit-spread-types";
import { fetchIndexFromDB } from "../backtest/data-fetcher";
import { placeNewSpreadOrder, closeSpreadOrder, expirePosition, buildOccSymbol } from "./order-manager";
import { getRegimeMultiplier, scaleContracts } from "./regime-multiplier";
import {
  sendSlack,
  formatEntrySuccess, formatCloseSuccess, formatExpire,
  formatDDStop, formatDailySummary, formatErrorAlert, formatKillSwitch, formatDuplicateOrder,
  formatNonTradingDay, formatEntryRejected, formatEntryTimeout,
} from "./slack-notifier";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

/**
 * Black-Scholes が選んだ理想 strike を、Alpaca が当該 expiry で実際に listing
 * している strike にスナップする。
 *
 * - short は理想値に最も近い available strike へ。距離が `maxSnapDistance` を
 *   超える場合は null（= 発注不可）。
 * - long は `short - 理想 width` に最も近く、かつ `short` より厳密に小さい
 *   available strike へ。snap 距離は同じく `maxSnapDistance` で頭打ち。
 *
 * 戻り値の `snappedShortStrike` / `snappedLongStrike` が null のときは entry
 * 不可（SKIP_STRIKE_UNAVAILABLE）として扱う。
 */
export function snapStrikesToChain(params: {
  idealShort: number;
  idealLong: number;
  availableStrikes: number[];
  maxSnapDistance?: number;
}): { snappedShort: number | null; snappedLong: number | null; snappedWidth: number | null } {
  const { idealShort, idealLong, availableStrikes, maxSnapDistance = 3 } = params;
  if (availableStrikes.length === 0) {
    return { snappedShort: null, snappedLong: null, snappedWidth: null };
  }
  const sorted = [...new Set(availableStrikes)].sort((a, b) => a - b);

  const nearest = (target: number): number => {
    let best = sorted[0];
    let bestDist = Math.abs(best - target);
    for (const s of sorted) {
      const d = Math.abs(s - target);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    return best;
  };

  const snappedShort = nearest(idealShort);
  if (Math.abs(snappedShort - idealShort) > maxSnapDistance) {
    return { snappedShort: null, snappedLong: null, snappedWidth: null };
  }

  const below = sorted.filter((s) => s < snappedShort);
  if (below.length === 0) {
    return { snappedShort, snappedLong: null, snappedWidth: null };
  }
  let snappedLong = below[0];
  let bestDist = Math.abs(below[0] - idealLong);
  for (const s of below) {
    const d = Math.abs(s - idealLong);
    if (d < bestDist) {
      snappedLong = s;
      bestDist = d;
    }
  }
  if (Math.abs(snappedLong - idealLong) > maxSnapDistance) {
    return { snappedShort, snappedLong: null, snappedWidth: null };
  }

  return {
    snappedShort,
    snappedLong,
    snappedWidth: snappedShort - snappedLong,
  };
}

export interface LimitPricingInput {
  shortQuote: { bid: number | null; ask: number | null } | null;
  longQuote: { bid: number | null; ask: number | null } | null;
  /** Theoretical credit from BS — used as fallback when quote-based pricing is unavailable. */
  bsCredit: number;
  /** How much to give up vs natural mid (default $0.02). */
  midHaircut?: number;
  /** Minimum acceptable limit credit (default $0.01). */
  minLimit?: number;
}

export interface LimitPricingResult {
  limit: number;
  source: "quote" | "bs";
  quoteCredit: number | null;
  shortMid: number | null;
  longMid: number | null;
}

/**
 * Limit credit を決める。
 *
 * 両 leg の bid/ask が揃っていれば natural mid - haircut を採用（"quote" source）。
 * 片方でも欠損 / 異常（mid 反転 = quoteCredit <= 0）なら BS 理論値に fallback。
 *
 * 理由: BS-flat-IV は OTM put credit spread の real market mid を skew で
 * 過大評価しがちで、それを limit にすると市場が touch しない。実 quote を
 * 見れば skew が price に織り込まれた mid に乗れる。
 */
export function decideLimitCredit(input: LimitPricingInput): LimitPricingResult {
  const { shortQuote, longQuote, bsCredit, midHaircut = 0.02, minLimit = 0.01 } = input;
  const shortMid =
    shortQuote && shortQuote.bid != null && shortQuote.ask != null
      ? (shortQuote.bid + shortQuote.ask) / 2
      : null;
  const longMid =
    longQuote && longQuote.bid != null && longQuote.ask != null
      ? (longQuote.bid + longQuote.ask) / 2
      : null;
  if (shortMid != null && longMid != null) {
    const quoteCredit = shortMid - longMid;
    if (quoteCredit > 0) {
      return {
        limit: Math.max(minLimit, quoteCredit - midHaircut),
        source: "quote",
        quoteCredit,
        shortMid,
        longMid,
      };
    }
  }
  return { limit: bsCredit, source: "bs", quoteCredit: null, shortMid, longMid };
}

export interface DailyCycleDeps {
  alpaca: AlpacaClient;
  prisma: PrismaClient;
  today: string;       // "YYYY-MM-DD"
  dryRun: boolean;
}

export async function runDailyCycle(deps: DailyCycleDeps): Promise<void> {
  const { alpaca, prisma, today, dryRun } = deps;

  const summaryEvents: string[] = [];

  // ── 1. 取引日チェック（祝日 / 短縮取引日含む休場で早期 return）──
  const isTradingDay = await withRetry(() => alpaca.isTradingDay(today), { retries: 3, intervalMs: 5_000 });
  if (!isTradingDay) {
    console.log(`Today (${today}) is not a US trading day. Skipping cycle.`);
    await sendSlack({ text: formatNonTradingDay(today), level: "info" });
    return;
  }

  // ── 2. アカウント情報 ──
  const accountSummary = await withRetry(() => alpaca.getAccountSummary(), { retries: 3, intervalMs: 5_000 });
  console.log(`Account: NetLiq=$${accountSummary.netLiquidation.toLocaleString()}, BP=$${accountSummary.buyingPower.toLocaleString()}`);

  // ── 3. 既存ポジション同期 ──
  console.log("Reconciling positions...");
  const { mismatches, brokerLegs, dbOpenPositions } = await reconcilePositions(alpaca, prisma);
  console.log(`  Broker active legs: ${brokerLegs.length}`);
  console.log(`  DB OPEN positions: ${dbOpenPositions}`);
  if (mismatches.length > 0) {
    console.error(`⚠ ${mismatches.length} position mismatches detected:`);
    for (const m of mismatches) {
      console.error(`  ${m.type}: ${m.symbol} ${m.shortStrike}/${m.longStrike} ${m.expiry}`);
    }
    await sendSlack({
      text: `Position mismatch: ${mismatches.length} differences (${mismatches.map((m) => m.type).join(", ")})`,
      level: "warn",
    });
  }

  // ── 4. live data 取得 (SPY) + DB から VIX (当日 close、backfill 完了後の前提) ──
  console.log("Fetching market data...");
  const spy = await withRetry(() => alpaca.getMarketPrice("SPY"), { retries: 3, intervalMs: 5_000 });
  const spotSpy =
    spy.bid != null && spy.ask != null
      ? (spy.bid + spy.ask) / 2
      : (spy.bid ?? spy.ask);
  if (spotSpy == null) {
    console.error("⚠ SPY price unavailable, skipping today's cycle");
    return;
  }

  const vixLookbackStart = dayjs(today).subtract(10, "day").format("YYYY-MM-DD");
  const vixHistorical = await fetchIndexFromDB("^VIX", vixLookbackStart, today, 0);
  const sortedVixDates = [...vixHistorical.keys()].sort();
  const vix = sortedVixDates.length
    ? vixHistorical.get(sortedVixDates[sortedVixDates.length - 1]) ?? null
    : null;
  if (vix == null) {
    console.error("⚠ VIX unavailable from DB, skipping today's cycle");
    return;
  }

  const gspc = spotSpy * 10;
  console.log(`  SPY=${spotSpy}, VIX=${vix.toFixed(2)} (latest close in DB), gspc=${gspc}`);

  // ── 5. 既存スプレッドの evaluateSpread ──
  const dbOpenSpreads = await prisma.position.findMany({ where: { state: "OPEN" } });
  console.log(`Evaluating ${dbOpenSpreads.length} open spread(s)...`);

  for (const dbPos of dbOpenSpreads) {
    const expiryStr = dbPos.expiry.toISOString().slice(0, 10);
    const sp: SimulatedSpread = {
      underlyingSymbol: dbPos.symbol,
      entryDate: dbPos.entryDate.toISOString().slice(0, 10),
      expirationDate: expiryStr,
      entrySpotPrice: 0,
      entryIV: 0,
      shortStrike: dbPos.shortStrike,
      longStrike: dbPos.longStrike,
      shortDeltaAtEntry: 0,
      creditReceived: dbPos.creditReceived,
      contracts: dbPos.contracts,
      state: "OPEN",
      totalCommissions: dbPos.totalCommission ?? 0,
    };

    const action = evaluateSpread(sp, {
      today,
      spotSpy,
      vix,
      config: US_CREDIT_SPREAD_DEFAULTS,
    });

    console.log(`  ${dbPos.symbol} ${dbPos.shortStrike}/${dbPos.longStrike}: ${action.action}${action.action !== "HOLD" ? `/${action.reason}` : ""}`);

    if (action.action === "CLOSE") {
      if (dryRun) {
        console.log(`  [DRY RUN] Would close: reason=${action.reason}, value=${action.currentValue}`);
      } else {
        try {
          const closed = await closeSpreadOrder(alpaca, prisma, {
            positionId: dbPos.id,
            reason: action.reason,
            currentSpreadValue: action.currentValue,
          });
          console.log(`  Closed brokerOrderId=${closed.brokerOrderId}, status=${closed.status}`);
          if (closed.status === "FILLED") {
            const daysHeld = Math.floor((Date.now() - dbPos.entryDate.getTime()) / 86400000);
            const updated = await prisma.position.findUnique({ where: { id: dbPos.id } });
            summaryEvents.push(formatCloseSuccess({
              shortStrike: dbPos.shortStrike,
              longStrike: dbPos.longStrike,
              reason: action.reason,
              netPnl: updated?.netPnl ?? null,
              daysHeld,
            }));
          }
        } catch (e: any) {
          console.error(`  ❌ Close failed: ${e.message}`);
          await prisma.errorLog.create({
            data: { category: "CLOSE_FAILED", message: e.message, context: { positionId: dbPos.id, reason: action.reason } },
          });
          await sendSlack({
            text: formatErrorAlert("CLOSE_FAILED", e.message),
            level: "error",
          });
        }
      }
    } else if (action.action === "EXPIRE") {
      if (dryRun) {
        console.log(`  [DRY RUN] Would expire: reason=${action.reason}, value=${action.finalValue}`);
      } else {
        try {
          await expirePosition(prisma, {
            positionId: dbPos.id,
            reason: action.reason,
            finalValue: action.finalValue,
          });
          console.log(`  Expired: reason=${action.reason}, value=${action.finalValue}`);
          const updated = await prisma.position.findUnique({ where: { id: dbPos.id } });
          summaryEvents.push(formatExpire({
            shortStrike: dbPos.shortStrike,
            longStrike: dbPos.longStrike,
            reason: action.reason,
            netPnl: updated?.netPnl ?? null,
          }));
        } catch (e: any) {
          console.error(`  ❌ Expire failed: ${e.message}`);
          await prisma.errorLog.create({
            data: { category: "EXPIRE_FAILED", message: e.message, context: { positionId: dbPos.id, reason: action.reason } },
          });
          await sendSlack({
            text: formatErrorAlert("EXPIRE_FAILED", e.message),
            level: "error",
          });
        }
      }
    }

    await prisma.signalLog.create({
      data: {
        date: new Date(today),
        signalType: action.action,
        reason: action.action === "HOLD" ? "hold" : action.reason,
        details: {
          shortStrike: dbPos.shortStrike,
          longStrike: dbPos.longStrike,
          currentValue: (action as any).currentValue ?? null,
          finalValue: (action as any).finalValue ?? null,
        },
      },
    });
  }

  let openPositionCount = await prisma.position.count({ where: { state: "OPEN" } });

  // Broker 側で alive な ENTRY 注文（=未約定の sell_to_open を含む mleg）も
  // capacity を消費しているとみなして count に加算する。これがないと、
  // 約定確認できなかった注文が resting しているのに次サイクルで「ポジション 0」
  // と判定されて二重発注される（KOH-466）。
  const pendingBrokerEntries = await withRetry(
    () => alpaca.getOpenOrders({ symbols: ["SPY"] }),
    { retries: 3, intervalMs: 5_000 },
  );
  const pendingEntryCount = pendingBrokerEntries.filter(
    (o) => o.orderClass === "mleg" && o.legs.some((l) => l.positionIntent === "sell_to_open"),
  ).length;
  if (pendingEntryCount > 0) {
    console.log(`  Broker pending ENTRY orders: ${pendingEntryCount} (counted toward capacity)`);
  }
  openPositionCount += pendingEntryCount;

  // ── 6. equity 計算 + DD stop 状態遷移 ──
  // Alpaca の `equity` は cash + 開ポジの mark-to-market を含む値。
  // cash と positionsValue を分けて保存することで、credit spread の
  // 含み損益（spread を買い戻すコスト）が日次で観測できるようになる。
  const netLiq = accountSummary.netLiquidation;
  const cashValue = accountSummary.totalCashValue;
  const positionsValue = netLiq - cashValue;
  const totalEquity = netLiq;

  const lastSnapshot = await prisma.dailyEquitySnapshot.findFirst({
    orderBy: { date: "desc" },
  });
  const prevState = {
    runningPeak: lastSnapshot?.runningPeak ?? totalEquity,
    ddStopActive: lastSnapshot?.ddStopActive ?? false,
    ddStopActivatedDate: lastSnapshot?.ddStopActivatedDate?.toISOString().slice(0, 10) ?? null,
  };
  const ddState = calcDDStopState({
    today,
    totalEquity,
    prevState,
    config: US_CREDIT_SPREAD_DEFAULTS,
  });
  console.log(`DD stop: active=${ddState.ddStopActive} (transition=${ddState.transition}), peak=$${ddState.runningPeak.toLocaleString()}`);
  if (ddState.transition !== "UNCHANGED") {
    await sendSlack({
      text: formatDDStop(ddState.transition, ddState.runningPeak, totalEquity),
      level: "warn",
    });
  }

  // ── 7. 新規エントリー判定 ──
  const lookbackEnd = today;
  const lookbackStart = dayjs(today).subtract(75, "day").format("YYYY-MM-DD");
  const gspcHistorical = await fetchIndexFromDB("^GSPC", lookbackStart, lookbackEnd, 0);
  const sortedDates = [...gspcHistorical.keys()].sort().slice(-50);
  const sma50 = sortedDates.length === 50
    ? sortedDates.reduce((sum, d) => sum + (gspcHistorical.get(d) ?? 0), 0) / 50
    : null;
  console.log(`SMA50(GSPC) = ${sma50?.toFixed(2) ?? "(unavailable)"}`);

  // Alpaca の listing から実在する put 契約を取得（forward 100 日、spot ± 15%）。
  // - 当日 listing 済みの expiry のみ signal-generator に渡し、Mon/Tue/Wed/Thu や
  //   未上場 expiry が選ばれて「asset not found」(422) となる事故を防ぐ。
  // - 後段で signal の strike を実 listing にスナップ。
  const lookforwardEnd = dayjs(today).add(100, "day").format("YYYY-MM-DD");
  const strikeMin = Math.floor(spotSpy * 0.85);
  const strikeMax = Math.ceil(spotSpy * 1.05);
  const spyContracts: OptionContract[] = await withRetry(
    () => alpaca.listOptionContracts("SPY", "P", today, lookforwardEnd, strikeMin, strikeMax),
    { retries: 3, intervalMs: 5_000 },
  );
  const tradingDays = [...new Set(spyContracts.map((c) => c.expiry))].sort();
  console.log(
    `Alpaca SPY put contracts: ${spyContracts.length} contracts across ${tradingDays.length} expiries ` +
      `in [${today}, ${lookforwardEnd}], strikes [${strikeMin}, ${strikeMax}]`,
  );

  if (tradingDays.length === 0) {
    console.error(`⚠ No SPY put contracts listed at Alpaca in window; skipping entry`);
    await prisma.signalLog.create({
      data: {
        date: new Date(today),
        signalType: "ENTRY",
        reason: "SKIP_NO_CONTRACTS",
        details: { lookforwardEnd, strikeMin, strikeMax },
      },
    });
    await sendSlack({
      text: `*ENTRY SKIPPED* (SKIP_NO_CONTRACTS) — Alpaca に SPY put listing が無い (${today} 〜 ${lookforwardEnd})`,
      level: "warn",
    });
  } else {
    await evaluateAndPlaceEntry({
      alpaca,
      prisma,
      today,
      dryRun,
      spotSpy,
      vix,
      gspc,
      sma50,
      netLiq,
      openPositionCount,
      ddState,
      spyContracts,
      tradingDays,
      summaryEvents,
    });
  }

  // ── 8. DailyEquitySnapshot を保存 ──
  openPositionCount = await prisma.position.count({ where: { state: "OPEN" } });
  await prisma.dailyEquitySnapshot.upsert({
    where: { date: new Date(today) },
    create: {
      date: new Date(today),
      cash: cashValue,
      positionsValue,
      totalEquity,
      openPositionCount,
      ddStopActive: ddState.ddStopActive,
      runningPeak: ddState.runningPeak,
      ddStopActivatedDate: ddState.ddStopActivatedDate ? new Date(ddState.ddStopActivatedDate) : null,
    },
    update: {
      cash: cashValue,
      positionsValue,
      totalEquity,
      openPositionCount,
      ddStopActive: ddState.ddStopActive,
      runningPeak: ddState.runningPeak,
      ddStopActivatedDate: ddState.ddStopActivatedDate ? new Date(ddState.ddStopActivatedDate) : null,
    },
  });
  console.log(`DailyEquitySnapshot saved for ${today}`);

  const yesterday = await prisma.dailyEquitySnapshot.findFirst({
    where: { date: { lt: new Date(today) } },
    orderBy: { date: "desc" },
  });
  const dailyPnl = yesterday ? totalEquity - yesterday.totalEquity : 0;
  await sendSlack({
    text: formatDailySummary({ date: today, openCount: openPositionCount, equity: totalEquity, dailyPnl, events: summaryEvents }),
    level: "info",
  });
}

interface EntryEvaluationDeps {
  alpaca: AlpacaClient;
  prisma: PrismaClient;
  today: string;
  dryRun: boolean;
  spotSpy: number;
  vix: number;
  gspc: number;
  sma50: number | null;
  netLiq: number;
  openPositionCount: number;
  ddState: { ddStopActive: boolean };
  spyContracts: OptionContract[];
  tradingDays: string[];
  summaryEvents: string[];
}

async function evaluateAndPlaceEntry(deps: EntryEvaluationDeps): Promise<void> {
  const {
    alpaca, prisma, today, dryRun, spotSpy, vix, gspc, sma50, netLiq,
    openPositionCount, ddState, spyContracts, tradingDays, summaryEvents,
  } = deps;

  const signal = generateEntrySignal({
    today,
    gspc,
    spotSpy,
    vix,
    smaGspc: sma50,
    cash: netLiq,
    openPositionCount,
    ddStopActive: ddState.ddStopActive,
    tradingDays,
    config: { ...US_CREDIT_SPREAD_DEFAULTS, startDate: today, endDate: today },
  });

  const regime = await getRegimeMultiplier(prisma, today);
  const baseContracts = US_CREDIT_SPREAD_DEFAULTS.contractsPerSpread;
  const finalContracts = scaleContracts(baseContracts, regime.multiplier);
  console.log(
    `Regime: state=${regime.state ?? "(none)"}, multiplier=${regime.multiplier}, ` +
      `contracts ${baseContracts} -> ${finalContracts}`,
  );

  console.log(`Entry signal: ${signal.reason}`);
  await prisma.signalLog.create({
    data: {
      date: new Date(today),
      signalType: "ENTRY",
      reason: signal.reason,
      details: {
        spy: spotSpy,
        vix,
        sma50,
        gspc,
        ddStopActive: ddState.ddStopActive,
        regimeState: regime.state,
        regimeMultiplier: regime.multiplier,
        baseContracts,
        finalContracts,
        ...(signal.reason === "ENTERED" ? {
          shortStrike: signal.shortStrike,
          longStrike: signal.longStrike,
          expirationDate: signal.expirationDate,
          estimatedCredit: signal.estimatedCredit,
        } : {}),
      },
    },
  });

  if (signal.reason !== "ENTERED") return;

  if (finalContracts <= 0) {
    console.log(
      `Skipping entry: regime ${regime.state} reduced contracts to ${finalContracts}`,
    );
    await prisma.signalLog.create({
      data: {
        date: new Date(today),
        signalType: "REGIME_SKIP",
        reason: regime.state ?? "REGIME_UNKNOWN",
        details: {
          baseContracts,
          finalContracts,
          regimeMultiplier: regime.multiplier,
          shortStrike: signal.shortStrike,
          longStrike: signal.longStrike,
        },
      },
    });
    return;
  }

  // ── Strike snap: 理想 strike を Alpaca 実 listing にスナップ ──
  // signal-generator は $1 刻みの BS モデルで strike を選ぶが、Alpaca が
  // その strike を listing していないと 422「asset not found」で reject
  // される。当 expiry の available strike にスナップして発注前に整合させる。
  const chainStrikes = spyContracts
    .filter((c) => c.expiry === signal.expirationDate)
    .map((c) => c.strike);
  const snap = snapStrikesToChain({
    idealShort: signal.shortStrike,
    idealLong: signal.longStrike,
    availableStrikes: chainStrikes,
  });
  if (snap.snappedShort == null || snap.snappedLong == null) {
    console.error(
      `⚠ Strike unavailable at Alpaca: ideal=${signal.shortStrike}/${signal.longStrike} ` +
        `expiry=${signal.expirationDate}, available=[${chainStrikes.slice(0, 10).join(",")}...]`,
    );
    await prisma.signalLog.create({
      data: {
        date: new Date(today),
        signalType: "ENTRY",
        reason: "SKIP_STRIKE_UNAVAILABLE",
        details: {
          idealShort: signal.shortStrike,
          idealLong: signal.longStrike,
          expirationDate: signal.expirationDate,
          availableCount: chainStrikes.length,
        },
      },
    });
    await sendSlack({
      text: `*ENTRY SKIPPED* (SKIP_STRIKE_UNAVAILABLE) — SPY ${signal.expirationDate} で ${signal.shortStrike}/${signal.longStrike} 近傍の strike が Alpaca に無い`,
      level: "warn",
    });
    return;
  }

  // スナップで strike が動いたら BS で credit を再計算（理想と width が変わる可能性あり）
  let shortStrike = snap.snappedShort;
  let longStrike = snap.snappedLong;
  let estimatedCredit = signal.estimatedCredit;
  if (shortStrike !== signal.shortStrike || longStrike !== signal.longStrike) {
    const tte = Math.max(
      (new Date(signal.expirationDate).getTime() - new Date(today).getTime()) / (365 * 86400000),
      1 / 365,
    );
    const iv = (vix / 100) * US_CREDIT_SPREAD_DEFAULTS.ivScaleFactor;
    const sp = bsPutPrice(spotSpy, shortStrike, tte, US_CREDIT_SPREAD_DEFAULTS.riskFreeRate, iv);
    const lp = bsPutPrice(spotSpy, longStrike, tte, US_CREDIT_SPREAD_DEFAULTS.riskFreeRate, iv);
    estimatedCredit = Math.max(0.01, sp - lp);
    console.log(
      `Strike snapped: ${signal.shortStrike}/${signal.longStrike} -> ${shortStrike}/${longStrike} ` +
        `(width ${signal.shortStrike - signal.longStrike} -> ${snap.snappedWidth}, credit ${signal.estimatedCredit.toFixed(2)} -> ${estimatedCredit.toFixed(2)})`,
    );
  }

  // ── 実 quote ベースで limit credit を決定（BS 理論は fallback）──
  // signal-generator は VIX を flat IV とする BS で credit を出すが、OTM put
  // credit spread では skew で real market mid < BS mid になりがちで、その
  // limit のままだと市場が touch せず TIMEOUT する。実 broker quote を見て
  // natural mid - $0.02 で発注するほうが fill 率が高い。
  const expiryYYYYMMDD = signal.expirationDate.replace(/-/g, "");
  const shortOcc = buildOccSymbol("SPY", expiryYYYYMMDD, "P", shortStrike);
  const longOcc = buildOccSymbol("SPY", expiryYYYYMMDD, "P", longStrike);
  let snaps: Awaited<ReturnType<typeof alpaca.getOptionSnapshots>>;
  try {
    snaps = await withRetry(
      () => alpaca.getOptionSnapshots([shortOcc, longOcc]),
      { retries: 2, intervalMs: 3_000 },
    );
  } catch (e: any) {
    console.warn(`⚠ getOptionSnapshots failed: ${e.message ?? e} — falling back to BS theoretical`);
    snaps = new Map();
  }
  const shortSnap = snaps.get(shortOcc) ?? null;
  const longSnap = snaps.get(longOcc) ?? null;
  const pricing = decideLimitCredit({
    shortQuote: shortSnap,
    longQuote: longSnap,
    bsCredit: estimatedCredit,
  });
  await prisma.signalLog.create({
    data: {
      date: new Date(today),
      signalType: "ENTRY_PRICING",
      reason: pricing.source,
      details: {
        shortStrike,
        longStrike,
        expirationDate: signal.expirationDate,
        bsCredit: estimatedCredit,
        quoteCredit: pricing.quoteCredit,
        limit: pricing.limit,
        shortBid: shortSnap?.bid ?? null,
        shortAsk: shortSnap?.ask ?? null,
        longBid: longSnap?.bid ?? null,
        longAsk: longSnap?.ask ?? null,
        shortMid: pricing.shortMid,
        longMid: pricing.longMid,
        midHaircut: 0.02,
      },
    },
  });
  const limitCredit = pricing.limit;
  console.log(
    `Pricing: source=${pricing.source}, bs=$${estimatedCredit.toFixed(2)}, ` +
      `quoteCredit=${pricing.quoteCredit?.toFixed(2) ?? "-"}, limit=$${limitCredit.toFixed(2)}`,
  );

  console.log(`Placing order: SPY ${signal.expirationDate} P ${shortStrike}/${longStrike}, limit ~$${limitCredit.toFixed(2)}, contracts=${finalContracts}`);
  try {
    const placed = await placeNewSpreadOrder(
      alpaca,
      prisma,
      {
        underlying: "SPY",
        shortStrike,
        longStrike,
        expiry: expiryYYYYMMDD,
        contracts: finalContracts,
        estimatedCredit: limitCredit,
      },
      { dryRun },
    );
    console.log(
      `  Order: brokerOrderId=${placed.brokerOrderId}, status=${placed.status}, ` +
        `filledCredit=${placed.filledCredit ?? "-"}` +
        (placed.message ? `, message="${placed.message}"` : ""),
    );
    if (placed.status === "FILLED") {
      summaryEvents.push(formatEntrySuccess({
        shortStrike,
        longStrike,
        expiry: signal.expirationDate,
        filledCredit: placed.filledCredit,
      }));
    } else if (placed.status === "REJECTED") {
      await sendSlack({
        text: formatEntryRejected({
          shortStrike,
          longStrike,
          expiry: signal.expirationDate,
          contracts: finalContracts,
          message: placed.message ?? null,
        }),
        level: "error",
      });
      await prisma.errorLog.create({
        data: {
          category: "ORDER_REJECTED",
          message: placed.message ?? "(no detail)",
          context: {
            shortStrike,
            longStrike,
            expiry: signal.expirationDate,
            contracts: finalContracts,
            brokerOrderId: placed.brokerOrderId,
          },
        },
      });
    } else if (placed.status === "TIMEOUT") {
      await sendSlack({
        text: formatEntryTimeout({
          shortStrike,
          longStrike,
          expiry: signal.expirationDate,
          contracts: finalContracts,
          brokerOrderId: placed.brokerOrderId,
          message: placed.message ?? null,
        }),
        level: "warn",
      });
    }
  } catch (e: any) {
    console.error(`  ❌ Order failed: ${e.message}`);
    await prisma.errorLog.create({
      data: {
        category: "ORDER_FAILED",
        message: e.message,
        context: { signal: { reason: signal.reason } },
      },
    });
    const isDuplicate = /Duplicate/i.test(e.message);
    await sendSlack({
      text: isDuplicate ? formatDuplicateOrder(e.message) : formatErrorAlert("ORDER_FAILED", e.message),
      level: isDuplicate ? "critical" : "error",
    });
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Daily runner start (dry-run=${DRY_RUN})`);

  if (isKillSwitchActive()) {
    const info = getKillSwitchInfo();
    console.log(`⏸ Kill switch active: ${info.reason} (since ${info.createdAt?.toISOString()})`);
    await sendSlack({ text: formatKillSwitch(info.reason ?? "(no reason)"), level: "warn" });
    process.exit(0);
  }

  const prisma = new PrismaClient();
  const alpaca = new AlpacaClient({
    apiKey: requireEnv("ALPACA_API_KEY"),
    apiSecret: requireEnv("ALPACA_API_SECRET"),
    baseUrl: requireEnv("ALPACA_API_ENDPOINT"),
    dataUrl: process.env.ALPACA_DATA_ENDPOINT,
  });

  try {
    await runDailyCycle({
      alpaca,
      prisma,
      today: dayjs().format("YYYY-MM-DD"),
      dryRun: DRY_RUN,
    });
  } finally {
    await prisma.$disconnect();
    const elapsed = Date.now() - startTime.getTime();
    console.log(`[${new Date().toISOString()}] Daily runner end (elapsed ${elapsed}ms)`);
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error("❌ Daily runner failed:", e?.message ?? e);
      if (e?.stack) console.error(e.stack);
      try {
        const prisma = new PrismaClient();
        await prisma.errorLog.create({
          data: {
            category: "UNCAUGHT_EXCEPTION",
            message: String(e?.message ?? e),
            context: { stack: e?.stack ?? null },
          },
        });
        await prisma.$disconnect();
      } catch (logErr) {
        console.error("Failed to write ErrorLog:", logErr);
      }
      try {
        await sendSlack({
          text: formatErrorAlert("UNCAUGHT_EXCEPTION", String(e?.message ?? e)),
          level: "critical",
        });
      } catch {}
      process.exit(1);
    });
}
