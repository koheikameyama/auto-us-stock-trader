import type { PerformanceMetrics } from "../../../src/backtest/types";

export interface WFWindow {
  windowIdx: number;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
  bestIsParams: Record<string, unknown>;
  isMetrics: PerformanceMetrics;
  oosMetrics: PerformanceMetrics | null;
}

export type WFJudgment = "robust" | "watch" | "overfit";

export interface WFSummary {
  strategy: string;
  generatedAt: string;
  config: {
    isMonths: number;
    oosMonths: number;
    slideMonths: number;
    numWindows: number;
  };
  windows: WFWindow[];
  aggregate: {
    activeWindows: number;
    skippedWindows: number;
    oosTotalTrades: number;
    oosWinRate: number;
    oosAggregatePF: number;
    isAvgPF: number;
    oosAvgPF: number;
    isOosRatio: number;
    oosAvgSharpe: number | null;
    oosAvgMaxDD: number;
    oosAvgReturnPct: number;
    oosCalmar: number;
    judgment: WFJudgment;
  };
}

export function judge(oosAggregatePF: number, isOosRatio: number): WFJudgment {
  if (oosAggregatePF >= 1.3 && isOosRatio <= 2.0) return "robust";
  if (oosAggregatePF >= 1.0 && isOosRatio <= 3.0) return "watch";
  return "overfit";
}

export function judgmentLabel(j: WFJudgment): string {
  switch (j) {
    case "robust":
      return "堅牢 ✓";
    case "watch":
      return "要注意 △";
    case "overfit":
      return "過学習 ✗";
  }
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function avgNullable(values: (number | null)[]): number | null {
  const filtered = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (filtered.length === 0) return null;
  return filtered.reduce((s, v) => s + v, 0) / filtered.length;
}

export function summarizeWFResults(
  strategy: string,
  windows: WFWindow[],
  config: WFSummary["config"],
): WFSummary {
  const active = windows.filter((w) => w.oosMetrics !== null);
  const skipped = windows.length - active.length;

  let oosGP = 0;
  let oosGL = 0;
  let oosTotalTrades = 0;
  let oosWins = 0;
  for (const w of active) {
    const o = w.oosMetrics!;
    oosTotalTrades += o.totalTrades;
    oosWins += o.wins;
    if (o.wins > 0) oosGP += o.avgWinPct * o.wins;
    if (o.losses > 0) oosGL += Math.abs(o.avgLossPct) * o.losses;
  }
  const oosAggregatePF =
    oosGL > 0 ? oosGP / oosGL : oosGP > 0 ? Number.POSITIVE_INFINITY : 0;
  const oosWinRate = oosTotalTrades > 0 ? (oosWins / oosTotalTrades) * 100 : 0;

  const isAvgPF = avg(windows.map((w) => w.isMetrics.profitFactor));
  const oosAvgPF = avg(active.map((w) => w.oosMetrics!.profitFactor));
  const isOosRatio = oosAvgPF > 0 ? isAvgPF / oosAvgPF : Number.POSITIVE_INFINITY;

  const oosAvgSharpe = avgNullable(active.map((w) => w.oosMetrics!.sharpeRatio));
  const oosAvgMaxDD = avg(active.map((w) => w.oosMetrics!.maxDrawdown));
  const oosAvgReturnPct = avg(active.map((w) => w.oosMetrics!.totalReturnPct));
  const oosCalmar = oosAvgMaxDD > 0 ? oosAvgReturnPct / oosAvgMaxDD : 0;

  return {
    strategy,
    generatedAt: new Date().toISOString(),
    config,
    windows,
    aggregate: {
      activeWindows: active.length,
      skippedWindows: skipped,
      oosTotalTrades,
      oosWinRate,
      oosAggregatePF,
      isAvgPF,
      oosAvgPF,
      isOosRatio,
      oosAvgSharpe,
      oosAvgMaxDD,
      oosAvgReturnPct,
      oosCalmar,
      judgment: judge(oosAggregatePF, isOosRatio),
    },
  };
}

export function isJsonMode(argv: string[] = process.argv): boolean {
  return argv.includes("--json");
}

export function emitJsonSummary(summary: WFSummary): void {
  process.stdout.write(
    "===WF_SUMMARY_JSON_START===\n" +
      JSON.stringify(summary, (_k, v) =>
        v === Number.POSITIVE_INFINITY
          ? "Infinity"
          : v === Number.NEGATIVE_INFINITY
            ? "-Infinity"
            : Number.isNaN(v)
              ? "NaN"
              : v,
      ) +
      "\n===WF_SUMMARY_JSON_END===\n",
  );
}
