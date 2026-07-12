// src/backtest/iron-condor/run-tail-test.ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_IRON_CONDOR_DEFAULTS, US_IRON_CONDOR_BACKTEST_FIDELITY } from "../us/us-iron-condor-config";
import { runUSIronCondorBacktest } from "../us/us-iron-condor-simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "../us/us-data-fetcher";
import type { USIronCondorBacktestConfig } from "../us/us-iron-condor-types";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics, calculateVixBuckets } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import type { TailTestResult } from "../framework/tail-test/types";
import type { Trade, StrategyResult } from "../framework/strategy-result";
import { IRON_CONDOR_THRESHOLDS } from "./tail-test-thresholds";

/**
 * SPY Iron Condor 戦略を実行し StrategyResult を返す（library 用 entry point）。
 *
 * tail-test や report 生成は呼ばない。Phase 4 portfolio analysis から再利用する。
 */
export async function runIronCondorStrategy(
  startDate: string,
  endDate: string,
  budget?: number,
): Promise<StrategyResult> {
  const config: USIronCondorBacktestConfig = {
    ...US_IRON_CONDOR_DEFAULTS,
    ...US_IRON_CONDOR_BACKTEST_FIDELITY,
    startDate,
    endDate,
    initialBudget: budget ?? US_IRON_CONDOR_DEFAULTS.initialBudget,
    verbose: false,
  };

  const gspc = await fetchSP500FromDB(startDate, endDate);
  const vix = await fetchVixFromDB(startDate, endDate);
  const result = await runUSIronCondorBacktest(config, gspc, vix);

  const closed = result.condors.filter((c) => c.state === "CLOSED");
  const trades: Trade[] = closed.map((c) => ({
    symbol: c.underlyingSymbol,
    entryDate: c.entryDate,
    closeDate: c.closeDate ?? null,
    netPnl: c.netPnl ?? null,
    pnlPct: null,
    holdingDays: null,
    category: c.closeReason,
  }));

  const initial = config.initialBudget;

  return {
    strategyName: "iron-condor",
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

  const startDate = getArg("start") ?? "2007-01-03";
  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const stepLabel = getArg("label");
  const suffix = stepLabel ? `-${stepLabel}` : "";

  const config: USIronCondorBacktestConfig = {
    ...US_IRON_CONDOR_DEFAULTS,
    ...US_IRON_CONDOR_BACKTEST_FIDELITY,
    startDate,
    endDate,
    ...(getArg("short-delta") ? { shortDelta: Number(getArg("short-delta")) } : {}),
    ...(getArg("dte") ? { dte: Number(getArg("dte")) } : {}),
    ...(getArg("profit-target") ? { profitTarget: Number(getArg("profit-target")) } : {}),
    ...(getArg("put-slope") ? { putSkewSlope: Number(getArg("put-slope")) } : {}),
    ...(getArg("call-slope") ? { callSkewSlope: Number(getArg("call-slope")) } : {}),
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("SPY Iron Condor Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Config: δ=±${config.shortDelta} | DTE=${config.dte} | PT=${(config.profitTarget * 100).toFixed(0)}% | skew put=${config.putSkewSlope}/call=${config.callSkewSlope}`);

  console.log("\nLoading data...");
  const gspc = await fetchSP500FromDB(startDate, endDate);
  const vix = await fetchVixFromDB(startDate, endDate);
  console.log(`  ^GSPC: ${gspc.size} days | VIX: ${vix.size} days`);

  console.log("\nRunning simulation...");
  const result = await runUSIronCondorBacktest(config, gspc, vix);

  // ── 後処理 ──
  const closed = result.condors.filter((c) => c.state === "CLOSED");
  const trades: Trade[] = closed.map((c) => ({
    symbol: c.underlyingSymbol,
    entryDate: c.entryDate,
    closeDate: c.closeDate ?? null,
    netPnl: c.netPnl ?? null,
    pnlPct: null,
    holdingDays: null,
    category: c.closeReason,
  }));

  const initial = config.initialBudget;
  const finalEq = result.equityCurve[result.equityCurve.length - 1]?.totalEquity ?? initial;
  const years = result.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;

  const strategyResult: StrategyResult = {
    strategyName: "iron-condor",
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

  const ddPeriods = extractDDPeriods(strategyResult.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) =>
    analyzeWindow(w, strategyResult.equityCurve, strategyResult.trades),
  );
  const tailMetrics = calculateTailMetrics(strategyResult.trades, strategyResult.equityCurve);
  const tradingDays = strategyResult.equityCurve.map((e) => e.date);
  const vixBuckets = calculateVixBuckets(tradingDays, vix, strategyResult.trades);

  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD = available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct = available.length === 0 ? null : Math.min(...available.map((w) => w.pnlPct));

  const verdict = evaluateThresholds({
    winRate: strategyResult.metrics.winRate,
    profitFactor: strategyResult.metrics.profitFactor,
    cagr,
    maxDrawdown: strategyResult.metrics.maxDrawdown,
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    maxLossDollar: config.spreadWidth * 100 * config.contractsPerCondor, // 片側
    thresholds: IRON_CONDOR_THRESHOLDS,
  });

  const tailResult: TailTestResult = {
    configSummary: {
      underlyingSymbol: config.underlyingSymbol,
      shortDelta: config.shortDelta,
      spreadWidth: config.spreadWidth,
      dte: config.dte,
      profitTarget: config.profitTarget,
      putSkewSlope: config.putSkewSlope,
      callSkewSlope: config.callSkewSlope,
      vixCap: config.vixCap,
      indexTrendSmaPeriod: config.indexTrendSmaPeriod,
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
  const reportPath = path.join(outDir, `iron-condor-tail-${today}${suffix}.md`);
  fs.writeFileSync(reportPath, generateMarkdownReport(tailResult, "SPY Iron Condor"), "utf-8");

  // CSV
  fs.writeFileSync(
    path.join(outDir, `iron-condor-equity-curve-${today}${suffix}.csv`),
    "date,cash,positionsValue,totalEquity,openPositionCount\n" +
      result.equityCurve.map((e) => `${e.date},${e.cash},${e.positionsValue},${e.totalEquity},${e.openPositionCount}`).join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, `iron-condor-condors-${today}${suffix}.csv`),
    "entryDate,closeDate,putShort,putLong,callShort,callLong,credit,closeReason,netPnl\n" +
      closed.map((c) => `${c.entryDate},${c.closeDate ?? ""},${c.putShortStrike},${c.putLongStrike},${c.callShortStrike},${c.callLongStrike},${c.creditReceived.toFixed(4)},${c.closeReason ?? ""},${c.netPnl ?? 0}`).join("\n"),
  );

  // ── ターミナル出力 ──
  console.log("\n" + "=".repeat(60));
  console.log("Verdict");
  console.log("=".repeat(60));
  console.log(`Total condors: ${strategyResult.trades.length}`);
  for (const c of verdict.checks) {
    const status = c.pass === true ? "[PASS]" : c.pass === false ? "[FAIL]" : "[skip]";
    console.log(`  ${c.name.padEnd(30)} ${String(c.actual).padStart(10)} (≥/≤ ${c.threshold}) ${status}`);
  }
  console.log(`\n${verdict.overallPass ? "✅" : "❌"} ${verdict.summary}`);
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
