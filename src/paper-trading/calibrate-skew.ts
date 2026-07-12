// src/paper-trading/calibrate-skew.ts
/**
 * IV skew 較正: Alpaca の SPY option chain（市場クォート）から put/call の実 IV skew を
 * 測定し、backtest の skewedIvMonotonic slope を較正する。**発注は一切しない**。
 *
 * モデル: iv(strike) = baseIv * (1 + slope * (spot - strike) / spot)
 *   → slope = Σ(x·y) / Σ(x²)   （x=(spot-strike)/spot, y=iv/baseIv - 1、原点回帰）
 * put 側（strike<spot）と call 側（strike>spot）で別々にフィットする。
 *
 * Usage:
 *   npx tsx src/paper-trading/calibrate-skew.ts            # ~35DTE
 *   npx tsx src/paper-trading/calibrate-skew.ts --dte 35
 *
 * env: ALPACA_API_KEY / ALPACA_API_SECRET / ALPACA_API_ENDPOINT（未設定時は .env 自動読込）
 */

import * as fs from "fs";

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

/** 原点回帰で slope をフィット */
function fitSlope(points: { x: number; y: number }[]): { slope: number; n: number } {
  let sxx = 0, sxy = 0;
  for (const p of points) { sxx += p.x * p.x; sxy += p.x * p.y; }
  return { slope: sxx > 0 ? sxy / sxx : NaN, n: points.length };
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

  const spyQuote = await client.getMarketPrice("SPY");
  const spot =
    spyQuote.bid != null && spyQuote.ask != null ? (spyQuote.bid + spyQuote.ask) / 2 : (spyQuote.bid ?? spyQuote.ask);
  if (spot == null) throw new Error("SPY spot 取得失敗");
  const atm = Math.round(spot);

  // ~dte 日後の最初の金曜
  const d = new Date();
  d.setDate(d.getDate() + dte);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7));
  const expiry = d.toISOString().slice(0, 10);

  console.log("=".repeat(60));
  console.log("IV Skew Calibration (Alpaca market quotes, no orders)");
  console.log("=".repeat(60));
  console.log(`SPY spot ≈ ${spot.toFixed(2)} | ATM ${atm} | expiry ${expiry} (~${dte}DTE)`);

  // ATM + 両 wing（±30 中心）を fetch し 0.20δ の取引 strike まで届かせる
  const dedupe = <T extends { occSymbol: string }>(arr: T[]): T[] => {
    const seen = new Set<string>(); return arr.filter((c) => (seen.has(c.occSymbol) ? false : (seen.add(c.occSymbol), true)));
  };
  const puts = dedupe([
    ...(await client.getOptionChain("SPY", expiry, "P", atm)),
    ...(await client.getOptionChain("SPY", expiry, "P", atm - 30)),
  ]);
  const calls = dedupe([
    ...(await client.getOptionChain("SPY", expiry, "C", atm)),
    ...(await client.getOptionChain("SPY", expiry, "C", atm + 30)),
  ]);
  const all = [...puts, ...calls].filter((c) => c.impliedVol != null && c.impliedVol > 0);
  if (all.length === 0) {
    console.log("\n⚠️ impliedVol が空（市場休場でスナップショットに IV なし等）。市場時間中に再実行してください。");
    return;
  }

  // ATM 基準 IV: spot に最も近い strike の IV（put/call 平均）
  const nearest = (arr: typeof all) => arr.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
  const atmPut = puts.filter((c) => c.impliedVol);
  const atmCall = calls.filter((c) => c.impliedVol);
  const baseIv =
    atmPut.length && atmCall.length
      ? (nearest(atmPut as typeof all).impliedVol! + nearest(atmCall as typeof all).impliedVol!) / 2
      : nearest(all).impliedVol!;
  console.log(`baseIv (ATM) ≈ ${(baseIv * 100).toFixed(1)}%`);

  const pt = (c: (typeof all)[number]) => ({ x: (spot - c.strike) / spot, y: c.impliedVol! / baseIv - 1, strike: c.strike, iv: c.impliedVol!, delta: c.delta });
  const putPts = (puts.filter((c) => c.impliedVol) as typeof all).map(pt);
  const callPts = (calls.filter((c) => c.impliedVol) as typeof all).map(pt);

  const putFit = fitSlope(putPts);
  const callFit = fitSlope(callPts);
  const allFit = fitSlope([...putPts, ...callPts]);
  // 取引 strike 帯（|δ| 0.12〜0.30 = 0.20δ 近傍）に限定したフィット
  const inBand = (p: (typeof putPts)[number]) => p.delta != null && Math.abs(p.delta) >= 0.12 && Math.abs(p.delta) <= 0.30;
  const putBand = fitSlope(putPts.filter(inBand));
  const callBand = fitSlope(callPts.filter(inBand));

  console.log("\n[skew smile] strike / (spot-strike)/spot / IV / delta");
  for (const p of [...putPts, ...callPts].sort((a, b) => a.strike - b.strike)) {
    console.log(`  ${p.strike.toFixed(0).padStart(5)}  x=${p.x.toFixed(4).padStart(8)}  iv=${(p.iv * 100).toFixed(1).padStart(5)}%  δ=${p.delta?.toFixed(3) ?? "-"}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log("フィット結果 (slope for skewedIvMonotonic)");
  console.log("=".repeat(60));
  console.log(`  put 側  全域 slope = ${putFit.slope.toFixed(2)} (n=${putFit.n}) | 取引帯(0.12-0.30δ) = ${putBand.slope.toFixed(2)} (n=${putBand.n})`);
  console.log(`  call 側 全域 slope = ${callFit.slope.toFixed(2)} (n=${callFit.n}) | 取引帯(0.12-0.30δ) = ${callBand.slope.toFixed(2)} (n=${callBand.n})`);
  console.log(`  全体    slope = ${allFit.slope.toFixed(2)} (n=${allFit.n})`);
  console.log(`\n→ 取引帯 call slope ${callBand.slope.toFixed(2)} で IC spike を再走（put は backtest 5.5 固定）`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
