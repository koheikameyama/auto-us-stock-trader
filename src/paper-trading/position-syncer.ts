// src/paper-trading/position-syncer.ts
import { PrismaClient } from "@prisma/client";
import type { IBKRPosition, IBKRClient } from "./ibkr-client";
import { withRetry } from "./with-retry";

export interface PositionMismatch {
  type: "DB_NOT_IN_IBKR" | "IBKR_NOT_IN_DB";
  symbol: string;
  shortStrike?: number;
  longStrike?: number;
  expiry?: string;
}

/** IBKR の qty=0 を除外、option PUT side だけ抽出 */
export function filterActivePutSpreadLegs(positions: IBKRPosition[]): IBKRPosition[] {
  return positions.filter(
    (p) => p.quantity !== 0 && p.secType === "OPT" && p.right === "P",
  );
}

/**
 * IBKR の保有 option position と DB の OPEN Position を突き合わせる。
 *
 * Bull Put Credit Spread 1 件 = 2 leg (short put + long put)。
 * IBKR の各 leg を spread として再構築できないため、
 * 「DB に OPEN な Position が IBKR に存在するか」のチェックに留める。
 */
export async function reconcilePositions(
  ibkr: IBKRClient,
  prisma: PrismaClient,
): Promise<{ mismatches: PositionMismatch[]; ibkrLegs: IBKRPosition[]; dbOpenPositions: number }> {
  const ibkrPositions = await withRetry(() => ibkr.getPositions(), { retries: 3, intervalMs: 5_000 });
  const ibkrLegs = filterActivePutSpreadLegs(ibkrPositions);

  const dbOpen = await prisma.position.findMany({ where: { state: "OPEN" } });

  const mismatches: PositionMismatch[] = [];

  for (const pos of dbOpen) {
    const expiryStr = pos.expiry.toISOString().slice(0, 10).replace(/-/g, "");
    const shortLeg = ibkrLegs.find(
      (l) => l.symbol === pos.symbol && l.strike === pos.shortStrike && l.expiry === expiryStr && l.quantity < 0,
    );
    const longLeg = ibkrLegs.find(
      (l) => l.symbol === pos.symbol && l.strike === pos.longStrike && l.expiry === expiryStr && l.quantity > 0,
    );

    if (!shortLeg || !longLeg) {
      mismatches.push({
        type: "DB_NOT_IN_IBKR",
        symbol: pos.symbol,
        shortStrike: pos.shortStrike,
        longStrike: pos.longStrike,
        expiry: expiryStr,
      });
    }
  }

  return { mismatches, ibkrLegs, dbOpenPositions: dbOpen.length };
}
