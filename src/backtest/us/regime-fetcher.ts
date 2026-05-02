// src/backtest/us/regime-fetcher.ts
/**
 * Backtest 用 RegimeSignal bulk fetch
 *
 * 全期間分の RegimeSignal を 1 クエリで取得し、date(YYYY-MM-DD) → {state, multiplier}
 * の Map を返す。simulation の per-day ループ内では Map.get で参照するだけ。
 */

import { prisma } from "../../lib/prisma";

export interface RegimeRecord {
  state: string;
  multiplier: number;
}

export type RegimeMap = Map<string, RegimeRecord>;

export async function fetchRegimeFromDB(
  startDate: string,
  endDate: string,
): Promise<RegimeMap> {
  const rows = await prisma.regimeSignal.findMany({
    where: {
      date: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
    },
    select: {
      date: true,
      combinedState: true,
      sizeMultiplier: true,
    },
  });

  const map: RegimeMap = new Map();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    map.set(key, { state: r.combinedState, multiplier: r.sizeMultiplier });
  }
  return map;
}
