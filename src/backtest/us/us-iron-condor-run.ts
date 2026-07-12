/**
 * SPY Iron Condor バックテスト CLI
 *
 * Usage:
 *   npx tsx src/backtest/us/us-iron-condor-run.ts
 *   npx tsx src/backtest/us/us-iron-condor-run.ts --start 2007-01-03 --end 2026-04-28 --verbose
 *   npx tsx src/backtest/us/us-iron-condor-run.ts --call-slope 4.05 --put-slope 6.30
 */

import dayjs from "dayjs";
import { US_IRON_CONDOR_DEFAULTS, US_IRON_CONDOR_BACKTEST_FIDELITY } from "./us-iron-condor-config";
import { runUSIronCondorBacktest } from "./us-iron-condor-simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "./us-data-fetcher";
import { fetchRegimeFromDB } from "./regime-fetcher";
import { fetchEventsFromDB, type EventType } from "./event-fetcher";
import type { USIronCondorBacktestConfig } from "./us-iron-condor-types";

const VALID_EVENT_TYPES: EventType[] = ["FOMC", "CPI", "NFP", "PPI"];

function parseEventTypes(raw: string): EventType[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is EventType => (VALID_EVENT_TYPES as string[]).includes(s));
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg("start") ?? dayjs(endDate).subtract(24, "month").format("YYYY-MM-DD");
  const verbose = args.includes("--verbose");
  const useRegime = args.includes("--use-regime");
  const eventAwareEnabled = args.includes("--event-aware");
  const eventWindow = getArg("event-window") ? Number(getArg("event-window")) : 1;
  const eventSkipTypes = parseEventTypes(getArg("event-skip-types") ?? "FOMC");
  const budget = getArg("budget") ? Number(getArg("budget")) : US_IRON_CONDOR_DEFAULTS.initialBudget;
  const dte = getArg("dte") ? Number(getArg("dte")) : US_IRON_CONDOR_DEFAULTS.dte;
  const shortDelta = getArg("short-delta") ? Number(getArg("short-delta")) : US_IRON_CONDOR_DEFAULTS.shortDelta;
  const spreadWidth = getArg("spread-width") ? Number(getArg("spread-width")) : US_IRON_CONDOR_DEFAULTS.spreadWidth;
  const profitTarget = getArg("profit-target") ? Number(getArg("profit-target")) : US_IRON_CONDOR_DEFAULTS.profitTarget;
  const creditScale = getArg("credit-scale") ? Number(getArg("credit-scale")) : (US_IRON_CONDOR_DEFAULTS.creditScale ?? 1);
  const putSlope = getArg("put-slope") ? Number(getArg("put-slope")) : US_IRON_CONDOR_BACKTEST_FIDELITY.putSkewSlope;
  const callSlope = getArg("call-slope") ? Number(getArg("call-slope")) : US_IRON_CONDOR_BACKTEST_FIDELITY.callSkewSlope;

  const config: USIronCondorBacktestConfig = {
    ...US_IRON_CONDOR_DEFAULTS,
    ...US_IRON_CONDOR_BACKTEST_FIDELITY,
    startDate,
    endDate,
    initialBudget: budget,
    dte,
    shortDelta,
    spreadWidth,
    profitTarget,
    creditScale,
    putSkewSlope: putSlope,
    callSkewSlope: callSlope,
    verbose,
  };

  console.log("=".repeat(60));
  console.log("SPY Iron Condor Backtest - US (put + bear call)");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);
  console.log(`Underlying: ${config.underlyingSymbol} (^GSPC ÷ 10 proxy)`);
  console.log(`Short Delta: ±${config.shortDelta} | Spread Width: $${config.spreadWidth} | DTE: ${config.dte}`);
  console.log(`Skew slope: put=${config.putSkewSlope} / call=${config.callSkewSlope} | Slippage: $${config.entrySlippage}/leg`);
  console.log(`Credit Scale: ${(config.creditScale ?? 1).toFixed(3)} (1.0 = BS理論どおり)`);
  console.log(`Profit Target: ${(config.profitTarget * 100).toFixed(0)}% | StopLoss Mult: ${config.stopLossMultiplier || "OFF"}`);
  console.log(`Max Positions: ${config.maxPositions} | Contracts/Condor: ${config.contractsPerCondor} (片側 collateral)`);
  console.log(`VIX cap: ${config.vixCap} | Index trend SMA: ${config.indexTrendSmaPeriod}`);
  console.log(`Regime filter: ${useRegime ? "ON (RISK_OFF=skip, NEUTRAL=1x, RISK_ON=1.5x)" : "OFF"}`);
  console.log(
    `Event-aware filter: ${
      eventAwareEnabled ? `ON (skip ±${eventWindow}d around ${eventSkipTypes.join(",")})` : "OFF"
    }`,
  );

  console.log("\nLoading data...");
  const gspcData = await fetchSP500FromDB(startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  console.log(`  ^GSPC: ${gspcData.size} days`);
  console.log(`  VIX: ${vixData.size} days`);
  const regimeData = useRegime ? await fetchRegimeFromDB(startDate, endDate) : undefined;
  if (regimeData) console.log(`  RegimeSignal: ${regimeData.size} days`);
  const eventCalendar = eventAwareEnabled
    ? await fetchEventsFromDB(
        dayjs(startDate).subtract(eventWindow + 5, "day").format("YYYY-MM-DD"),
        dayjs(endDate).add(eventWindow + 5, "day").format("YYYY-MM-DD"),
        eventSkipTypes,
      )
    : undefined;
  if (eventCalendar) {
    const totalEvents = [...eventCalendar.values()].reduce((s, list) => s + list.length, 0);
    console.log(`  MacroEvent: ${totalEvents} events (${eventCalendar.size} unique dates)`);
  }

  console.log("\nRunning backtest...");
  const result = await runUSIronCondorBacktest(
    config,
    gspcData,
    vixData,
    regimeData,
    eventCalendar,
    eventAwareEnabled ? { windowDays: eventWindow, skipTypes: eventSkipTypes } : undefined,
  );
  const m = result.metrics;

  console.log("\n" + "=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));
  console.log(`Total Condors: ${m.totalCondors}`);
  console.log(`  Expired Worthless: ${m.expiredWorthless} (max win)`);
  console.log(`  Profit Target Hits: ${m.profitTargetHits} (early close)`);
  console.log(`  Stop Loss Hits: ${m.stopLossHits}`);
  console.log(`  Expired Partial: ${m.totalCondors - m.expiredWorthless - m.profitTargetHits - m.stopLossHits - m.maxLossCount}`);
  console.log(`  Max Loss: ${m.maxLossCount}`);
  console.log(`Win Rate: ${m.winRate.toFixed(2)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`Avg Holding Days: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`Avg Credit Ratio: ${(m.avgCreditRatio * 100).toFixed(1)}% of width`);
  console.log(`Total Credit Received: $${m.totalCreditReceived.toFixed(2)}`);
  console.log(`Max Drawdown: ${m.maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio?.toFixed(2) ?? "N/A"}`);
  console.log("");
  console.log(`Gross P&L: $${m.totalGrossPnl.toFixed(2)}`);
  console.log(`Total Cost: $${m.totalCommission.toFixed(2)}`);
  console.log(`Net P&L: $${m.totalNetPnl.toFixed(2)}`);
  console.log(`Net Return: ${m.netReturnPct.toFixed(2)}%`);

  if (useRegime) {
    const closedByRegime: Record<string, { trades: number; wins: number; netPnl: number }> = {};
    for (const c of result.condors) {
      if (c.state !== "CLOSED") continue;
      const key = c.regime ?? "(unknown)";
      if (!closedByRegime[key]) closedByRegime[key] = { trades: 0, wins: 0, netPnl: 0 };
      closedByRegime[key].trades++;
      if ((c.netPnl ?? 0) > 0) closedByRegime[key].wins++;
      closedByRegime[key].netPnl += c.netPnl ?? 0;
    }
    const order = ["RISK_ON", "NEUTRAL", "RISK_OFF"];
    const regimes = Object.keys(closedByRegime).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    if (regimes.length > 0) {
      console.log("\n" + "=".repeat(60));
      console.log("Per-Regime Breakdown (Risk-on/off)");
      console.log("=".repeat(60));
      for (const rg of regimes) {
        const s = closedByRegime[rg];
        const winRate = s.trades > 0 ? (s.wins / s.trades) * 100 : 0;
        const avgNet = s.trades > 0 ? s.netPnl / s.trades : 0;
        console.log(
          `  ${rg.padEnd(10)} trades=${String(s.trades).padStart(4)} | ` +
            `winRate=${winRate.toFixed(2).padStart(6)}% | ` +
            `netPnl=$${s.netPnl.toFixed(2).padStart(10)} | avgNet=$${avgNet.toFixed(2)}`,
        );
      }
    }
  }

  if (eventAwareEnabled) {
    const skips = result.eventSkips;
    console.log("\n" + "=".repeat(60));
    console.log("Per-Event Skip Breakdown");
    console.log("=".repeat(60));
    if (skips.length === 0) {
      console.log("  (no entries skipped — try widening --event-window)");
    } else {
      const byType: Record<string, number> = {};
      for (const s of skips) byType[s.eventType] = (byType[s.eventType] ?? 0) + 1;
      for (const t of Object.keys(byType).sort()) {
        console.log(`  ${t.padEnd(6)} skips=${String(byType[t]).padStart(4)}`);
      }
      console.log(`  ${"TOTAL".padEnd(6)} skips=${String(skips.length).padStart(4)}`);
    }
  }

  if (verbose && result.condors.length > 0) {
    console.log("\n" + "=".repeat(60));
    console.log("Trade Log (last 30)");
    console.log("=".repeat(60));
    result.condors.slice(-30).forEach((c) => {
      console.log(
        `  ${c.entryDate} -> ${c.closeDate ?? "OPEN"} | putK=${c.putShortStrike}/${c.putLongStrike} callK=${c.callShortStrike}/${c.callLongStrike} | ` +
          `credit=$${c.creditReceived.toFixed(2)} | reason=${c.closeReason ?? "open"} | pnl=$${c.netPnl?.toFixed(2) ?? "-"}`,
      );
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
