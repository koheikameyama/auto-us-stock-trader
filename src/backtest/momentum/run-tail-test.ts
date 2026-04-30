import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_MOMENTUM_DEFAULTS } from "../us/us-momentum-config";
import { runUSMomentumBacktest } from "../us/us-momentum-simulation";
import {
  getUSTickerCodes,
  fetchUSHistoricalFromDB,
  fetchSP500FromDB,
  fetchVixFromDB,
} from "../us/us-data-fetcher";
import type { USMomentumBacktestConfig } from "../us/us-types";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics, calculateVixBuckets } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import type { TailTestResult } from "../framework/tail-test/types";
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { MOMENTUM_THRESHOLDS } from "./tail-test-thresholds";

/**
 * Cross-Sectional Momentum 戦略を実行し StrategyResult を返す（library 用 entry point）。
 * tail-test や report 生成は呼ばない。Phase 4 portfolio analysis から再利用する。
 */
export async function runMomentumStrategy(
  startDate: string,
  endDate: string,
  budget?: number,
): Promise<StrategyResult> {
  const config: USMomentumBacktestConfig = {
    ...US_MOMENTUM_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget ?? US_MOMENTUM_DEFAULTS.initialBudget,
    verbose: false,
  };

  const tickers = await getUSTickerCodes();
  const [allData, vixData, indexData] = await Promise.all([
    fetchUSHistoricalFromDB(tickers, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchSP500FromDB(startDate, endDate),
  ]);

  const result = runUSMomentumBacktest(config, allData, vixData, indexData);

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

  const initial = config.initialBudget;

  return {
    strategyName: "momentum",
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
}

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
    : US_MOMENTUM_DEFAULTS.initialBudget;

  const config: USMomentumBacktestConfig = {
    ...US_MOMENTUM_DEFAULTS,
    startDate,
    endDate,
    initialBudget: budget,
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("Momentum Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Budget: $${budget.toLocaleString()}`);

  console.log("\nLoading data...");
  const tickers = await getUSTickerCodes();

  const [allData, vixData, indexData] = await Promise.all([
    fetchUSHistoricalFromDB(tickers, startDate, endDate),
    fetchVixFromDB(startDate, endDate),
    fetchSP500FromDB(startDate, endDate),
  ]);
  console.log(`  US tickers: ${tickers.length}`);
  console.log(`  Stocks with data: ${allData.size}`);
  console.log(`  VIX data: ${vixData.size} days`);
  console.log(`  S&P 500 data: ${indexData.size} days`);

  console.log("\nRunning simulation...");
  const result = runUSMomentumBacktest(config, allData, vixData, indexData);

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
    strategyName: "momentum",
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

  // Momentum の per-trade 最大損失（USD）: initialBudget × maxLossPct を 1 trade 上限の代用とする
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
    thresholds: MOMENTUM_THRESHOLDS,
  });

  const tailResult: TailTestResult = {
    configSummary: {
      strategy: "momentum",
      lookbackDays: config.lookbackDays,
      topN: config.topN,
      rebalanceDays: config.rebalanceDays,
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
  const reportPath = path.join(outDir, `momentum-tail-${today}${suffix}.md`);
  fs.writeFileSync(reportPath, generateMarkdownReport(tailResult, "Momentum"), "utf-8");

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
  console.log(`\n${verdict.overallPass ? "[PASS]" : "[FAIL]"} ${verdict.summary}`);
  console.log(`Report: ${reportPath}`);
}

// CLI エントリー: 直接実行されたときのみ main() を呼ぶ
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
