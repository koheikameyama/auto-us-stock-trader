import type { TailTestResult } from "./types";

export function generateMarkdownReport(result: TailTestResult): string {
  const m = result.baseMetrics;
  const v = result.verdict;
  const lines: string[] = [];

  lines.push(`# SPY Credit Spread テール耐性検証レポート — ${todayString()}`);
  lines.push("");
  lines.push("## 結論");
  lines.push(v.overallPass ? `✅ **PASS**（${v.summary}）` : `❌ **FAIL**（${v.summary}）`);
  lines.push("");
  lines.push(`実取引推奨: ${v.overallPass ? "YES" : "NO"}`);
  lines.push("");
  lines.push("## 設定");
  for (const [k, v2] of Object.entries(result.configSummary)) {
    lines.push(`- ${k}: ${v2}`);
  }
  lines.push(`- 期間: ${result.startDate} 〜 ${result.endDate}`);
  lines.push(`- 総 spread 数: ${result.totalSpreads}`);
  lines.push("");
  lines.push("## 平時メトリクス");
  lines.push("| 指標 | 値 |");
  lines.push("|---|---|");
  lines.push(`| Win Rate | ${pct(m.winRate)} |`);
  lines.push(`| Profit Factor | ${m.profitFactor.toFixed(2)} |`);
  lines.push(`| CAGR | ${pct(m.cagr)} |`);
  lines.push(`| Max DD | ${pct(m.maxDrawdown)} |`);
  lines.push(`| Net Return | ${pct(m.netReturnPct)} |`);
  lines.push("");
  lines.push("## テールメトリクス");
  lines.push("| 指標 | 値 |");
  lines.push("|---|---|");
  lines.push(`| CVaR 5% | ${dollar(result.tailMetrics.cvar5)} |`);
  lines.push(`| CVaR 1% | ${dollar(result.tailMetrics.cvar1)} |`);
  lines.push(
    `| 最悪 spread | ${result.tailMetrics.worstSpread ? dollar(result.tailMetrics.worstSpread.netPnl ?? 0) : "-"} |`,
  );
  lines.push(`| 最大連敗 | ${result.tailMetrics.consecutiveLossCount} |`);
  lines.push("");
  lines.push("## 判定");
  lines.push("| # | 指標 | 実測値 | 閾値 | 判定 |");
  lines.push("|---|---|---|---|---|");
  v.checks.forEach((c, i) => {
    const status = c.pass === true ? "✅" : c.pass === false ? "❌" : "⏭ skip";
    lines.push(`| ${i + 1} | ${c.name} | ${c.actual ?? "-"} | ${c.threshold} | ${status} |`);
  });
  lines.push("");
  lines.push("## DD 上位");
  lines.push("| Rank | Peak | Trough | Recovery | DD% | DD$ | 期間(日) | 一致イベント |");
  lines.push("|---|---|---|---|---|---|---|---|");
  result.ddRanking.forEach((d, i) => {
    lines.push(
      `| ${i + 1} | ${d.peakDate} | ${d.troughDate} | ${d.recoveryDate ?? "未復元"} | ${pct(d.ddPct)} | ${dollar(d.ddDollar)} | ${d.durationDays} | ${d.matchedEvent ?? "-"} |`,
    );
  });
  lines.push("");
  lines.push("## 事前定義イベント");
  lines.push("| イベント | 期間 | spread | 勝率 | PnL | DD |");
  lines.push("|---|---|---|---|---|---|");
  for (const w of result.stressWindows) {
    if (!w.dataAvailable) {
      lines.push(`| ${w.window.name} | ${w.window.start} 〜 ${w.window.end} | (データなし) | - | - | - |`);
    } else {
      lines.push(
        `| ${w.window.name} | ${w.window.start} 〜 ${w.window.end} | ${w.spreadCount} | ${pct(w.winRate)} | ${dollar(w.totalPnl)} | ${pct(w.ddPct)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## VIX レジーム");
  lines.push("| Bucket | 取引日数 | spread | 勝率 | PnL/spread |");
  lines.push("|---|---|---|---|---|");
  for (const b of result.vixBuckets) {
    lines.push(
      `| ${b.label} | ${b.tradingDays} | ${b.spreadCount} | ${pct(b.winRate)} | ${dollar(b.pnlPerSpread)} |`,
    );
  }
  lines.push("");
  lines.push("## 詳細");
  lines.push("- equity-curve.csv: 同階層に出力（date, cash, totalEquity）");
  lines.push("- spreads.csv: 同階層に出力（各 spread の明細）");
  return lines.join("\n");
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

function dollar(x: number): string {
  return `$${x.toFixed(2)}`;
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}
