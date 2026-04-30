import { bsPutPrice } from "../../core/options-pricing";
import type { SimulatedSpread, USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";

export interface SpreadEvalContext {
  today: string;
  spotSpy: number;
  vix: number;
  config: Pick<USCreditSpreadBacktestConfig, "spreadWidth" | "profitTarget" | "stopLossMultiplier" | "riskFreeRate" | "ivScaleFactor">;
}

export type SpreadAction =
  | { action: "HOLD"; currentValue: number }
  | { action: "CLOSE"; reason: "profit_target" | "stop_loss"; currentValue: number }
  | { action: "EXPIRE"; reason: "expired_worthless" | "expired_max_loss" | "expired_partial"; finalValue: number };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function priceSpreadInternal(
  spotSpy: number,
  shortStrike: number,
  longStrike: number,
  tte: number,
  riskFreeRate: number,
  iv: number,
): number {
  const shortPx = bsPutPrice(spotSpy, shortStrike, tte, riskFreeRate, iv);
  const longPx = bsPutPrice(spotSpy, longStrike, tte, riskFreeRate, iv);
  return Math.max(shortPx - longPx, 0);
}

export function evaluateSpread(spread: SimulatedSpread, ctx: SpreadEvalContext): SpreadAction {
  const { today, spotSpy, vix, config } = ctx;
  const iv = (vix / 100) * config.ivScaleFactor;

  if (today >= spread.expirationDate) {
    const shortIntrinsic = Math.max(spread.shortStrike - spotSpy, 0);
    const longIntrinsic = Math.max(spread.longStrike - spotSpy, 0);
    const finalSpreadValue = Math.max(shortIntrinsic - longIntrinsic, 0);

    let reason: "expired_worthless" | "expired_max_loss" | "expired_partial";
    if (finalSpreadValue < 0.01) reason = "expired_worthless";
    else if (finalSpreadValue >= config.spreadWidth - 0.01) reason = "expired_max_loss";
    else reason = "expired_partial";

    return { action: "EXPIRE", reason, finalValue: finalSpreadValue };
  }

  const tte = Math.max(daysBetween(today, spread.expirationDate) / 365, 0);
  const currentSpreadPrice = priceSpreadInternal(
    spotSpy,
    spread.shortStrike,
    spread.longStrike,
    tte,
    config.riskFreeRate,
    iv,
  );

  const profitTargetPrice = spread.creditReceived * (1 - config.profitTarget);
  const stopLossPrice = config.stopLossMultiplier > 0
    ? spread.creditReceived * (1 + config.stopLossMultiplier)
    : Number.POSITIVE_INFINITY;

  if (currentSpreadPrice <= profitTargetPrice) {
    return { action: "CLOSE", reason: "profit_target", currentValue: currentSpreadPrice };
  } else if (currentSpreadPrice >= stopLossPrice) {
    return { action: "CLOSE", reason: "stop_loss", currentValue: currentSpreadPrice };
  } else {
    return { action: "HOLD", currentValue: currentSpreadPrice };
  }
}
