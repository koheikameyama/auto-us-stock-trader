import type { SimulatedRotationPosition } from "../us/us-dual-momentum-types";
import type { SimulatedSpread } from "../us/us-credit-spread-types";

/**
 * Dual Momentum の rotation positions を tail-test framework が期待する
 * SimulatedSpread 互換 shape に変換する踏み台 adapter。
 *
 * tail-test framework は equityCurve + spreads の組み合わせで動作するが、
 * SimulatedSpread 型は credit-spread 専用の field（shortStrike, creditReceived 等）を含む。
 * Phase 0 の最小工数アプローチとして、不要 field をダミー値で埋めて framework を流用する。
 *
 * Phase 1 で StrategyResult interface 抽象化を行ったら本ファイルは削除予定。
 */
export function rotationPositionsToSpreads(
  positions: SimulatedRotationPosition[],
): SimulatedSpread[] {
  return positions
    .filter(
      (p) =>
        p.exitReason === "rotation_exit" &&
        p.exitDate != null &&
        p.netPnl != null,
    )
    .map<SimulatedSpread>((p) => ({
      underlyingSymbol: p.ticker,
      entryDate: p.entryDate,
      expirationDate: p.exitDate ?? p.entryDate,
      entrySpotPrice: p.entryPrice,
      entryIV: 0,
      shortStrike: 0,
      longStrike: 0,
      shortDeltaAtEntry: 0,
      creditReceived: 0,
      contracts: p.shares,
      state: "CLOSED",
      closeDate: p.exitDate,
      // dummy: SpreadState の closeReason union に合わせる（rotation 決済を意味的に最も近い "expired_worthless" にマップ）
      closeReason: "expired_worthless",
      closeSpreadPrice: 0,
      netPnl: p.netPnl,
      totalCommissions: 0,
    }));
}
