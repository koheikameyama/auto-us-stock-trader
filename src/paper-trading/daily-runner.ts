// src/paper-trading/daily-runner.ts
/**
 * IBKR Paper Trading 日次実行
 *
 * Usage:
 *   npx tsx src/paper-trading/daily-runner.ts                 # 通常実行
 *   npx tsx src/paper-trading/daily-runner.ts --dry-run        # 発注スキップ
 */

import { PrismaClient } from "@prisma/client";
import { IBKRClient } from "./ibkr-client";
import { isKillSwitchActive, getKillSwitchInfo } from "./kill-switch";
import { reconcilePositions } from "./position-syncer";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

async function main() {
  const startTime = new Date();
  console.log(`[${startTime.toISOString()}] Daily runner start (dry-run=${DRY_RUN})`);

  // ── 1. kill switch チェック ──
  if (isKillSwitchActive()) {
    const info = getKillSwitchInfo();
    console.log(`⏸ Kill switch active: ${info.reason} (since ${info.createdAt?.toISOString()})`);
    process.exit(0);
  }

  const prisma = new PrismaClient();
  const ibkr = new IBKRClient({ clientId: 100 });

  // ── 2. IBKR 接続 + アカウント情報 ──
  console.log("Connecting to IBKR TWS...");
  await ibkr.connect();
  const accountSummary = await ibkr.getAccountSummary();
  console.log(`Account: NetLiq=$${accountSummary.netLiquidation.toLocaleString()}, BP=$${accountSummary.buyingPower.toLocaleString()}`);

  // ── 3. 既存ポジション同期 ──
  console.log("Reconciling positions...");
  const { mismatches, ibkrLegs, dbOpenPositions } = await reconcilePositions(ibkr, prisma);
  console.log(`  IBKR active legs: ${ibkrLegs.length}`);
  console.log(`  DB OPEN positions: ${dbOpenPositions}`);
  if (mismatches.length > 0) {
    console.error(`⚠ ${mismatches.length} position mismatches detected:`);
    for (const m of mismatches) {
      console.error(`  ${m.type}: ${m.symbol} ${m.shortStrike}/${m.longStrike} ${m.expiry}`);
    }
  }

  // TODO: ステップ 4-9 を後続タスクで追加

  await ibkr.disconnect();
  await prisma.$disconnect();

  const elapsed = Date.now() - startTime.getTime();
  console.log(`[${new Date().toISOString()}] Daily runner end (elapsed ${elapsed}ms)`);
}

main()
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error("❌ Daily runner failed:", e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
