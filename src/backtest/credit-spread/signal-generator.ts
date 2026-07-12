import dayjs from "dayjs";
import { bsPutPrice, findStrikeForTargetDelta, skewedPutIv } from "../../core/options-pricing";
import type { USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";

const CONTRACT_SIZE = 100;

export interface EntryContext {
  today: string;
  gspc: number;
  spotSpy: number;
  vix: number;
  smaGspc: number | null;
  cash: number;
  openPositionCount: number;
  ddStopActive: boolean;
  tradingDays: string[];
  config: USCreditSpreadBacktestConfig;
}

export type EntryResult =
  | {
      reason: "ENTERED";
      shortStrike: number;
      longStrike: number;
      expirationDate: string;
      estimatedCredit: number;
      shortDelta: number;
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

export function generateEntrySignal(ctx: EntryContext): EntryResult {
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
  const shortInfo = findStrikeForTargetDelta({
    spotPrice: spotSpy,
    targetDelta: -Math.abs(config.shortPutDelta),
    tte,
    riskFreeRate: config.riskFreeRate,
    iv,
    optionType: "put",
    strikeStep: 1,
  });
  const shortStrike = shortInfo.strike;
  const longStrike = shortStrike - config.spreadWidth;
  if (longStrike <= 0) return { reason: "SKIP_INVALID_STRIKE" };

  // strike 選択は flat IV（live と同じ delta ベース）。クレジット評価だけ skew を適用する。
  const slope = config.ivSkewSlope ?? 0;
  const shortPremium =
    slope > 0
      ? bsPutPrice(spotSpy, shortStrike, tte, config.riskFreeRate, skewedPutIv(iv, spotSpy, shortStrike, slope))
      : shortInfo.premium;
  const longPremium = bsPutPrice(
    spotSpy,
    longStrike,
    tte,
    config.riskFreeRate,
    slope > 0 ? skewedPutIv(iv, spotSpy, longStrike, slope) : iv,
  );
  // 実 fill の薄さ: skew（moneyness 依存）+ 固定 slippage（mid 割れ）
  const credit = shortPremium - longPremium - (config.entrySlippage ?? 0);
  if (credit <= 0.05) return { reason: "SKIP_LOW_CREDIT" };

  const collateralRequired = config.spreadWidth * CONTRACT_SIZE * config.contractsPerSpread;
  if (cash < collateralRequired + 50) return { reason: "SKIP_INSUFFICIENT_CASH" };

  return {
    reason: "ENTERED",
    shortStrike,
    longStrike,
    expirationDate,
    estimatedCredit: credit,
    shortDelta: shortInfo.delta,
  };
}
