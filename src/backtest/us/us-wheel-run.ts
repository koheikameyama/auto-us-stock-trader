/**
 * Wheel 戦略バックテスト CLI 実行エントリーポイント
 *
 * Usage:
 *   npx tsx src/backtest/us/us-wheel-run.ts
 *   npx tsx src/backtest/us/us-wheel-run.ts --start 2024-01-01 --end 2025-12-31 --verbose
 *   npx tsx src/backtest/us/us-wheel-run.ts --budget 5000
 */

import dayjs from "dayjs";
import { US_WHEEL_DEFAULTS } from "./us-wheel-config";
import { runUSWheelBacktest } from "./us-wheel-simulation";
import {
  getUSTickerCodes,
  fetchUSHistoricalFromDB,
  fetchSP500FromDB,
  fetchVixFromDB,
} from "./us-data-fetcher";
import type { USWheelBacktestConfig } from "./us-wheel-types";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const startDate =
    getArg("start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD");
  const verbose = args.includes("--verbose");
  const budget = getArg("budget")
    ? Number(getArg("budget"))
    : US_WHEEL_DEFAULTS.initialBudget;

  const config: USWheelBacktestConfig = {
    ...US_WHEEL_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    verbose,
  };

  console.log("=".repeat(60));
  console.log("Wheel Strategy Backtest - US");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);
  console.log(`Max Wheel Positions: ${config.maxWheelPositions}`);
  console.log(
    `Put Delta: ${config.putDelta} | Call Delta: ${config.callDelta} | DTE: ${config.dte} | Profit Target: ${(config.profitTarget * 100).toFixed(0)}%`,
  );
  console.log();

  // データ取得
  console.log("Loading data...");
  const tickers = await getUSTickerCodes();
  console.log(`  US tickers: ${tickers.length}`);

  const [allData, vixData, indexData] = await Promise.all([
    fetchUSHistoricalFromDB(tickers, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchSP500FromDB(startDate, endDate),
  ]);

  console.log(`  Stocks with data: ${allData.size}`);
  console.log(`  VIX data: ${vixData.size} days`);
  console.log(`  S&P 500 data: ${indexData.size} days`);
  console.log();

  // バックテスト実行
  console.log("Running Wheel backtest...");
  const result = runUSWheelBacktest(config, allData, vixData, indexData);

  // 結果表示
  const m = result.metrics;
  console.log();
  console.log("=".repeat(60));
  console.log("Results");
  console.log("=".repeat(60));

  // Wheel固有メトリクス
  console.log(`Completed Cycles: ${m.completedCycles}`);
  console.log(
    `CSPs Sold: ${m.cspCount} | Assigned: ${m.assignmentRate.toFixed(1)}%`,
  );
  console.log(
    `CCs Sold: ${m.ccCount} | Called Away: ${m.calledAwayRate.toFixed(1)}%`,
  );
  console.log(`Early Close Rate: ${m.earlyCloseRate.toFixed(1)}%`);
  console.log();
  console.log(
    `Total Premium Collected: $${m.totalPremiumCollected.toFixed(2)}`,
  );
  console.log(
    `Avg Premium Yield (Annualized): ${m.avgPremiumYieldAnnualized.toFixed(1)}%`,
  );
  console.log(`Avg Cycle Duration: ${m.avgCycleDays.toFixed(1)} days`);
  console.log();

  // 標準メトリクス
  console.log(`Total Trades: ${m.totalTrades}`);
  console.log(
    `Wins: ${m.wins} | Losses: ${m.losses} | Still Open: ${m.stillOpen}`,
  );
  console.log(`Win Rate: ${m.winRate.toFixed(1)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(
    `Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`,
  );
  console.log(`Risk/Reward: ${m.riskRewardRatio.toFixed(2)}`);
  console.log(
    `Avg Win: +${m.avgWinPct.toFixed(2)}% | Avg Loss: ${m.avgLossPct.toFixed(2)}%`,
  );
  console.log(`Max Drawdown: ${m.maxDrawdown.toFixed(1)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio?.toFixed(2) ?? "N/A"}`);
  console.log();
  console.log(`Gross P&L: $${m.totalGrossPnl.toFixed(2)}`);
  console.log(`Total Cost: $${m.totalCommission.toFixed(2)}`);
  console.log(`Net P&L: $${m.totalNetPnl.toFixed(2)}`);
  console.log(`Net Return: ${m.netReturnPct.toFixed(1)}%`);

  // Verbose: サイクルログ
  if (verbose && result.cycles.length > 0) {
    console.log();
    console.log("-- Cycle Log --");
    for (const c of result.cycles) {
      const pnlStr =
        c.cyclePnl != null
          ? `$${c.cyclePnl >= 0 ? "+" : ""}${c.cyclePnl.toFixed(2)}`
          : "open";
      const days = c.cycleEndDate
        ? daysBetween(c.cycleStartDate, c.cycleEndDate)
        : "?";
      const phases: string[] = [];
      if (c.csp) phases.push(`CSP@$${c.csp.strike.toFixed(2)}→${c.csp.closeReason ?? "open"}`);
      if (c.stockCostBasis != null) phases.push(`STOCK@$${c.stockCostBasis.toFixed(2)}`);
      for (const cc of c.ccHistory) {
        phases.push(`CC@$${cc.strike.toFixed(2)}→${cc.closeReason ?? "open"}`);
      }
      if (c.cc) phases.push(`CC@$${c.cc.strike.toFixed(2)}→${c.cc.closeReason ?? "open"}`);

      console.log(
        `  ${c.cycleStartDate} ~ ${c.cycleEndDate ?? "?"} | ${c.ticker.padEnd(5)} | ${pnlStr.padStart(8)} | ${String(days).padStart(3)}d | ${phases.join(" → ")}`,
      );
    }
  }

  process.exit(0);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
