/**
 * VIX レジームに応じた Momentum ポジションサイズ調整（純関数）。
 *
 * - normal: 基準値そのまま
 * - elevated: 半減（最低 1 株）
 * - crisis: 基準値そのまま（呼び出し側で entry 自体を block する設計）
 *
 * 注: pead/quantity-adjuster.ts と意味的に同一だが、Phase 2-B では DRY YAGNI で独立保持。
 */

import type { RegimeLevel } from "../types";

/**
 * 基準数量にレジーム調整を適用した最終数量を返す。
 * elevated 時のみ floor(quantity/2) で半減し、最低 1 株を保証。
 */
export function adjustMomentumQuantityForRegime(
  quantity: number,
  regime: RegimeLevel,
): number {
  if (regime === "elevated") {
    return Math.max(1, Math.floor(quantity / 2));
  }
  return quantity;
}
