/**
 * 米国株取引コストモデル
 *
 * - 手数料: $0（コミッション無料ブローカー前提）
 * - SEC fee: 売却時のみ $27.80 / $1M（2024年時点）
 * - スプレッドコスト: 0.05% × 2（往復）
 * - 税金: バックテストでは非モデル化
 */

/** SEC 規制手数料レート（売却時のみ） */
const SEC_FEE_RATE = 0.0000278; // $27.80 per $1M

/** 推定スプレッドコスト（片道） */
const SPREAD_COST_PCT = 0.0005; // 0.05%

/**
 * 米国株の手数料を算出（常に$0）
 */
export function calculateUSCommission(_tradeValue: number): number {
  return 0;
}

/**
 * 米国株の取引コストを算出（スプレッド + SEC fee）
 */
export function calculateUSTransactionCosts(
  tradeValue: number,
  isSell: boolean,
): number {
  let cost = tradeValue * SPREAD_COST_PCT;
  if (isSell) {
    cost += tradeValue * SEC_FEE_RATE;
  }
  return cost;
}

/**
 * 米国株の税額を算出（バックテストではゼロ）
 */
export function calculateUSTax(_grossPnl: number, _totalCost: number): number {
  return 0;
}
