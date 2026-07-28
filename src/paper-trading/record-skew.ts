// src/paper-trading/record-skew.ts
/**
 * IV skew の日次スナップショットを DB（IvSkewSnapshot）に記録する。**発注は一切しない**。
 *
 * 目的: `callSkewSlope` は VIX regime 依存だが、現状の較正値 4.05 は低 VIX（~11-13%）の
 * 単一スナップショットのみ（KOH-544）。スパイク時の skew は事後に再現できないため、
 * 毎営業日 NY 取引時間中に記録して複数 regime のサンプルを貯める。
 *
 * 実行タイミング: `paper-trading-daily.yml`（NY 10:00 平日）のステップとして daily-runner の後に走る。
 * 取引サイクルの成否とは独立（kill switch で取引停止中でも記録は続ける）。
 * VIX スパイク当日に追加サンプルが欲しい場合は市場時間中に手動実行してよい（同日同 DTE は上書き）。
 *
 * Usage:
 *   npm run paper-trading:record-skew
 *   npx tsx src/paper-trading/record-skew.ts --dte 35
 *
 * env: ALPACA_API_KEY / ALPACA_API_SECRET / ALPACA_API_ENDPOINT / DATABASE_URL
 *      （未設定時は .env を自動読込。?schema= が無ければ auto_us_stock_trader を合成）
 */

import * as fs from "fs";
import dayjs from "dayjs";
import type { Prisma } from "@prisma/client";

// --- env fallback（CI では workflow が env を注入するので発火しない）-----------
if ((!process.env.ALPACA_API_KEY || !process.env.DATABASE_URL) && fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (process.env.DATABASE_URL && !/[?&]schema=/.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL += (process.env.DATABASE_URL.includes("?") ? "&" : "?") + "schema=auto_us_stock_trader";
}

// PrismaClient / AlpacaClient は env 確定後に読み込む
const { PrismaClient } = await import("@prisma/client");
const { AlpacaClient } = await import("./alpaca-client");
const { calibrateSkew } = await import("./skew-calibrator");

function requireEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env: ${n}`);
  return v;
}

/** NaN は DB に入れず null にする（サンプル 0 件のフィット結果） */
const orNull = (v: number): number | null => (Number.isFinite(v) ? v : null);

/** NY 暦の今日（実行環境の TZ に依存しない） */
function nyToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function main() {
  const args = process.argv.slice(2);
  const dteArg = args.indexOf("--dte");
  const dte = dteArg >= 0 ? Number(args[dteArg + 1]) : 35;

  const client = new AlpacaClient({
    apiKey: requireEnv("ALPACA_API_KEY"),
    apiSecret: requireEnv("ALPACA_API_SECRET"),
    baseUrl: requireEnv("ALPACA_API_ENDPOINT"),
    dataUrl: process.env.ALPACA_DATA_ENDPOINT,
  });
  requireEnv("DATABASE_URL");
  const prisma = new PrismaClient();

  try {
    const today = nyToday();
    const result = await calibrateSkew(client, dte, dayjs(today));

    if (!result) {
      // 市場休場 / スナップショットに IV なし。記録すべき観測が無いので正常終了する。
      console.log(`[record-skew] ${today}: impliedVol が空のためスキップ（市場休場 or 時間外）`);
      return;
    }

    // VIX は DB の最新 close。NY 10:00 時点では us-daily backfill（NY 18:00）が未実行のため
    // 前営業日の値になる。regime の live 指標としては baseIv を使うこと。
    const vixRow = await prisma.indexDailyBar.findFirst({
      where: { tickerCode: "^VIX" },
      orderBy: { date: "desc" },
      select: { date: true, close: true },
    });

    const data = {
      dte,
      expiry: new Date(`${result.expiry}T00:00:00Z`),
      capturedAt: new Date(),
      spot: result.spot,
      baseIv: result.baseIv,
      vix: vixRow?.close ?? null,
      vixDate: vixRow?.date ?? null,
      putSlopeAll: orNull(result.put.all.slope),
      putSlopeBand: orNull(result.put.band.slope),
      putCountAll: result.put.all.n,
      putCountBand: result.put.band.n,
      callSlopeAll: orNull(result.call.all.slope),
      callSlopeBand: orNull(result.call.band.slope),
      callCountAll: result.call.all.n,
      callCountBand: result.call.band.n,
      points: result.points as unknown as Prisma.InputJsonValue,
    };

    await prisma.ivSkewSnapshot.upsert({
      where: { date_dte: { date: new Date(`${today}T00:00:00Z`), dte } },
      create: { date: new Date(`${today}T00:00:00Z`), ...data },
      update: data,
    });

    const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
    console.log(
      `[record-skew] ${today} dte=${dte} exp=${result.expiry} spot=${result.spot.toFixed(2)} ` +
        `baseIv=${(result.baseIv * 100).toFixed(1)}% vix=${vixRow?.close?.toFixed(2) ?? "n/a"}` +
        `(${vixRow ? dayjs(vixRow.date).format("YYYY-MM-DD") : "-"}) ` +
        `put=${f(result.put.band.slope)}/${f(result.put.all.slope)} ` +
        `call=${f(result.call.band.slope)}/${f(result.call.all.slope)} (band/all)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
