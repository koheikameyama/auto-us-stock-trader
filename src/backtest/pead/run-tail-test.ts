import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_PEAD_DEFAULTS } from "../us/us-pead-config";
import { runUSPeadBacktest } from "../us/us-pead-simulation";
import {
  getUSTickerCodes,
  fetchUSHistoricalFromDB,
  fetchSP500FromDB,
  fetchVixFromDB,
  fetchUSEarningsFromDB,
} from "../us/us-data-fetcher";
import type { USPeadBacktestConfig } from "../us/us-types";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics, calculateVixBuckets } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import type { TailTestResult } from "../framework/tail-test/types";
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { PEAD_THRESHOLDS } from "./tail-test-thresholds";

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const startDate = getArg("start") ?? "2015-01-01";
  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const stepLabel = getArg("label");
  const suffix = stepLabel ? `-${stepLabel}` : "";
  const budget = getArg("budget")
    ? Number(getArg("budget"))
    : US_PEAD_DEFAULTS.initialBudget;

  const config: USPeadBacktestConfig = {
    ...US_PEAD_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("PEAD Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);

  console.log("\nLoading data...");
  const tickers = await getUSTickerCodes();
  const [allData, vixData, indexData, earningsData] = await Promise.all([
    fetchUSHistoricalFromDB(tickers, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchSP500FromDB(startDate, endDate),
    fetchUSEarningsFromDB(tickers, startDate, endDate),
  ]);
  const tickersWithEarnings = [...earningsData.keys()].length;
  const totalEarningsDates = [...earningsData.values()].reduce((sum, s) => sum + s.size, 0);
  console.log(`  US tickers: ${tickers.length}`);
  console.log(`  Stocks with data: ${allData.size}`);
  console.log(`  Stocks with earnings: ${tickersWithEarnings}`);
  console.log(`  Total earnings dates: ${totalEarningsDates}`);
  console.log(`  VIX data: ${vixData.size} days`);
  console.log(`  S&P 500 data: ${indexData.size} days`);

  console.log("\nRunning simulation...");
  const result = runUSPeadBacktest(config, allData, earningsData, vixData, indexData);

  // ── SimulatedPosition[] → Trade 直接変換 ──
  const trades: Trade[] = result.trades
    .filter((t) => t.exitDate != null && t.netPnl != null)
    .map((t) => ({
      symbol: t.ticker,
      entryDate: t.entryDate,
      closeDate: t.exitDate ?? null,
      netPnl: t.netPnl ?? null,
      pnlPct: t.pnlPct ?? null,
      holdingDays: t.holdingDays ?? null,
      category: t.exitReason ?? undefined,
    }));

  // ── StrategyResult 構築 ──
  const initial = config.initialBudget;
  const finalEq = result.equityCurve[result.equityCurve.length - 1]?.totalEquity ?? initial;
  const years = result.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;

  const strategyResult: StrategyResult = {
    strategyName: "pead",
    config: { ...config },
    period: { start: startDate, end: endDate },
    initialBudget: initial,
    equityCurve: result.equityCurve,
    trades,
    metrics: {
      winRate: result.metrics.winRate / 100,
      profitFactor: result.metrics.profitFactor,
      maxDrawdown: result.metrics.maxDrawdown / 100,
      netReturnPct: result.metrics.netReturnPct / 100,
    },
  };

  // ── tail-test 共通処理 ──
  const ddPeriods = extractDDPeriods(strategyResult.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) =>
    analyzeWindow(w, strategyResult.equityCurve, strategyResult.trades),
  );
  const tailMetrics = calculateTailMetrics(strategyResult.trades, strategyResult.equityCurve);
  const tradingDays = strategyResult.equityCurve.map((e) => e.date);
  const vixBuckets = calculateVixBuckets(tradingDays, vixData, strategyResult.trades);

  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD =
    available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct =
    available.length === 0 ? null : Math.min(...available.map((w) => w.pnlPct));

  // PEAD の per-trade 最大損失（USD）: initialBudget × maxLossPct を 1 trade 上限の代用とする
  const maxLossDollar = initial * config.maxLossPct;

  const verdict = evaluateThresholds({
    winRate: strategyResult.metrics.winRate,
    profitFactor: strategyResult.metrics.profitFactor,
    cagr,
    maxDrawdown: strategyResult.metrics.maxDrawdown,
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    maxLossDollar,
    thresholds: PEAD_THRESHOLDS,
  });

  const tailResult: TailTestResult = {
    configSummary: {
      strategy: "pead",
      gapMinPct: config.gapMinPct,
      volSurgeRatio: config.volSurgeRatio,
      atrMultiplier: config.atrMultiplier,
      maxLossPct: config.maxLossPct,
      maxHoldingDays: config.maxHoldingDays,
      maxExtendedHoldingDays: config.maxExtendedHoldingDays,
      maxPositions: config.maxPositions,
      cooldownDays: config.cooldownDays,
      initialBudget: config.initialBudget,
    },
    startDate: strategyResult.period.start,
    endDate: strategyResult.period.end,
    totalTrades: strategyResult.trades.length,
    baseMetrics: {
      winRate: strategyResult.metrics.winRate,
      profitFactor: strategyResult.metrics.profitFactor,
      cagr,
      maxDrawdown: strategyResult.metrics.maxDrawdown,
      netReturnPct: strategyResult.metrics.netReturnPct,
    },
    ddRanking: taggedDDs,
    stressWindows: stressAnalyses,
    tailMetrics,
    vixBuckets,
    verdict,
    equityCurve: strategyResult.equityCurve,
    trades: strategyResult.trades,
  };

  // ── 出力 ──
  const outDir = path.resolve("docs/reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = dayjs().format("YYYY-MM-DD");
  const reportPath = path.join(outDir, `pead-tail-${today}${suffix}.md`);
  fs.writeFileSync(reportPath, generateMarkdownReport(tailResult, "PEAD"), "utf-8");

  // ── ターミナル出力 ──
  console.log("\n" + "=".repeat(60));
  console.log("Verdict");
  console.log("=".repeat(60));
  console.log(`Total closed trades: ${strategyResult.trades.length}`);
  console.log(`Win rate: ${(strategyResult.metrics.winRate * 100).toFixed(1)}%`);
  console.log(`CAGR: ${(cagr * 100).toFixed(1)}%`);
  console.log(`Max DD: ${(strategyResult.metrics.maxDrawdown * 100).toFixed(1)}%`);
  for (const c of verdict.checks) {
    const status =
      c.pass === true ? "[PASS]" : c.pass === false ? "[FAIL]" : "[skip]";
    console.log(
      `  ${c.name.padEnd(30)} ${String(c.actual).padStart(10)} (≥/≤ ${c.threshold}) ${status}`,
    );
  }
  console.log(`\n${verdict.overallPass ? "✅" : "❌"} ${verdict.summary}`);
  console.log(`Report: ${reportPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
