// src/paper-trading/calibrate-skew.ts
/**
 * IV skew 較正: Alpaca の SPY option chain（市場クォート）から put/call の実 IV skew を
 * 測定し、backtest の skewedIvMonotonic slope を較正する。**発注は一切しない**。
 *
 * 測定ロジックは [skew-calibrator.ts](skew-calibrator.ts) に集約（日次記録と共有）。
 * 本 CLI は結果を標準出力するだけで DB には書かない。日次で貯めるのは
 * `record-skew.ts`（`npm run paper-trading:record-skew`）。
 *
 * Usage:
 *   npx tsx src/paper-trading/calibrate-skew.ts            # ~35DTE
 *   npx tsx src/paper-trading/calibrate-skew.ts --dte 35
 *
 * env: ALPACA_API_KEY / ALPACA_API_SECRET / ALPACA_API_ENDPOINT（未設定時は .env 自動読込）
 */

import * as fs from "fs";
import { DELTA_BAND, calibrateSkew } from "./skew-calibrator";

if (!process.env.ALPACA_API_KEY && fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const { AlpacaClient } = await import("./alpaca-client");

function requireEnv(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing env: ${n}`);
  return v;
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

  const result = await calibrateSkew(client, dte);

  console.log("=".repeat(60));
  console.log("IV Skew Calibration (Alpaca market quotes, no orders)");
  console.log("=".repeat(60));

  if (!result) {
    console.log("\n⚠️ impliedVol が空（市場休場でスナップショットに IV なし等）。市場時間中に再実行してください。");
    return;
  }

  console.log(`SPY spot ≈ ${result.spot.toFixed(2)} | ATM ${Math.round(result.spot)} | expiry ${result.expiry} (~${dte}DTE)`);
  console.log(`baseIv (ATM) ≈ ${(result.baseIv * 100).toFixed(1)}%`);

  console.log("\n[skew smile] strike / (spot-strike)/spot / IV / delta");
  for (const p of result.points) {
    console.log(
      `  ${p.strike.toFixed(0).padStart(5)}  x=${p.x.toFixed(4).padStart(8)}  iv=${(p.iv * 100).toFixed(1).padStart(5)}%  δ=${p.delta?.toFixed(3) ?? "-"}`,
    );
  }

  const band = `取引帯(${DELTA_BAND.min}-${DELTA_BAND.max}δ)`;
  console.log("\n" + "=".repeat(60));
  console.log("フィット結果 (slope for skewedIvMonotonic)");
  console.log("=".repeat(60));
  console.log(
    `  put 側  全域 slope = ${result.put.all.slope.toFixed(2)} (n=${result.put.all.n}) | ${band} = ${result.put.band.slope.toFixed(2)} (n=${result.put.band.n})`,
  );
  console.log(
    `  call 側 全域 slope = ${result.call.all.slope.toFixed(2)} (n=${result.call.all.n}) | ${band} = ${result.call.band.slope.toFixed(2)} (n=${result.call.band.n})`,
  );
  console.log(`  全体    slope = ${result.overall.slope.toFixed(2)} (n=${result.overall.n})`);
  console.log(`\n→ 取引帯 call slope ${result.call.band.slope.toFixed(2)} で IC spike を再走（put は backtest 5.5 固定）`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
