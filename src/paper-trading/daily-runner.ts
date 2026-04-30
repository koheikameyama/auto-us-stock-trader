// src/paper-trading/daily-runner.ts
/**
 * IBKR Paper Trading 日次実行
 *
 * Usage:
 *   npx tsx src/paper-trading/daily-runner.ts                 # 通常実行
 *   npx tsx src/paper-trading/daily-runner.ts --dry-run        # 発注スキップ
 */

import dayjs from "dayjs";
import { PrismaClient } from "@prisma/client";
import { IBKRClient } from "./ibkr-client";
import { isKillSwitchActive, getKillSwitchInfo } from "./kill-switch";
import { reconcilePositions } from "./position-syncer";
import { evaluateSpread } from "../backtest/credit-spread/spread-evaluator";
import { calcDDStopState } from "../backtest/credit-spread/dd-stop";
import { generateEntrySignal } from "../backtest/credit-spread/signal-generator";
import { US_CREDIT_SPREAD_DEFAULTS } from "../backtest/us/us-credit-spread-config";
import type { SimulatedSpread } from "../backtest/us/us-credit-spread-types";
import { fetchIndexFromDB } from "../backtest/data-fetcher";
import { placeNewSpreadOrder, closeSpreadOrder, expirePosition } from "./order-manager";
import {
  sendSlack,
  formatEntrySuccess, formatEntrySkip, formatCloseSuccess, formatExpire,
  formatDDStop, formatDailySummary, formatErrorAlert, formatKillSwitch, formatDuplicateOrder,
} from "./slack-notifier";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Daily runner start (dry-run=${DRY_RUN})`);

  // ── 1. kill switch チェック ──
  if (isKillSwitchActive()) {
    const info = getKillSwitchInfo();
    console.log(`⏸ Kill switch active: ${info.reason} (since ${info.createdAt?.toISOString()})`);
    await sendSlack({ text: formatKillSwitch(info.reason ?? "(no reason)"), level: "warn" });
    process.exit(0);
  }

  const prisma = new PrismaClient();
  const ibkr = new IBKRClient({ clientId: 100 });

  // ── 2. IBKR 接続 + アカウント情報 ──
  console.log("Connecting to IBKR TWS...");
  await ibkr.connect();
  const accountSummary = await ibkr.getAccountSummary();
  console.log(`Account: NetLiq=$${accountSummary.netLiquidation.toLocaleString()}, BP=$${accountSummary.buyingPower.toLocaleString()}`);

  // ── 3. 既存ポジション同期 ──
  console.log("Reconciling positions...");
  const { mismatches, ibkrLegs, dbOpenPositions } = await reconcilePositions(ibkr, prisma);
  console.log(`  IBKR active legs: ${ibkrLegs.length}`);
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

  // ── 4. live data 取得 (SPY / VIX) ──
  console.log("Fetching market data...");
  const spy = await ibkr.getMarketPrice("SPY");
  if (spy.last == null) {
    console.error("⚠ SPY price unavailable, skipping today's cycle");
    await ibkr.disconnect();
    await prisma.$disconnect();
    return;
  }
  let vix: number;
  try {
    vix = await ibkr.getVIX();
  } catch {
    console.error("⚠ VIX unavailable, skipping today's cycle");
    await ibkr.disconnect();
    await prisma.$disconnect();
    return;
  }
  const spotSpy = spy.last;
  const gspc = spotSpy * 10;
  console.log(`  SPY=${spotSpy}, VIX=${vix.toFixed(2)}, gspc=${gspc}`);

  // ── 5. 既存スプレッドの evaluateSpread ──
  const today = dayjs().format("YYYY-MM-DD");
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
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would close: reason=${action.reason}, value=${action.currentValue}`);
      } else {
        try {
          const closed = await closeSpreadOrder(ibkr, prisma, {
            positionId: dbPos.id,
            reason: action.reason,
            currentSpreadValue: action.currentValue,
          });
          console.log(`  Closed ibkrOrderId=${closed.ibkrOrderId}, status=${closed.status}`);
          if (closed.status === "FILLED") {
            const daysHeld = Math.floor((Date.now() - dbPos.entryDate.getTime()) / 86400000);
            const updated = await prisma.position.findUnique({ where: { id: dbPos.id } });
            await sendSlack({
              text: formatCloseSuccess({
                shortStrike: dbPos.shortStrike,
                longStrike: dbPos.longStrike,
                reason: action.reason,
                netPnl: updated?.netPnl ?? null,
                daysHeld,
              }),
              level: "info",
            });
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
      await expirePosition(prisma, {
        positionId: dbPos.id,
        reason: action.reason,
        finalValue: action.finalValue,
      });
      console.log(`  Expired: reason=${action.reason}, value=${action.finalValue}`);
      const updated = await prisma.position.findUnique({ where: { id: dbPos.id } });
      await sendSlack({
        text: formatExpire({
          shortStrike: dbPos.shortStrike,
          longStrike: dbPos.longStrike,
          reason: action.reason,
          netPnl: updated?.netPnl ?? null,
        }),
        level: "info",
      });
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

  // ── 6. equity 計算 + DD stop 状態遷移 ──
  const netLiq = accountSummary.netLiquidation;
  const positionsValue = 0;  // 簡易、Phase D 以降で詳細化
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
  // SMA50 計算: DB の ^GSPC 過去 50 日 close から
  const lookbackEnd = today;
  const lookbackStart = dayjs(today).subtract(75, "day").format("YYYY-MM-DD");
  const gspcHistorical = await fetchIndexFromDB("^GSPC", lookbackStart, lookbackEnd, 0);
  const sortedDates = [...gspcHistorical.keys()].sort().slice(-50);
  const sma50 = sortedDates.length === 50
    ? sortedDates.reduce((sum, d) => sum + (gspcHistorical.get(d) ?? 0), 0) / 50
    : null;
  console.log(`SMA50(GSPC) = ${sma50?.toFixed(2) ?? "(unavailable)"}`);

  // tradingDays: 簡易にカレンダー日（weekday）を生成
  const tradingDays: string[] = [];
  for (let i = 0; i < 100; i++) {
    const d = dayjs(today).add(i, "day");
    const dow = d.day();
    if (dow !== 0 && dow !== 6) tradingDays.push(d.format("YYYY-MM-DD"));
  }

  // 信号生成
  const signal = generateEntrySignal({
    today,
    gspc,
    spotSpy,
    vix,
    smaGspc: sma50,
    cash: netLiq,
    openPositionCount: dbOpenSpreads.length,
    ddStopActive: ddState.ddStopActive,
    tradingDays,
    config: { ...US_CREDIT_SPREAD_DEFAULTS, startDate: today, endDate: today },
  });

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
        ...(signal.reason === "ENTERED" ? {
          shortStrike: signal.shortStrike,
          longStrike: signal.longStrike,
          expirationDate: signal.expirationDate,
          estimatedCredit: signal.estimatedCredit,
        } : {}),
      },
    },
  });

  if (signal.reason !== "ENTERED") {
    await sendSlack({
      text: formatEntrySkip(signal.reason, { spy: spotSpy, vix, sma50 }),
      level: "info",
    });
  }

  if (signal.reason === "ENTERED") {
    console.log(`Placing order: SPY ${signal.expirationDate} P ${signal.shortStrike}/${signal.longStrike}, credit ~$${signal.estimatedCredit.toFixed(2)}`);
    const expiryYYYYMMDD = signal.expirationDate.replace(/-/g, "");
    try {
      const placed = await placeNewSpreadOrder(
        ibkr,
        prisma,
        {
          underlying: "SPY",
          shortStrike: signal.shortStrike,
          longStrike: signal.longStrike,
          expiry: expiryYYYYMMDD,
          contracts: US_CREDIT_SPREAD_DEFAULTS.contractsPerSpread,
          estimatedCredit: signal.estimatedCredit,
        },
        { dryRun: DRY_RUN },
      );
      console.log(`  Order: ibkrOrderId=${placed.ibkrOrderId}, status=${placed.status}, filledCredit=${placed.filledCredit ?? "-"}`);
      if (placed.status === "FILLED") {
        await sendSlack({
          text: formatEntrySuccess({
            shortStrike: signal.shortStrike,
            longStrike: signal.longStrike,
            expiry: signal.expirationDate,
            filledCredit: placed.filledCredit,
          }),
          level: "info",
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

  // ── 8. DailyEquitySnapshot を保存 ──
  await prisma.dailyEquitySnapshot.upsert({
    where: { date: new Date(today) },
    create: {
      date: new Date(today),
      cash: netLiq,
      positionsValue,
      totalEquity,
      openPositionCount: dbOpenSpreads.length,
      ddStopActive: ddState.ddStopActive,
      runningPeak: ddState.runningPeak,
      ddStopActivatedDate: ddState.ddStopActivatedDate ? new Date(ddState.ddStopActivatedDate) : null,
    },
    update: {
      cash: netLiq,
      positionsValue,
      totalEquity,
      openPositionCount: dbOpenSpreads.length,
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
    text: formatDailySummary({ date: today, openCount: dbOpenSpreads.length, equity: totalEquity, dailyPnl }),
    level: "info",
  });

  await ibkr.disconnect();
  await prisma.$disconnect();

  const elapsed = Date.now() - startTime.getTime();
  console.log(`[${new Date().toISOString()}] Daily runner end (elapsed ${elapsed}ms)`);
}

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
