import dayjs from "dayjs";
import {
  bsPutPrice,
  bsCallPrice,
  findStrikeForTargetDelta,
  skewedIvMonotonic,
} from "../../core/options-pricing";
import type { USIronCondorBacktestConfig } from "../us/us-iron-condor-types";

const CONTRACT_SIZE = 100;

export interface CondorEntryContext {
  today: string;
  gspc: number;
  spotSpy: number;
  vix: number;
  smaGspc: number | null;
  cash: number;
  openPositionCount: number;
  ddStopActive: boolean;
  tradingDays: string[];
  config: USIronCondorBacktestConfig;
}

export type CondorEntryResult =
  | {
      reason: "ENTERED";
      putShortStrike: number;
      putLongStrike: number;
      callShortStrike: number;
      callLongStrike: number;
      expirationDate: string;
      putCredit: number;
      callCredit: number;
      /** putCredit + callCredit（skew + slippage 込み） */
      estimatedCredit: number;
      putShortDelta: number;
      callShortDelta: number;
    }
  | {
      reason:
        | "SKIP_MAX_POSITIONS"
        | "SKIP_DD_STOP"
        | "SKIP_VIX_CAP"
        | "SKIP_TREND_FILTER"
        | "SKIP_INSUFFICIENT_CASH"
        | "SKIP_LOW_CREDIT"
        | "SKIP_INVALID_STRIKE";
    };

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

function findExpirationDate(entryDate: string, dte: number, tradingDays: string[]): string {
  const target = dayjs(entryDate).add(dte, "day").format("YYYY-MM-DD");
  for (const d of tradingDays) {
    if (d >= target) return d;
  }
  return tradingDays[tradingDays.length - 1];
}

export function generateCondorEntrySignal(ctx: CondorEntryContext): CondorEntryResult {
  const { today, gspc, spotSpy, vix, smaGspc, cash, openPositionCount, ddStopActive, tradingDays, config } = ctx;

  if (openPositionCount >= config.maxPositions) return { reason: "SKIP_MAX_POSITIONS" };
  if (ddStopActive) return { reason: "SKIP_DD_STOP" };
  if (vix > config.vixCap) return { reason: "SKIP_VIX_CAP" };
  if (config.indexTrendFilter) {
    if (smaGspc == null || gspc < smaGspc) return { reason: "SKIP_TREND_FILTER" };
  }

  const expirationDate = findExpirationDate(today, config.dte, tradingDays);
  const tte = Math.max(daysBetween(today, expirationDate) / 365, 0);
  if (tte <= 0) return { reason: "SKIP_INVALID_STRIKE" };

  const iv = (vix / 100) * config.ivScaleFactor;
  const r = config.riskFreeRate;
  const width = config.spreadWidth;
  const slip = config.entrySlippage ?? 0;
  const putSlope = config.putSkewSlope ?? 0;
  const callSlope = config.callSkewSlope ?? 0;

  // strike 選択は flat IV（live と同じ delta ベース）。クレジット評価だけ skew を適用する。
  const putInfo = findStrikeForTargetDelta({
    spotPrice: spotSpy,
    targetDelta: -Math.abs(config.shortDelta),
    tte,
    riskFreeRate: r,
    iv,
    optionType: "put",
    strikeStep: 1,
  });
  const callInfo = findStrikeForTargetDelta({
    spotPrice: spotSpy,
    targetDelta: Math.abs(config.shortDelta),
    tte,
    riskFreeRate: r,
    iv,
    optionType: "call",
    strikeStep: 1,
  });

  const putShortStrike = putInfo.strike;
  const putLongStrike = putShortStrike - width;
  const callShortStrike = callInfo.strike;
  const callLongStrike = callShortStrike + width;
  if (putLongStrike <= 0) return { reason: "SKIP_INVALID_STRIKE" };

  // put credit（skew 適用: 低 strike ほど IV↑）
  const putCredit =
    bsPutPrice(spotSpy, putShortStrike, tte, r, skewedIvMonotonic(iv, spotSpy, putShortStrike, putSlope)) -
    bsPutPrice(spotSpy, putLongStrike, tte, r, skewedIvMonotonic(iv, spotSpy, putLongStrike, putSlope)) -
    slip;
  // call credit（skew 適用: 高 strike ほど IV↓）
  const callCredit =
    bsCallPrice(spotSpy, callShortStrike, tte, r, skewedIvMonotonic(iv, spotSpy, callShortStrike, callSlope)) -
    bsCallPrice(spotSpy, callLongStrike, tte, r, skewedIvMonotonic(iv, spotSpy, callLongStrike, callSlope)) -
    slip;
  const estimatedCredit = putCredit + callCredit;
  if (estimatedCredit <= 0.1) return { reason: "SKIP_LOW_CREDIT" };

  // collateral は片側分（put/call は同時に max loss にならない）
  const collateralRequired = width * CONTRACT_SIZE * config.contractsPerCondor;
  if (cash < collateralRequired + 50) return { reason: "SKIP_INSUFFICIENT_CASH" };

  return {
    reason: "ENTERED",
    putShortStrike,
    putLongStrike,
    callShortStrike,
    callLongStrike,
    expirationDate,
    putCredit,
    callCredit,
    estimatedCredit,
    putShortDelta: putInfo.delta,
    callShortDelta: callInfo.delta,
  };
}
