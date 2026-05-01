/**
 * Alpaca Paper Trading への接続 smoke test
 *
 * Usage:
 *   npx tsx src/paper-trading/test-alpaca-connection.ts
 *
 * Required env (from .env):
 *   ALPACA_API_KEY
 *   ALPACA_API_SECRET
 *   ALPACA_API_ENDPOINT  (e.g. https://paper-api.alpaca.markets/v2)
 *   ALPACA_DATA_ENDPOINT (optional; default https://data.alpaca.markets)
 */

import { AlpacaClient } from "./alpaca-client";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Alpaca Paper Trading Connection Smoke Test");
  console.log("=".repeat(60));

  const client = new AlpacaClient({
    apiKey: requireEnv("ALPACA_API_KEY"),
    apiSecret: requireEnv("ALPACA_API_SECRET"),
    baseUrl: requireEnv("ALPACA_API_ENDPOINT"),
    dataUrl: process.env.ALPACA_DATA_ENDPOINT,
  });

  console.log("\n[1] Fetching account summary...");
  const summary = await client.getAccountSummary();
  console.log(`    Net Liquidation: $${summary.netLiquidation.toLocaleString()}`);
  console.log(`    Cash:            $${summary.totalCashValue.toLocaleString()}`);
  console.log(`    Buying Power:    $${summary.buyingPower.toLocaleString()}`);
  console.log(`    Available Funds: $${summary.availableFunds.toLocaleString()}`);

  console.log("\n[2] Fetching positions...");
  const positions = await client.getPositions();
  console.log(`    Positions: ${positions.length}`);
  for (const p of positions.slice(0, 10)) {
    console.log(
      `      ${p.symbol} ${p.assetClass} ${p.side} qty=${p.quantity} pnl=${p.unrealizedPnl.toFixed(2)}`,
    );
  }

  console.log("\n[3] Fetching SPY market price...");
  const spy = await client.getMarketPrice("SPY");
  console.log(`    SPY: bid=${spy.bid} ask=${spy.ask}`);

  console.log("\n[4] Fetching SPY put option chain (ATM ±20 strikes)...");
  const refPrice =
    spy.bid != null && spy.ask != null
      ? (spy.bid + spy.ask) / 2
      : (spy.bid ?? spy.ask);
  const atmStrike = refPrice != null ? Math.round(refPrice) : 470;
  console.log(
    `    ATM strike: ${atmStrike} (${
      spy.bid != null && spy.ask != null
        ? "from SPY mid"
        : refPrice != null
          ? "from SPY one-sided quote"
          : "default fallback"
    })`,
  );

  // Target expiry: ~35 日後の最初の金曜
  const today = new Date();
  today.setDate(today.getDate() + 35);
  const dow = today.getDay();
  const offset = (5 - dow + 7) % 7;
  today.setDate(today.getDate() + offset);
  const expiryISO = today.toISOString().slice(0, 10);
  console.log(`    Target expiry: ${expiryISO}`);

  const chain = await client.getOptionChain("SPY", expiryISO, "P", atmStrike);
  console.log(`    Got ${chain.length} contracts. Top 5 by strike (descending):`);
  for (const opt of chain.sort((a, b) => b.strike - a.strike).slice(0, 5)) {
    console.log(
      `      strike=${opt.strike} bid=${opt.bid} ask=${opt.ask} delta=${
        opt.delta?.toFixed(3) ?? "-"
      } iv=${opt.impliedVol?.toFixed(3) ?? "-"}`,
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ Smoke test passed");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("\n❌ Smoke test failed:", msg);
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exit(1);
  });
