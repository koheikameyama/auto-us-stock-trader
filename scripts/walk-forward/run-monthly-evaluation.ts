/**
 * 月次 Walk-Forward 評価
 *
 * 全戦略の WF を順次実行し、OOS 集計を比較して Slack に投稿。
 * 切替判断はせず、ランキングと現行戦略との差分のみ通知する（人間が判断）。
 *
 * Usage:
 *   npm run walk-forward:monthly
 *   npm run walk-forward:monthly -- --strategies=us-momentum,us-credit-spread
 *   npm run walk-forward:monthly -- --dry-run   # Slack 通知をスキップ
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendSlack } from "../../src/paper-trading/slack-notifier";
import type { WFSummary } from "./lib/wf-summary";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface StrategyEntry {
  name: string;
  script: string;
}

const STRATEGIES: StrategyEntry[] = [
  { name: "us-credit-spread", script: "walk-forward-us-credit-spread.ts" },
  { name: "us-momentum", script: "walk-forward-us-momentum.ts" },
  { name: "us-mean-reversion", script: "walk-forward-us-mean-reversion.ts" },
  { name: "us-pead", script: "walk-forward-us-pead.ts" },
  { name: "us-gapup", script: "walk-forward-us-gapup.ts" },
  { name: "us-wheel", script: "walk-forward-us-wheel.ts" },
  { name: "us-vix-contango", script: "walk-forward-us-vix-contango.ts" },
  { name: "us-dual-momentum", script: "walk-forward-us-dual-momentum.ts" },
];

const CURRENT_STRATEGY = "us-credit-spread";
const JSON_START = "===WF_SUMMARY_JSON_START===";
const JSON_END = "===WF_SUMMARY_JSON_END===";

interface RunOutcome {
  strategy: string;
  summary: WFSummary | null;
  error: string | null;
  durationMs: number;
}

function parseArgs(argv: string[]): {
  strategies: string[] | null;
  dryRun: boolean;
} {
  let strategies: string[] | null = null;
  let dryRun = false;
  for (const a of argv) {
    if (a.startsWith("--strategies=")) {
      strategies = a.slice("--strategies=".length).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--dry-run") {
      dryRun = true;
    }
  }
  return { strategies, dryRun };
}

function reviveJsonNumbers(text: string): WFSummary {
  return JSON.parse(text, (_k, v) => {
    if (v === "Infinity") return Number.POSITIVE_INFINITY;
    if (v === "-Infinity") return Number.NEGATIVE_INFINITY;
    if (v === "NaN") return Number.NaN;
    return v;
  }) as WFSummary;
}

function extractSummary(stdout: string): WFSummary | null {
  const start = stdout.indexOf(JSON_START);
  const end = stdout.indexOf(JSON_END);
  if (start < 0 || end < 0 || end <= start) return null;
  const body = stdout.slice(start + JSON_START.length, end).trim();
  if (!body) return null;
  try {
    return reviveJsonNumbers(body);
  } catch {
    return null;
  }
}

async function runWF(strategy: StrategyEntry): Promise<RunOutcome> {
  const scriptPath = path.join(__dirname, strategy.script);
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", scriptPath, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - start;
      if (code !== 0) {
        resolve({
          strategy: strategy.name,
          summary: null,
          error: `exit ${code}: ${stderr.slice(-500) || stdout.slice(-500)}`,
          durationMs,
        });
        return;
      }
      const summary = extractSummary(stdout);
      if (!summary) {
        resolve({
          strategy: strategy.name,
          summary: null,
          error: "no JSON summary in stdout",
          durationMs,
        });
        return;
      }
      resolve({ strategy: strategy.name, summary, error: null, durationMs });
    });
    child.on("error", (err) => {
      resolve({
        strategy: strategy.name,
        summary: null,
        error: err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}

function formatSharpe(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "n/a";
  return s.toFixed(2);
}

function formatPF(pf: number): string {
  if (!Number.isFinite(pf)) return "∞";
  return pf.toFixed(2);
}

function judgmentMark(j: WFSummary["aggregate"]["judgment"]): string {
  switch (j) {
    case "robust":
      return "✓";
    case "watch":
      return "△";
    case "overfit":
      return "✗";
  }
}

function rankByOosSharpe(outcomes: RunOutcome[]): RunOutcome[] {
  const ok = outcomes.filter((o) => o.summary !== null);
  return [...ok].sort((a, b) => {
    const sa = a.summary!.aggregate.oosAvgSharpe;
    const sb = b.summary!.aggregate.oosAvgSharpe;
    const va = sa === null || !Number.isFinite(sa) ? -Infinity : sa;
    const vb = sb === null || !Number.isFinite(sb) ? -Infinity : sb;
    return vb - va;
  });
}

function buildSlackMessage(outcomes: RunOutcome[], runDate: string): string {
  const ranked = rankByOosSharpe(outcomes);
  const failed = outcomes.filter((o) => o.error !== null);

  const lines: string[] = [];
  lines.push(`*📈 Monthly Walk-Forward Evaluation* — ${runDate}`);
  lines.push(`Current strategy: *${CURRENT_STRATEGY}*`);
  lines.push("");

  if (ranked.length > 0) {
    lines.push("*Ranking by OOS Sharpe*");
    lines.push("```");
    lines.push("Rank | Strategy             | Sharpe | PF    | MaxDD%  | Calmar | Trades | Judge");
    lines.push("-".repeat(85));
    ranked.forEach((o, i) => {
      const s = o.summary!;
      const a = s.aggregate;
      const isCurrent = s.strategy === CURRENT_STRATEGY ? "*" : " ";
      const rank = String(i + 1).padStart(2);
      const name = s.strategy.padEnd(20);
      const sharpe = formatSharpe(a.oosAvgSharpe).padStart(6);
      const pf = formatPF(a.oosAggregatePF).padStart(5);
      const dd = a.oosAvgMaxDD.toFixed(2).padStart(7);
      const calmar = a.oosCalmar.toFixed(2).padStart(6);
      const trades = String(a.oosTotalTrades).padStart(6);
      const judge = judgmentMark(a.judgment);
      lines.push(
        `${rank}${isCurrent} | ${name} | ${sharpe} | ${pf} | ${dd} | ${calmar} | ${trades} | ${judge}`,
      );
    });
    lines.push("```");

    const current = ranked.find((o) => o.summary!.strategy === CURRENT_STRATEGY);
    const top = ranked[0];
    if (current && top && top.summary!.strategy !== CURRENT_STRATEGY) {
      const currentSharpe = current.summary!.aggregate.oosAvgSharpe ?? -Infinity;
      const topSharpe = top.summary!.aggregate.oosAvgSharpe ?? -Infinity;
      const diff = Number.isFinite(topSharpe) && Number.isFinite(currentSharpe)
        ? (topSharpe as number) - (currentSharpe as number)
        : NaN;
      lines.push("");
      lines.push(
        `Top vs current: *${top.summary!.strategy}* − *${CURRENT_STRATEGY}* = ` +
          `Sharpe ${Number.isFinite(diff) ? diff.toFixed(2) : "n/a"}`,
      );
      lines.push(
        "_切替判断は四半期ベース（Sharpe 差 +0.3 以上 × 3 ヶ月連続）。月次は通知のみ。_",
      );
    }
  } else {
    lines.push("_No successful runs._");
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push(`*Failed (${failed.length})*`);
    for (const f of failed) {
      lines.push(`• ${f.strategy}: ${f.error}`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const { strategies, dryRun } = parseArgs(process.argv.slice(2));
  const targets = strategies
    ? STRATEGIES.filter((s) => strategies.includes(s.name))
    : STRATEGIES;

  if (targets.length === 0) {
    console.error("No matching strategies.");
    process.exit(1);
  }

  console.log(`Running ${targets.length} WF strategies...`);
  const outcomes: RunOutcome[] = [];
  for (const t of targets) {
    console.log(`\n[${t.name}] running...`);
    const r = await runWF(t);
    if (r.error) {
      console.error(`[${t.name}] FAILED in ${r.durationMs}ms: ${r.error}`);
    } else {
      const a = r.summary!.aggregate;
      console.log(
        `[${t.name}] OK in ${(r.durationMs / 1000).toFixed(0)}s — ` +
          `Sharpe=${formatSharpe(a.oosAvgSharpe)} PF=${formatPF(a.oosAggregatePF)} ${judgmentMark(a.judgment)}`,
      );
    }
    outcomes.push(r);
  }

  const runDate = new Date().toISOString().slice(0, 10);
  const message = buildSlackMessage(outcomes, runDate);

  console.log("\n" + "=".repeat(80));
  console.log(message);
  console.log("=".repeat(80));

  const failedCount = outcomes.filter((o) => o.error !== null).length;
  const level = failedCount === outcomes.length ? "error" : failedCount > 0 ? "warn" : "info";

  if (!dryRun) {
    await sendSlack({ text: message, level });
  } else {
    console.log("\n[dry-run] Slack 通知をスキップしました");
  }

  if (failedCount === outcomes.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Monthly WF runner error:", err);
  process.exit(1);
});
