import { bsPutPrice, bsCallPrice, skewedIvMonotonic } from "../../core/options-pricing";
import type { SimulatedCondor, USIronCondorBacktestConfig } from "../us/us-iron-condor-types";

export interface CondorEvalContext {
  today: string;
  spotSpy: number;
  vix: number;
  config: Pick<
    USIronCondorBacktestConfig,
    "spreadWidth" | "profitTarget" | "stopLossMultiplier" | "riskFreeRate" | "ivScaleFactor" | "putSkewSlope" | "callSkewSlope"
  >;
}

export type CondorAction =
  | { action: "HOLD"; currentValue: number }
  | { action: "CLOSE"; reason: "profit_target" | "stop_loss"; currentValue: number }
  | { action: "EXPIRE"; reason: "expired_worthless" | "expired_max_loss" | "expired_partial"; finalValue: number };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** 現在の condor 価格（買い戻しコスト, per share）= put spread + call spread、skew 適用 */
export function priceCondor(
  spotSpy: number,
  condor: Pick<SimulatedCondor, "putShortStrike" | "putLongStrike" | "callShortStrike" | "callLongStrike">,
  tte: number,
  riskFreeRate: number,
  iv: number,
  putSlope: number,
  callSlope: number,
): number {
  const ps = bsPutPrice(spotSpy, condor.putShortStrike, tte, riskFreeRate, skewedIvMonotonic(iv, spotSpy, condor.putShortStrike, putSlope));
  const pl = bsPutPrice(spotSpy, condor.putLongStrike, tte, riskFreeRate, skewedIvMonotonic(iv, spotSpy, condor.putLongStrike, putSlope));
  const cs = bsCallPrice(spotSpy, condor.callShortStrike, tte, riskFreeRate, skewedIvMonotonic(iv, spotSpy, condor.callShortStrike, callSlope));
  const cl = bsCallPrice(spotSpy, condor.callLongStrike, tte, riskFreeRate, skewedIvMonotonic(iv, spotSpy, condor.callLongStrike, callSlope));
  return Math.max(ps - pl, 0) + Math.max(cs - cl, 0);
}

/** 満期時の condor intrinsic（per share）: put spread + call spread。片側のみ ITM になり得る */
function condorIntrinsic(
  spotSpy: number,
  condor: Pick<SimulatedCondor, "putShortStrike" | "callShortStrike">,
  width: number,
): number {
  const put = Math.min(Math.max(condor.putShortStrike - spotSpy, 0), width);
  const call = Math.min(Math.max(spotSpy - condor.callShortStrike, 0), width);
  return put + call;
}

export function evaluateCondor(condor: SimulatedCondor, ctx: CondorEvalContext): CondorAction {
  const { today, spotSpy, vix, config } = ctx;
  const iv = (vix / 100) * config.ivScaleFactor;
  const putSlope = config.putSkewSlope ?? 0;
  const callSlope = config.callSkewSlope ?? 0;

  if (today >= condor.expirationDate) {
    const finalValue = condorIntrinsic(spotSpy, condor, config.spreadWidth);

    let reason: "expired_worthless" | "expired_max_loss" | "expired_partial";
    if (finalValue < 0.01) reason = "expired_worthless";
    else if (finalValue >= config.spreadWidth - 0.01) reason = "expired_max_loss";
    else reason = "expired_partial";

    return { action: "EXPIRE", reason, finalValue };
  }

  const tte = Math.max(daysBetween(today, condor.expirationDate) / 365, 0);
  const currentValue = priceCondor(spotSpy, condor, tte, config.riskFreeRate, iv, putSlope, callSlope);

  const profitTargetPrice = condor.creditReceived * (1 - config.profitTarget);
  const stopLossPrice = config.stopLossMultiplier > 0
    ? condor.creditReceived * (1 + config.stopLossMultiplier)
    : Number.POSITIVE_INFINITY;

  if (currentValue <= profitTargetPrice) {
    return { action: "CLOSE", reason: "profit_target", currentValue };
  } else if (currentValue >= stopLossPrice) {
    return { action: "CLOSE", reason: "stop_loss", currentValue };
  } else {
    return { action: "HOLD", currentValue };
  }
}
