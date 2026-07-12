// src/paper-trading/diff-report.ts
/**
 * Live vs Backtest クレジット乖離レポート
 *
 * 各 FILLED entry（Position）の「実 fill credit」と、まったく同じスプレッド
 * （short/long strike・expiry・entry 日）を backtest と同一のモデル
 * （Black-Scholes, iv = VIX/100 × ivScaleFactor）で再評価した「モデル credit」を比較する。
 *
 * 目的: paper-trading の実約定クレジットが backtest 前提からどれだけ乖離しているかを
 *       定量化し、Phase F → live 移行ゲート「乖離 < 10%」を評価する。
 *
 * 乖離率 = (実 fill credit − モデル credit) / モデル credit
 *   - 正 = live のほうが多くクレジットを取れている（有利）
 *   - 負 = live のほうが取れていない（slippage / IV skew による不利）
 *
 * 出力: docs/paper-trading/credit-divergence-YYYY-MM-DD.md + 標準出力
 *
 * Usage:
 *   npx tsx src/paper-trading/diff-report.ts                 # 全 FILLED entry を対象
 *   npx tsx src/paper-trading/diff-report.ts --start 2026-05-19 --end 2026-07-10
 *
 * env: DATABASE_URL（未設定時は .env を自動読込。?schema= が無ければ auto_us_stock_trader を合成）
 */

import * as fs from "fs";
import * as path from "path";
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek.js";
import { bsPutPrice } from "../core/options-pricing";
import { US_CREDIT_SPREAD_DEFAULTS } from "../backtest/us/us-credit-spread-config";

dayjs.extend(isoWeek);

// --- env fallback（CI では workflow が env を注入するので発火しない）-----------
if (!process.env.DATABASE_URL && fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (process.env.DATABASE_URL && !/[?&]schema=/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL += (process.env.DATABASE_URL.includes("?") ? "&" : "?") + "schema=auto_us_stock_trader";
}

// PrismaClient は DATABASE_URL 確定後に読み込む
const { PrismaClient } = await import("@prisma/client");

const R = US_CREDIT_SPREAD_DEFAULTS.riskFreeRate; // 0.045
const IV_SCALE = US_CREDIT_SPREAD_DEFAULTS.ivScaleFactor; // 1.0
const GATE = 0.10; // 乖離ゲート 10%

export interface DivergenceRow {
  entryDate: string;
  expiry: string;
  shortStrike: number;
  longStrike: number;
  contracts: number;
  spyClose: number;
  vixClose: number;
  liveCredit: number; // 実 fill credit（per share）
  modelCredit: number; // backtest モデル credit（per share）
  divergence: number | null; // (live - model) / model
}

/** entry 日の SPY / VIX close からモデル credit を再計算して乖離を返す純関数 */
export function computeDivergence(input: {
  entryDate: string;
  expiry: string;
  shortStrike: number;
  longStrike: number;
  spyClose: number;
  vixClose: number;
  liveCredit: number;
  riskFreeRate?: number;
  ivScale?: number;
}): { modelCredit: number; divergence: number | null } {
  const r = input.riskFreeRate ?? R;
  const ivScale = input.ivScale ?? IV_SCALE;
  const days = Math.round(
    (new Date(input.expiry).getTime() - new Date(input.entryDate).getTime()) / 86_400_000,
  );
  const tte = Math.max(days / 365, 0);
  const iv = (input.vixClose / 100) * ivScale;
  const shortPrem = bsPutPrice(input.spyClose, input.shortStrike, tte, r, iv);
  const longPrem = bsPutPrice(input.spyClose, input.longStrike, tte, r, iv);
  const modelCredit = shortPrem - longPrem;
  const divergence = modelCredit > 0 ? (input.liveCredit - modelCredit) / modelCredit : null;
  return { modelCredit, divergence };
}

function pct(x: number | null): string {
  return x == null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const startArg = args[args.indexOf("--start") + 1];
  const endArg = args[args.indexOf("--end") + 1];
  const start = args.includes("--start") ? dayjs(startArg).startOf("day").toDate() : undefined;
  const end = args.includes("--end") ? dayjs(endArg).endOf("day").toDate() : undefined;

  const prisma = new PrismaClient();
  try {
    const positions = await prisma.position.findMany({
      where: {
        ...(start || end ? { entryDate: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
      },
      orderBy: { entryDate: "asc" },
    });

    if (positions.length === 0) {
      console.log("対象 Position がありません。");
      await prisma.$disconnect();
      return;
    }

    const rows: DivergenceRow[] = [];
    for (const p of positions) {
      const entryDate = dayjs(p.entryDate).format("YYYY-MM-DD");
      const asOf = dayjs(p.entryDate).endOf("day").toDate();

      const spyBar = await prisma.stockDailyBar.findFirst({
        where: { tickerCode: "SPY", date: { lte: asOf } },
        orderBy: { date: "desc" },
      });
      const vixBar = await prisma.indexDailyBar.findFirst({
        where: { tickerCode: "^VIX", date: { lte: asOf } },
        orderBy: { date: "desc" },
      });

      if (!spyBar || !vixBar) {
        rows.push({
          entryDate,
          expiry: dayjs(p.expiry).format("YYYY-MM-DD"),
          shortStrike: p.shortStrike,
          longStrike: p.longStrike,
          contracts: p.contracts,
          spyClose: spyBar?.close ?? NaN,
          vixClose: vixBar?.close ?? NaN,
          liveCredit: p.creditReceived,
          modelCredit: NaN,
          divergence: null,
        });
        continue;
      }

      const { modelCredit, divergence } = computeDivergence({
        entryDate,
        expiry: dayjs(p.expiry).format("YYYY-MM-DD"),
        shortStrike: p.shortStrike,
        longStrike: p.longStrike,
        spyClose: spyBar.close,
        vixClose: vixBar.close,
        liveCredit: p.creditReceived,
      });

      rows.push({
        entryDate,
        expiry: dayjs(p.expiry).format("YYYY-MM-DD"),
        shortStrike: p.shortStrike,
        longStrike: p.longStrike,
        contracts: p.contracts,
        spyClose: spyBar.close,
        vixClose: vixBar.close,
        liveCredit: p.creditReceived,
        modelCredit,
        divergence,
      });
    }

    // fill 率のコンテキスト（ENTRY 注文の FILLED / TIMEOUT 内訳）
    const entryOrders = await prisma.tradingOrder.findMany({
      where: {
        orderType: "ENTRY",
        ...(start || end ? { submittedAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}),
      },
    });
    const entryStatus: Record<string, number> = {};
    for (const o of entryOrders) entryStatus[o.status] = (entryStatus[o.status] ?? 0) + 1;
    const filledN = entryStatus["FILLED"] ?? 0;
    const entryTotal = entryOrders.length;

    // 集計
    const valid = rows.filter((r) => r.divergence != null) as (DivergenceRow & { divergence: number })[];
    const divs = valid.map((r) => r.divergence);
    const mean = divs.length ? divs.reduce((s, x) => s + x, 0) / divs.length : NaN;
    const absMean = divs.length ? divs.reduce((s, x) => s + Math.abs(x), 0) / divs.length : NaN;
    const sorted = [...divs].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
    const withinGate = divs.filter((x) => Math.abs(x) <= GATE).length;

    // ISO 週バケット
    const weekMap = new Map<string, number[]>();
    for (const r of valid) {
      const d = dayjs(r.entryDate);
      const wk = `${d.year()}-W${String(d.isoWeek()).padStart(2, "0")}`;
      if (!weekMap.has(wk)) weekMap.set(wk, []);
      weekMap.get(wk)!.push(r.divergence);
    }

    // ---- Markdown ----
    const today = dayjs();
    const label = today.format("YYYY-MM-DD");
    let md = `# Credit Divergence Report — ${label}\n\n`;
    md += `対象: FILLED entry ${rows.length} 件`;
    if (start || end) md += `（${start ? dayjs(start).format("YYYY-MM-DD") : "…"} 〜 ${end ? dayjs(end).format("YYYY-MM-DD") : "…"}）`;
    md += `\n\n`;
    md += `乖離率 = (実 fill credit − モデル credit) / モデル credit　（正=有利 / 負=不利）\n`;
    md += `モデル: Black-Scholes, r=${R}, iv=VIX/100×${IV_SCALE}、SPY/VIX は entry 日の日足 close\n\n`;

    md += `## サマリー\n\n`;
    md += `- 平均乖離: **${pct(mean)}**（median ${pct(median)}）\n`;
    md += `- 平均絶対乖離: **${pct(absMean)}**\n`;
    md += `- ゲート ±${GATE * 100}% 以内: **${withinGate}/${valid.length}** 件\n`;
    md += `- entry 約定: FILLED ${filledN}/${entryTotal} 件（${entryTotal ? ((filledN / entryTotal) * 100).toFixed(0) : "0"}%）`;
    if (entryTotal - filledN > 0) md += ` — 非約定内訳: ${JSON.stringify(entryStatus)}`;
    md += `\n`;
    const verdict = !isFinite(absMean)
      ? "評価不能（有効サンプルなし）"
      : absMean <= GATE
        ? `✅ 平均絶対乖離 ${pct(absMean)} ≤ ${GATE * 100}% — ゲート充足`
        : `⚠️ 平均絶対乖離 ${pct(absMean)} > ${GATE * 100}% — ゲート未達`;
    md += `- 判定: ${verdict}\n\n`;

    md += `## 週次乖離\n\n`;
    md += `| week | 件数 | 平均乖離 |\n|---|---|---|\n`;
    for (const [wk, arr] of [...weekMap.entries()].sort()) {
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      md += `| ${wk} | ${arr.length} | ${pct(m)} |\n`;
    }
    md += `\n`;

    md += `## トレード別\n\n`;
    md += `| entry | spread | exp | SPY | VIX | live cr | model cr | 乖離 |\n|---|---|---|---|---|---|---|---|\n`;
    for (const r of rows) {
      md += `| ${r.entryDate} | ${r.shortStrike}/${r.longStrike} | ${r.expiry} | ${isNaN(r.spyClose) ? "-" : r.spyClose.toFixed(2)} | ${isNaN(r.vixClose) ? "-" : r.vixClose.toFixed(2)} | $${r.liveCredit.toFixed(2)} | ${isNaN(r.modelCredit) ? "-" : "$" + r.modelCredit.toFixed(2)} | ${pct(r.divergence)} |\n`;
    }
    md += `\n`;

    const outDir = path.resolve("docs/paper-trading");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `credit-divergence-${label}.md`);
    fs.writeFileSync(outPath, md);

    // ---- console ----
    console.log(md);
    console.log(`Wrote ${outPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
