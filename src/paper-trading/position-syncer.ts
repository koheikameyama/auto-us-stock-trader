// src/paper-trading/position-syncer.ts
import { PrismaClient } from "@prisma/client";
import type { AlpacaPosition, AlpacaClient } from "./alpaca-client";
import { withRetry } from "./with-retry";

export interface PositionMismatch {
  type: "DB_NOT_IN_BROKER" | "BROKER_NOT_IN_DB";
  symbol: string;
  shortStrike?: number;
  longStrike?: number;
  expiry?: string;
}

export interface ParsedOptionLeg {
  underlying: string;
  expiry: string; // YYYYMMDD
  right: "P" | "C";
  strike: number;
  side: "long" | "short";
  quantity: number;
}

const OCC_PATTERN = /^([A-Z]+)(\d{6})([PC])(\d{8})$/;

/** OCC symbol を分解。マッチしない場合は null。 */
export function parseOccSymbol(occ: string): Omit<ParsedOptionLeg, "side" | "quantity"> | null {
  const m = OCC_PATTERN.exec(occ);
  if (!m) return null;
  const yymmdd = m[2];
  const expiry = `20${yymmdd.slice(0, 2)}${yymmdd.slice(2)}`;
  return {
    underlying: m[1],
    expiry,
    right: m[3] as "P" | "C",
    strike: parseInt(m[4], 10) / 1000,
  };
}

/** Alpaca positions から PUT option leg のみ抽出して構造化。 */
export function extractActivePutLegs(positions: AlpacaPosition[]): ParsedOptionLeg[] {
  const legs: ParsedOptionLeg[] = [];
  for (const p of positions) {
    if (p.assetClass !== "us_option") continue;
    if (p.quantity === 0) continue;
    const parsed = parseOccSymbol(p.symbol);
    if (!parsed || parsed.right !== "P") continue;
    legs.push({
      ...parsed,
      side: p.side,
      quantity: p.quantity,
    });
  }
  return legs;
}

/**
 * Alpaca の保有 option position と DB の OPEN Position を突き合わせる。
 *
 * Bull Put Credit Spread 1 件 = 2 leg (short put + long put)。
 * 「DB に OPEN な Position が ブローカーに存在するか」のチェックに留める。
 */
export async function reconcilePositions(
  alpaca: AlpacaClient,
  prisma: PrismaClient,
): Promise<{ mismatches: PositionMismatch[]; brokerLegs: ParsedOptionLeg[]; dbOpenPositions: number }> {
  const positions = await withRetry(() => alpaca.getPositions(), { retries: 3, intervalMs: 5_000 });
  const brokerLegs = extractActivePutLegs(positions);

  const dbOpen = await prisma.position.findMany({ where: { state: "OPEN" } });

  const mismatches: PositionMismatch[] = [];

  for (const pos of dbOpen) {
    const expiryStr = pos.expiry.toISOString().slice(0, 10).replace(/-/g, "");
    const shortLeg = brokerLegs.find(
      (l) => l.underlying === pos.symbol && l.strike === pos.shortStrike && l.expiry === expiryStr && l.side === "short",
    );
    const longLeg = brokerLegs.find(
      (l) => l.underlying === pos.symbol && l.strike === pos.longStrike && l.expiry === expiryStr && l.side === "long",
    );

    if (!shortLeg || !longLeg) {
      mismatches.push({
        type: "DB_NOT_IN_BROKER",
        symbol: pos.symbol,
        shortStrike: pos.shortStrike,
        longStrike: pos.longStrike,
        expiry: expiryStr,
      });
    }
  }

  return { mismatches, brokerLegs, dbOpenPositions: dbOpen.length };
}
