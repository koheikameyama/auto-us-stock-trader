export interface BuyOrderResult {
  shares: number;
  slippage: number;
  commission: number;
  cashRemaining: number;
}

export interface SellOrderResult {
  proceeds: number;
  slippage: number;
  commission: number;
  cashReceived: number;
}

/**
 * cash と price から購入株数を計算（slippage % と commission $ を控除）。
 * 端数は切り捨て（floor）。
 */
export function calculateBuyOrder(
  cash: number,
  price: number,
  slippagePct: number,
  commission: number
): BuyOrderResult {
  const slippage = cash * (slippagePct / 100);
  const usableCash = cash - commission - slippage;
  const shares = Math.max(0, Math.floor(usableCash / price));
  const cashRemaining = cash - shares * price - commission - slippage;
  return { shares, slippage, commission, cashRemaining };
}

/**
 * shares と price から売却で受け取る cash を計算（slippage % と commission $ を控除）。
 */
export function calculateSellOrder(
  shares: number,
  price: number,
  slippagePct: number,
  commission: number
): SellOrderResult {
  const proceeds = shares * price;
  const slippage = proceeds * (slippagePct / 100);
  const cashReceived = proceeds - commission - slippage;
  return { proceeds, slippage, commission, cashReceived };
}
