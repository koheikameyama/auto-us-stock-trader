/**
 * PEAD バックテスト CLI 実行エントリーポイント
 *
 * Usage:
 *   npx tsx src/backtest/us/us-pead-run.ts
 *   npx tsx src/backtest/us/us-pead-run.ts --start 2024-01-01 --end 2025-12-31 --verbose
 */

import dayjs from "dayjs";
import { US_PEAD_DEFAULTS } from "./us-pead-config";
import { runUSPeadBacktest } from "./us-pead-simulation";
import { getUSTickerCodes, fetchUSHistoricalFromDB, fetchSP500FromDB, fetchVixFromDB, fetchUSEarningsFromDB } from "./us-data-fetcher";
import type { USPeadBacktestConfig } from "./us-types";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const startDate = getArg("start") ?? dayjs(endDate).subtract(12, "month").format("YYYY-MM-DD");
  const verbose = args.includes("--verbose");
  const budget = getArg("budget") ? Number(getArg("budget")) : US_PEAD_DEFAULTS.initialBudget;

  const config: USPeadBacktestConfig = {
    ...US_PEAD_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    verbose,
  };

  console.log("=" .repeat(60));
  console.log("PEAD (Post-Earnings Announcement Drift) Backtest - US");
  console.log("=" .repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);
  console.log(`Max Positions: ${config.maxPositions}`);
  console.log();

  // データ取得
  console.log("Loading data...");
  const tickers = await getUSTickerCodes();
  console.log(`  US tickers: ${tickers.length}`);

  const [allData, vixData, indexData, earningsData] = await Promise.all([
    fetchUSHistoricalFromDB(tickers, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchSP500FromDB(startDate, endDate),
    fetchUSEarningsFromDB(tickers, startDate, endDate),
  ]);

  const tickersWithEarnings = [...earningsData.keys()].length;
  const totalEarningsDates = [...earningsData.values()].reduce((sum, s) => sum + s.size, 0);
  console.log(`  Stocks with data: ${allData.size}`);
  console.log(`  Stocks with earnings: ${tickersWithEarnings}`);
  console.log(`  Total earnings dates: ${totalEarningsDates}`);
  console.log(`  VIX data: ${vixData.size} days`);
  console.log(`  S&P 500 data: ${indexData.size} days`);
  console.log();

  // バックテスト実行
  console.log("Running PEAD backtest...");
  const result = runUSPeadBacktest(config, allData, earningsData, vixData, indexData);

  // 結果表示
  const m = result.metrics;
  console.log();
  console.log("=" .repeat(60));
  console.log("Results");
  console.log("=" .repeat(60));
  console.log(`Total Trades: ${m.totalTrades}`);
  console.log(`Wins: ${m.wins} | Losses: ${m.losses} | Still Open: ${m.stillOpen}`);
  console.log(`Win Rate: ${(m.winRate * 100).toFixed(1)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Expectancy: ${m.expectancy >= 0 ? "+" : ""}${m.expectancy.toFixed(2)}%`);
  console.log(`Risk/Reward: ${m.riskRewardRatio.toFixed(2)}`);
  console.log(`Avg Win: +${m.avgWinPct.toFixed(2)}% | Avg Loss: ${m.avgLossPct.toFixed(2)}%`);
  console.log(`Avg Holding Days: ${m.avgHoldingDays.toFixed(1)}`);
  console.log(`Max Drawdown: ${(m.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio?.toFixed(2) ?? "N/A"}`);
  console.log();
  console.log(`Gross P&L: $${m.totalGrossPnl.toFixed(2)}`);
  console.log(`Total Cost: $${m.totalCommission.toFixed(2)}`);
  console.log(`Net P&L: $${m.totalNetPnl.toFixed(2)}`);
  console.log(`Net Return: ${m.netReturnPct.toFixed(1)}%`);

  if (verbose && result.trades.length > 0) {
    console.log();
    console.log("── Trade Log ──");
    for (const t of result.trades) {
      if (t.exitReason === "still_open") continue;
      console.log(
        `  ${t.entryDate} → ${t.exitDate} | ${t.ticker.padEnd(5)} | $${t.entryPrice.toFixed(2)} → $${t.exitPrice?.toFixed(2)} | ${t.exitReason?.padEnd(15)} | ${(t.pnlPct ?? 0) >= 0 ? "+" : ""}${(t.pnlPct ?? 0).toFixed(1)}% | ${t.holdingDays}d`,
      );
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
