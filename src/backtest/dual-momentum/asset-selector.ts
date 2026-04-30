export interface MomentumRanking {
  ticker: string;
  momentum: number;
}

export interface AssetSelectionResult {
  selected: string;
  reason: "best_equity" | "risk_off";
  sortedRankings: MomentumRanking[];
}

/**
 * モメンタムランキングと絶対モメンタム閾値から保有資産を選択。
 * 最高モメンタムが閾値を超えていれば株式、そうでなければ risk-off へ退避。
 */
export function selectMomentumAsset(
  rankings: MomentumRanking[],
  absoluteMomentumThreshold: number,
  riskOffAsset: string
): AssetSelectionResult {
  const sorted = [...rankings].sort((a, b) => b.momentum - a.momentum);

  if (sorted.length > 0 && sorted[0].momentum > absoluteMomentumThreshold) {
    return { selected: sorted[0].ticker, reason: "best_equity", sortedRankings: sorted };
  }
  return { selected: riskOffAsset, reason: "risk_off", sortedRankings: sorted };
}
