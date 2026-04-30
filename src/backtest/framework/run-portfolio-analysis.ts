#!/usr/bin/env tsx
/**
 * Phase 4: Portfolio 相関分析 runner。
 *
 * 4 戦略 (credit-spread + Tier 1 三戦略) を共通期間で実行し、
 *  - 単独メトリクス (CAGR / Sharpe / MaxDD)
 *  - 4×4 相関行列 (日次リターン Pearson)
 *  - 50/50 portfolio (credit-spread + 各 diversifier) のメトリクス
 * を計算し、Markdown レポートを `docs/reports/portfolio-correlation-matrix-YYYY-MM-DD.md` に生成。
 */
import dayjs from "dayjs";
import * as fs from "fs";
import * as path from "path";
import type { StrategyResult } from "./strategy-result";
import type { DailyEquity } from "../types";
import { calculateCorrelationMatrix } from "./correlation";
import { combineEquityCurves } from "./portfolio";
import { calculateAnnualizedReturn, calculateSharpeRatio } from "./portfolio-metrics";
import { runCreditSpreadStrategy } from "../credit-spread/run-tail-test";
import { runDualMomentumStrategy } from "../dual-momentum/run-tail-test";
import { runPeadStrategy } from "../pead/run-tail-test";
import { runMomentumStrategy } from "../momentum/run-tail-test";

interface StandaloneMetric {
  name: string;
  cagr: number;
  sharpe: number;
  maxDD: number;
}

interface PortfolioEvaluation {
  name: string;
  diversifierName: string;
  curve: DailyEquity[];
  cagr: number;
  sharpe: number;
  maxDD: number;
}

function maxDrawdownFromCurve(curve: DailyEquity[]): number {
  let peak = 0;
  let maxDD = 0;
  for (const d of curve) {
    if (d.totalEquity > peak) peak = d.totalEquity;
    const dd = peak > 0 ? (peak - d.totalEquity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function fmtPct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function generateReport(
  strategies: StrategyResult[],
  standalones: StandaloneMetric[],
  matrix: number[][],
  portfolios: PortfolioEvaluation[],
  startDate: string,
  endDate: string,
  budget: number,
  today: string,
): string {
  const csStandalone = standalones[0]; // credit-spread
  // 採用候補の判定: portfolio Sharpe > credit-spread Sharpe AND portfolio MaxDD < credit-spread MaxDD
  const candidates = portfolios.filter(
    (p) => p.sharpe > csStandalone.sharpe && p.maxDD < csStandalone.maxDD,
  );

  // 結論
  let conclusion: string;
  if (candidates.length > 0) {
    const names = candidates.map((c) => c.diversifierName).join(", ");
    conclusion = `採用候補 — credit-spread と ${names} の 50/50 portfolio が単独 credit-spread 比で Sharpe 改善 + MaxDD 縮小`;
  } else {
    conclusion = "不採用 (credit-spread 単独運用推奨) — どの diversifier も Sharpe / MaxDD の同時改善を達成せず";
  }

  const names = strategies.map((s) => s.strategyName);

  // 単独メトリクス表
  const standaloneTable = [
    "| 戦略 | CAGR | Sharpe | Max DD |",
    "|---|---|---|---|",
    ...standalones.map(
      (s) => `| ${s.name} | ${fmtPct(s.cagr)} | ${s.sharpe.toFixed(2)} | ${fmtPct(s.maxDD)} |`,
    ),
  ].join("\n");

  // 相関行列
  const matrixHeader = `| | ${names.join(" | ")} |`;
  const matrixSep = `|---|${names.map(() => "---").join("|")}|`;
  const matrixRows = matrix.map(
    (row, i) =>
      `| ${names[i]} | ${row
        .map((v) => v.toFixed(3))
        .join(" | ")} |`,
  );
  const matrixTable = [matrixHeader, matrixSep, ...matrixRows].join("\n");

  // 50/50 portfolio 評価
  const portfolioTable = [
    "| Portfolio | CAGR | Sharpe | Max DD | vs CS Sharpe | vs CS MaxDD | 判定 |",
    "|---|---|---|---|---|---|---|",
    ...portfolios.map((p) => {
      const dSharpe = p.sharpe - csStandalone.sharpe;
      const dMaxDD = p.maxDD - csStandalone.maxDD;
      const sharpeStr = `${dSharpe >= 0 ? "+" : ""}${dSharpe.toFixed(2)}`;
      const maxDDStr = `${dMaxDD >= 0 ? "+" : ""}${fmtPct(dMaxDD)}`;
      const judge = p.sharpe > csStandalone.sharpe && p.maxDD < csStandalone.maxDD ? "candidate" : "reject";
      return `| ${p.name} | ${fmtPct(p.cagr)} | ${p.sharpe.toFixed(2)} | ${fmtPct(p.maxDD)} | ${sharpeStr} | ${maxDDStr} | ${judge} |`;
    }),
  ].join("\n");

  // 判定詳細
  const detailLines = portfolios.map((p) => {
    const dSharpe = p.sharpe - csStandalone.sharpe;
    const dMaxDD = p.maxDD - csStandalone.maxDD;
    const judge = p.sharpe > csStandalone.sharpe && p.maxDD < csStandalone.maxDD ? "採用候補" : "棄却";
    let reason: string;
    if (judge === "採用候補") {
      reason = `Sharpe +${dSharpe.toFixed(2)} 改善 / MaxDD ${fmtPct(dMaxDD)} 縮小`;
    } else {
      const sharpeOK = p.sharpe > csStandalone.sharpe;
      const maxDDOK = p.maxDD < csStandalone.maxDD;
      const sharpeNote = sharpeOK ? "Sharpe 改善" : `Sharpe ${dSharpe >= 0 ? "+" : ""}${dSharpe.toFixed(2)}（劣化または同等）`;
      const maxDDNote = maxDDOK ? "MaxDD 縮小" : `MaxDD ${dMaxDD >= 0 ? "+" : ""}${fmtPct(dMaxDD)}（拡大または同等）`;
      reason = `${sharpeNote}、${maxDDNote}`;
    }
    return `### ${p.name}\n\n- 判定: **${judge}**\n- 理由: ${reason}\n- Portfolio CAGR ${fmtPct(p.cagr)}, Sharpe ${p.sharpe.toFixed(2)}, MaxDD ${fmtPct(p.maxDD)}\n`;
  });

  // 次のステップ
  let nextSteps: string;
  if (candidates.length > 0) {
    nextSteps = [
      `- 採用候補 (${candidates.map((c) => c.diversifierName).join(", ")}) の本番 portfolio 構成を別 task で定義`,
      "- 70/30 や Tier 2 戦略を含む拡張検討（Phase 5 以降）",
      "- KOH-459: 採用候補 portfolio の paper-trading 適用判断",
    ].join("\n");
  } else {
    nextSteps = [
      "- credit-spread 単独で paper-trading 継続",
      "- 本番運用判断 (KOH-459) の input は credit-spread 単独 metrics",
      "- Phase 3 (Tier 2) ライト評価で diversifier 候補を追加検討",
    ].join("\n");
  }

  return `# Phase 4: Portfolio 相関分析レポート — ${today}

## 結論

${conclusion}

## 評価期間

- 期間: ${startDate} 〜 ${endDate}
- 各戦略 initial budget: $${budget.toLocaleString()}
- 評価日数: ${strategies[0].equityCurve.length} 営業日
- 総 trade 数: ${strategies.map((s) => `${s.strategyName}=${s.trades.length}`).join(", ")}

## 単独メトリクス

${standaloneTable}

## 相関行列 (Pearson, 日次リターン)

${matrixTable}

## 50/50 Portfolio 評価

| 基準 | credit-spread 単独 |
|---|---|
| CAGR | ${fmtPct(csStandalone.cagr)} |
| Sharpe | ${csStandalone.sharpe.toFixed(2)} |
| Max DD | ${fmtPct(csStandalone.maxDD)} |

${portfolioTable}

判定基準: portfolio Sharpe > credit-spread Sharpe **AND** portfolio MaxDD < credit-spread MaxDD で "candidate"。

## 判定詳細

${detailLines.join("\n")}

## 次のステップ

${nextSteps}
`;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  // 共通期間: 4 戦略 overlap
  // - credit-spread: 2007-01-03〜
  // - dual-momentum: 2007-01-03〜
  // - PEAD: 2015-01-01〜
  // - momentum: 2015-01-01〜
  // → 共通: 2015-01-01〜
  const startDate = getArg("start") ?? "2015-01-01";
  const endDate = getArg("end") ?? dayjs().format("YYYY-MM-DD");
  const budget = getArg("budget") ? Number(getArg("budget")) : 3300;

  console.log("=".repeat(60));
  console.log("Phase 4: Portfolio Correlation Analysis");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`Per-strategy budget: $${budget.toLocaleString()}\n`);

  // 各戦略を並列実行（互いに独立なので Promise.all）
  console.log("Running 4 strategies in parallel...");
  const t0 = Date.now();
  const [creditSpread, dualMomentum, pead, momentum] = await Promise.all([
    runCreditSpreadStrategy(startDate, endDate, budget),
    runDualMomentumStrategy(startDate, endDate, budget),
    runPeadStrategy(startDate, endDate, budget),
    runMomentumStrategy(startDate, endDate, budget),
  ]);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const strategies = [creditSpread, dualMomentum, pead, momentum];

  // 単独メトリクス
  const standalones: StandaloneMetric[] = strategies.map((s) => ({
    name: s.strategyName,
    cagr: calculateAnnualizedReturn(s.equityCurve, s.initialBudget),
    sharpe: calculateSharpeRatio(s.equityCurve),
    maxDD: s.metrics.maxDrawdown,
  }));

  // 相関行列 (4×4)
  const matrix = calculateCorrelationMatrix(
    strategies.map((s) => ({ name: s.strategyName, curve: s.equityCurve })),
  );

  // 50/50 portfolio (credit-spread + 各 diversifier)
  const portfolios: PortfolioEvaluation[] = strategies.slice(1).map((d) => {
    const combined = combineEquityCurves([
      { curve: creditSpread.equityCurve, weight: 0.5, initialBudget: creditSpread.initialBudget },
      { curve: d.equityCurve, weight: 0.5, initialBudget: d.initialBudget },
    ]);
    const portfolioBudget = creditSpread.initialBudget * 0.5 + d.initialBudget * 0.5;
    return {
      name: `credit-spread + ${d.strategyName} (50/50)`,
      diversifierName: d.strategyName,
      curve: combined,
      cagr: calculateAnnualizedReturn(combined, portfolioBudget),
      sharpe: calculateSharpeRatio(combined),
      maxDD: maxDrawdownFromCurve(combined),
    };
  });

  // Markdown レポート出力
  const today = dayjs().format("YYYY-MM-DD");
  const reportDir = path.join(process.cwd(), "docs/reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `portfolio-correlation-matrix-${today}.md`);
  const md = generateReport(strategies, standalones, matrix, portfolios, startDate, endDate, budget, today);
  fs.writeFileSync(reportPath, md);

  // ターミナル要約
  console.log("=".repeat(60));
  console.log("Standalone Metrics");
  console.log("=".repeat(60));
  for (const s of standalones) {
    console.log(
      `  ${s.name.padEnd(20)} CAGR=${(s.cagr * 100).toFixed(2)}%, Sharpe=${s.sharpe.toFixed(2)}, MaxDD=${(s.maxDD * 100).toFixed(2)}%`,
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("Correlations vs credit-spread (daily returns)");
  console.log("=".repeat(60));
  for (let j = 1; j < strategies.length; j++) {
    console.log(`  ${strategies[0].strategyName} vs ${strategies[j].strategyName}: ${matrix[0][j].toFixed(3)}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("50/50 Portfolios");
  console.log("=".repeat(60));
  for (const p of portfolios) {
    const dSharpe = p.sharpe - standalones[0].sharpe;
    const dMaxDD = p.maxDD - standalones[0].maxDD;
    const judge = p.sharpe > standalones[0].sharpe && p.maxDD < standalones[0].maxDD ? "[CAND]" : "[REJECT]";
    console.log(
      `  ${judge} ${p.name.padEnd(45)} CAGR=${(p.cagr * 100).toFixed(2)}%, Sharpe=${p.sharpe.toFixed(2)} (Δ${dSharpe.toFixed(2)}), MaxDD=${(p.maxDD * 100).toFixed(2)}% (Δ${(dMaxDD * 100).toFixed(2)}%)`,
    );
  }

  console.log(`\nReport: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
