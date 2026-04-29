// run-credit-spread-tail-test.ts
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_CREDIT_SPREAD_DEFAULTS } from "../us/us-credit-spread-config";
import { runUSCreditSpreadBacktest } from "../us/us-credit-spread-simulation";
import { fetchSP500FromDB, fetchVixFromDB } from "../us/us-data-fetcher";
import type { USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";
import { extractDDPeriods } from "./dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "./window-analyzer";
import { calculateTailMetrics, calculateVixBuckets } from "./tail-metrics";
import { evaluateThresholds, DEFAULT_THRESHOLDS } from "./pass-fail";
import { generateMarkdownReport } from "./report";
import { STRESS_WINDOWS } from "./stress-windows";
import type { TailTestResult } from "./types";

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

  const config: USCreditSpreadBacktestConfig = {
    ...US_CREDIT_SPREAD_DEFAULTS,
    startDate,
    endDate,
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("SPY Credit Spread Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);

  console.log("\nLoading data...");
  const gspc = await fetchSP500FromDB(startDate, endDate);
  const vix = await fetchVixFromDB(startDate, endDate);
  console.log(`  ^GSPC: ${gspc.size} days | VIX: ${vix.size} days`);

  console.log("\nRunning simulation...");
  const result = await runUSCreditSpreadBacktest(config, gspc, vix);

  // ── 後処理 ──
  const closed = result.spreads.filter((s) => s.state === "CLOSED");
  const ddPeriods = extractDDPeriods(result.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) => analyzeWindow(w, result.equityCurve, closed));
  const tailMetrics = calculateTailMetrics(result.spreads, result.equityCurve);
  const tradingDays = result.equityCurve.map((e) => e.date);
  const vixBuckets = calculateVixBuckets(tradingDays, vix, closed);

  // CAGR
  const initial = config.initialBudget;
  const finalEq = result.equityCurve[result.equityCurve.length - 1]?.totalEquity ?? initial;
  const years = result.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;

  // 全 stress window の最悪 DD / PnL%
  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD = available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct = available.length === 0 ? null : Math.min(...available.map((w) => w.pnlPct));

  const verdict = evaluateThresholds({
    winRate: result.metrics.winRate / 100,           // metrics.winRate は % なので比率に
    profitFactor: result.metrics.profitFactor,
    cagr,
    maxDrawdown: result.metrics.maxDrawdown / 100,    // 同上
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    maxLossDollar: config.spreadWidth * 100 * config.contractsPerSpread,
    thresholds: DEFAULT_THRESHOLDS,
  });

  const tailResult: TailTestResult = {
    configSummary: {
      underlyingSymbol: config.underlyingSymbol,
      shortPutDelta: config.shortPutDelta,
      spreadWidth: config.spreadWidth,
      dte: config.dte,
      profitTarget: config.profitTarget,
      vixCap: config.vixCap,
      indexTrendSmaPeriod: config.indexTrendSmaPeriod,
      initialBudget: config.initialBudget,
    },
    startDate,
    endDate,
    totalSpreads: result.metrics.totalSpreads,
    baseMetrics: {
      winRate: result.metrics.winRate / 100,
      profitFactor: result.metrics.profitFactor,
      cagr,
      maxDrawdown: result.metrics.maxDrawdown / 100,
      netReturnPct: result.metrics.netReturnPct / 100,
    },
    ddRanking: taggedDDs,
    stressWindows: stressAnalyses,
    tailMetrics,
    vixBuckets,
    verdict,
    equityCurve: result.equityCurve,
    closedSpreads: closed,
  };

  // ── 出力 ──
  const outDir = path.resolve("docs/reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = dayjs().format("YYYY-MM-DD");
  const reportPath = path.join(outDir, `credit-spread-tail-${today}${suffix}.md`);
  fs.writeFileSync(reportPath, generateMarkdownReport(tailResult), "utf-8");

  // CSV
  fs.writeFileSync(
    path.join(outDir, `equity-curve-${today}${suffix}.csv`),
    "date,cash,positionsValue,totalEquity,openPositionCount\n" +
      result.equityCurve.map((e) => `${e.date},${e.cash},${e.positionsValue},${e.totalEquity},${e.openPositionCount}`).join("\n"),
  );
  fs.writeFileSync(
    path.join(outDir, `spreads-${today}${suffix}.csv`),
    "entryDate,closeDate,shortStrike,longStrike,credit,closeReason,netPnl\n" +
      closed.map((s) => `${s.entryDate},${s.closeDate ?? ""},${s.shortStrike},${s.longStrike},${s.creditReceived.toFixed(4)},${s.closeReason ?? ""},${s.netPnl ?? 0}`).join("\n"),
  );

  // ── ターミナル出力 ──
  console.log("\n" + "=".repeat(60));
  console.log("Verdict");
  console.log("=".repeat(60));
  console.log(`Total spreads: ${result.metrics.totalSpreads}`);
  for (const c of verdict.checks) {
    const status = c.pass === true ? "[PASS]" : c.pass === false ? "[FAIL]" : "[skip]";
    console.log(`  ${c.name.padEnd(30)} ${String(c.actual).padStart(10)} (≥/≤ ${c.threshold}) ${status}`);
  }
  console.log(`\n${verdict.overallPass ? "✅" : "❌"} ${verdict.summary}`);
  console.log(`Report: ${reportPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
