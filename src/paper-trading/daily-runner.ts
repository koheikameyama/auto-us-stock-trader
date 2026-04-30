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
import { US_CREDIT_SPREAD_DEFAULTS } from "../backtest/us/us-credit-spread-config";
import type { SimulatedSpread } from "../backtest/us/us-credit-spread-types";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Daily runner start (dry-run=${DRY_RUN})`);

  // ── 1. kill switch チェック ──
  if (isKillSwitchActive()) {
    const info = getKillSwitchInfo();
    console.log(`⏸ Kill switch active: ${info.reason} (since ${info.createdAt?.toISOString()})`);
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

    if (action.action === "CLOSE" || action.action === "EXPIRE") {
      // 仮で SignalLog だけ記録（実発注は Phase D 以降で）
      await prisma.signalLog.create({
        data: {
          date: new Date(today),
          signalType: "CLOSE",
          reason: action.reason,
          details: {
            shortStrike: dbPos.shortStrike,
            longStrike: dbPos.longStrike,
            currentValue: (action as any).currentValue ?? null,
            finalValue: (action as any).finalValue ?? null,
          },
        },
      });
    }
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

  // TODO: ステップ 7-9 を次タスクで追加

  await ibkr.disconnect();
  await prisma.$disconnect();

  const elapsed = Date.now() - startTime.getTime();
  console.log(`[${new Date().toISOString()}] Daily runner end (elapsed ${elapsed}ms)`);
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("❌ Daily runner failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
