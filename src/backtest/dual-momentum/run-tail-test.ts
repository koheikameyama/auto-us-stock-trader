import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import { US_DUAL_MOMENTUM_DEFAULTS } from "../us/us-dual-momentum-config";
import { runUSDualMomentumBacktest } from "../us/us-dual-momentum-simulation";
import { fetchUSHistoricalFromDB } from "../us/us-data-fetcher";
import type { USDualMomentumBacktestConfig } from "../us/us-dual-momentum-types";
import { extractDDPeriods } from "../framework/tail-test/dd-extractor";
import { analyzeWindow, tagDDsWithEvents } from "../framework/tail-test/window-analyzer";
import { calculateTailMetrics } from "../framework/tail-test/tail-metrics";
import { evaluateThresholds } from "../framework/tail-test/pass-fail";
import { generateMarkdownReport } from "../framework/tail-test/report";
import { STRESS_WINDOWS } from "../framework/tail-test/stress-windows";
import { rotationPositionsToSpreads } from "../tail-test/dual-momentum-adapter";
import type { TailTestResult } from "../framework/tail-test/types";
import type { Trade } from "../framework/strategy-result";
import { DUAL_MOMENTUM_THRESHOLDS } from "./tail-test-thresholds";

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

  const config: USDualMomentumBacktestConfig = {
    ...US_DUAL_MOMENTUM_DEFAULTS,
    startDate,
    endDate,
    verbose: false,
  };

  console.log("=".repeat(60));
  console.log("Dual Momentum Tail-Risk Test");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);

  const allTickers = [...config.equityUniverse, config.riskOffAsset];
  const dataStart = dayjs(startDate)
    .subtract(config.lookbackDays + 30, "day")
    .format("YYYY-MM-DD");

  console.log("\nLoading data...");
  const etfMap = await fetchUSHistoricalFromDB(allTickers, dataStart, endDate, 0);
  for (const t of allTickers) {
    console.log(`  ${t}: ${etfMap.get(t)?.length ?? 0} days`);
  }

  console.log("\nRunning simulation...");
  const result = runUSDualMomentumBacktest(config, etfMap);

  // ── Adapter: rotation positions -> SimulatedSpread 互換 → Trade 変換 ──
  const adaptedSpreads = rotationPositionsToSpreads(result.positions);
  const trades: Trade[] = adaptedSpreads.map((s) => ({
    symbol: s.underlyingSymbol,
    entryDate: s.entryDate,
    closeDate: s.closeDate ?? null,
    netPnl: s.netPnl ?? null,
    pnlPct: null,
    holdingDays: null,
    category: s.closeReason,
  }));

  // ── tail-test 共通処理 ──
  const ddPeriods = extractDDPeriods(result.equityCurve, 5);
  const taggedDDs = tagDDsWithEvents(ddPeriods, STRESS_WINDOWS);
  const stressAnalyses = STRESS_WINDOWS.map((w) =>
    analyzeWindow(w, result.equityCurve, trades),
  );
  const tailMetrics = calculateTailMetrics(trades, result.equityCurve);

  const initial = config.initialBudget;
  const finalEq =
    result.equityCurve[result.equityCurve.length - 1]?.totalEquity ?? initial;
  const years = result.equityCurve.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;

  const available = stressAnalyses.filter((w) => w.dataAvailable);
  const worstWindowDD =
    available.length === 0 ? null : Math.max(...available.map((w) => w.ddPct));
  const worstWindowPnlPct =
    available.length === 0
      ? null
      : Math.min(...available.map((w) => w.pnlPct));

  const verdict = evaluateThresholds({
    winRate: result.metrics.winRate / 100,
    profitFactor: result.metrics.profitFactor,
    cagr,
    maxDrawdown: result.metrics.maxDrawdown / 100,
    cvar5: tailMetrics.cvar5,
    worstWindowDD,
    worstWindowPnlPct,
    // dual-momentum には spreadWidth 概念がないので initialBudget を代用
    // （cvar5MinRatio が null なのでこの値は実際には使われない）
    maxLossDollar: initial,
    thresholds: DUAL_MOMENTUM_THRESHOLDS,
  });

  const tailResult: TailTestResult = {
    configSummary: {
      strategy: "dual-momentum",
      equityUniverse: config.equityUniverse.join(","),
      riskOffAsset: config.riskOffAsset,
      absoluteMomentumThreshold: config.absoluteMomentumThreshold,
      lookbackDays: config.lookbackDays,
      rebalanceDays: config.rebalanceDays,
      initialBudget: config.initialBudget,
    },
    startDate,
    endDate,
    totalTrades: trades.length,
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
    vixBuckets: [], // dual-momentum では概念が薄いので empty
    verdict,
    equityCurve: result.equityCurve,
    trades,
  };

  // ── 出力 ──
  const outDir = path.resolve("docs/reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = dayjs().format("YYYY-MM-DD");
  const reportPath = path.join(
    outDir,
    `dual-momentum-tail-${today}${suffix}.md`,
  );
  fs.writeFileSync(reportPath, generateMarkdownReport(tailResult, "Dual Momentum"), "utf-8");

  // ── ターミナル出力 ──
  console.log("\n" + "=".repeat(60));
  console.log("Verdict");
  console.log("=".repeat(60));
  console.log(`Total closed positions: ${trades.length}`);
  console.log(`Win rate: ${result.metrics.winRate.toFixed(1)}%`);
  console.log(`CAGR: ${(cagr * 100).toFixed(1)}%`);
  console.log(`Max DD: ${result.metrics.maxDrawdown.toFixed(1)}%`);
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
