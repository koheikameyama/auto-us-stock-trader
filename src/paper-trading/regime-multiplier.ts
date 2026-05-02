// src/paper-trading/regime-multiplier.ts
import type { PrismaClient } from "@prisma/client";

export interface RegimeMultiplier {
  multiplier: number;
  state: string | null;
  ratios: { xlyXlpState: string; xlkXluState: string } | null;
}

const FAIL_SAFE: RegimeMultiplier = { multiplier: 1.0, state: null, ratios: null };

export async function getRegimeMultiplier(
  prisma: PrismaClient,
  date: string,
): Promise<RegimeMultiplier> {
  const signal = await prisma.regimeSignal.findUnique({
    where: { date: new Date(date) },
  });
  if (!signal) return FAIL_SAFE;
  return {
    multiplier: signal.sizeMultiplier,
    state: signal.combinedState,
    ratios: { xlyXlpState: signal.xlyXlpState, xlkXluState: signal.xlkXluState },
  };
}

export function scaleContracts(baseContracts: number, multiplier: number): number {
  return Math.floor(baseContracts * multiplier);
}
