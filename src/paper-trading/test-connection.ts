/**
 * IBKR TWS Paper Trading への接続 smoke test
 *
 * Usage:
 *   npx tsx src/paper-trading/test-connection.ts
 */

import { IBKRClient } from "./ibkr-client";

async function main() {
  console.log("=".repeat(60));
  console.log("IBKR TWS Paper Trading Connection Smoke Test");
  console.log("=".repeat(60));

  const client = new IBKRClient({ clientId: 100 });

  console.log("\n[1] Connecting to TWS at 127.0.0.1:7497...");
  await client.connect();
  console.log("    ✅ Connected");

  console.log("\n[2] Fetching account summary...");
  const summary = await client.getAccountSummary();
  console.log(`    Net Liquidation: $${summary.netLiquidation.toLocaleString()}`);
  console.log(`    Cash:            $${summary.totalCashValue.toLocaleString()}`);
  console.log(`    Buying Power:    $${summary.buyingPower.toLocaleString()}`);
  console.log(`    Available Funds: $${summary.availableFunds.toLocaleString()}`);

  console.log("\n[3] Fetching positions...");
  const positions = await client.getPositions();
  console.log(`    Positions: ${positions.length}`);
  for (const p of positions.slice(0, 10)) {
    console.log(
      `      ${p.symbol} ${p.secType} ${p.right ?? "-"} ${
        p.strike ?? "-"
      } qty=${p.quantity}`,
    );
  }

  console.log("\n[4] Fetching SPY market price...");
  const spy = await client.getMarketPrice("SPY");
  console.log(`    SPY: bid=${spy.bid}, ask=${spy.ask}, last=${spy.last}`);

  console.log("\n[5] Fetching VIX...");
  try {
    const vix = await client.getVIX();
    console.log(`    VIX: ${vix.toFixed(2)}`);
  } catch (e: any) {
    console.log(`    VIX: unavailable (${e.message})`);
  }

  console.log("\n[6] Fetching SPY put option chain (ATM ±20 strikes)...");
  // ATM 決定: SPY last があれば使用、なければデフォルト 470 を使う
  const atmStrike = spy.last != null ? Math.round(spy.last) : 470;
  console.log(`    ATM strike: ${atmStrike} (${spy.last != null ? "from SPY last" : "default fallback"})`);

  // Target expiry: ~35 日後の最初の金曜
  const today = new Date();
  today.setDate(today.getDate() + 35);
  const dow = today.getDay(); // 0 = Sun, 5 = Fri
  const offset = (5 - dow + 7) % 7;
  today.setDate(today.getDate() + offset);
  const yyyymmdd = today.toISOString().slice(0, 10).replace(/-/g, "");
  console.log(`    Target expiry: ${yyyymmdd}`);

  const chain = await client.getOptionChain("SPY", yyyymmdd, "P", atmStrike);
  console.log(`    Got ${chain.length} contracts. Top 5 by strike (descending):`);
  for (const opt of chain.sort((a, b) => b.strike - a.strike).slice(0, 5)) {
    console.log(
      `      strike=${opt.strike} bid=${opt.bid} ask=${opt.ask} delta=${
        opt.delta?.toFixed(3) ?? "-"
      } iv=${opt.impliedVol?.toFixed(3) ?? "-"}`,
    );
  }

  console.log("\n[7] Disconnecting...");
  await client.disconnect();
  console.log("    ✅ Disconnected");

  console.log("\n" + "=".repeat(60));
  console.log("✅ Smoke test passed");
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\n❌ Smoke test failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
