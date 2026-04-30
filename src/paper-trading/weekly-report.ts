// src/paper-trading/weekly-report.ts
/**
 * Paper Trading 週次レポート生成
 *
 * 毎週土曜 JST 朝 cron で起動想定。
 * 出力先: docs/paper-trading/weekly-YYYY-Www.md
 *
 * Usage:
 *   npx tsx src/paper-trading/weekly-report.ts
 */

import { PrismaClient } from "@prisma/client";
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek.js";
import * as fs from "fs";
import * as path from "path";

dayjs.extend(isoWeek);

async function main() {
  const prisma = new PrismaClient();
  const today = dayjs();
  const monday = today.startOf("isoWeek"); // ISO Monday
  const friday = monday.add(4, "day");
  const weekLabel = `${today.year()}-W${String(today.isoWeek()).padStart(2, "0")}`;

  const closedThisWeek = await prisma.position.findMany({
    where: { closeDate: { gte: monday.toDate(), lte: friday.endOf("day").toDate() } },
  });
  const open = await prisma.position.findMany({ where: { state: "OPEN" } });
  const snapshots = await prisma.dailyEquitySnapshot.findMany({
    where: { date: { gte: monday.toDate(), lte: friday.toDate() } },
    orderBy: { date: "asc" },
  });

  const wins = closedThisWeek.filter((p) => (p.netPnl ?? 0) > 0).length;
  const losses = closedThisWeek.filter((p) => (p.netPnl ?? 0) <= 0).length;
  const totalPnl = closedThisWeek.reduce((s, p) => s + (p.netPnl ?? 0), 0);
  const winRate = closedThisWeek.length > 0 ? wins / closedThisWeek.length : 0;

  const md = `# Paper Trading Weekly Report — ${weekLabel}

期間: ${monday.format("YYYY-MM-DD")} 〜 ${friday.format("YYYY-MM-DD")}

## サマリー

- クローズ件数: ${closedThisWeek.length} (win=${wins}, loss=${losses})
- Win Rate: ${(winRate * 100).toFixed(1)}%
- 累計 PnL: $${totalPnl.toFixed(2)}
- 平均 PnL: $${(totalPnl / Math.max(1, closedThisWeek.length)).toFixed(2)}
- オープン: ${open.length} 件

## オープンポジション

${
  open.length === 0
    ? "(none)"
    : open
        .map(
          (p) =>
            `- ${p.symbol} ${p.shortStrike}/${p.longStrike} exp=${p.expiry.toISOString().slice(0, 10)} credit=$${p.creditReceived}`,
        )
        .join("\n")
}

## Equity Curve

${
  snapshots.length === 0
    ? "(no snapshots this week)"
    : `| date | equity | open | DD stop |
|---|---|---|---|
${snapshots
  .map(
    (s) =>
      `| ${s.date.toISOString().slice(0, 10)} | $${s.totalEquity.toFixed(0)} | ${s.openPositionCount} | ${s.ddStopActive ? "✓" : ""} |`,
  )
  .join("\n")}`
}
`;

  const outDir = path.resolve("docs/paper-trading");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `weekly-${weekLabel}.md`);
  fs.writeFileSync(outPath, md);
  console.log(`Wrote ${outPath}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
