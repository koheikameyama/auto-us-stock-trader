// src/paper-trading/skew-calibrator.ts
/**
 * SPY option chain（Alpaca 市場クォート）から IV skew slope を測定する共通ロジック。
 * CLI（calibrate-skew.ts）と日次記録（record-skew.ts）が共有する。**発注は一切しない**。
 *
 * モデル: iv(strike) = baseIv * (1 + slope * (spot - strike) / spot)
 *   → slope = Σ(x·y) / Σ(x²)   （x=(spot-strike)/spot, y=iv/baseIv - 1、原点回帰）
 * put 側（strike<spot）と call 側（strike>spot）で別々にフィットする。
 */

import dayjs from "dayjs";
import type { AlpacaClient, OptionContract } from "./alpaca-client";

/** 取引 strike 帯（|δ| 0.12〜0.30 = 0.20δ 近傍）*/
export const DELTA_BAND = { min: 0.12, max: 0.3 } as const;

export interface SlopeFit {
  /** 原点回帰の傾き。サンプル 0 件なら NaN */
  slope: number;
  n: number;
}

export interface SkewPoint {
  strike: number;
  /** (spot - strike) / spot */
  x: number;
  iv: number;
  delta: number | null;
}

export interface SkewCalibration {
  expiry: string; // YYYY-MM-DD
  dte: number;
  spot: number;
  baseIv: number;
  put: { all: SlopeFit; band: SlopeFit };
  call: { all: SlopeFit; band: SlopeFit };
  overall: SlopeFit;
  /** 生 smile。後から別の band 定義で再フィットできるよう全点を保持する */
  points: SkewPoint[];
}

/** 原点回帰で slope をフィット */
export function fitSlope(points: { x: number; y: number }[]): SlopeFit {
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += p.x * p.x;
    sxy += p.x * p.y;
  }
  return { slope: sxx > 0 ? sxy / sxx : NaN, n: points.length };
}

/** `dte` 日後の最初の金曜（ローカル暦） */
export function expiryForDte(dte: number, from: dayjs.Dayjs = dayjs()): string {
  const target = from.add(dte, "day");
  return target.add((5 - target.day() + 7) % 7, "day").format("YYYY-MM-DD");
}

const inBand = (p: SkewPoint): boolean =>
  p.delta != null && Math.abs(p.delta) >= DELTA_BAND.min && Math.abs(p.delta) <= DELTA_BAND.max;

const dedupe = (arr: OptionContract[]): OptionContract[] => {
  const seen = new Set<string>();
  return arr.filter((c) => (seen.has(c.occSymbol) ? false : (seen.add(c.occSymbol), true)));
};

/**
 * 市場クォートから skew を較正する。
 * IV 付きの契約が 1 件も取れなかった場合（市場休場等）は null を返す。
 */
export async function calibrateSkew(
  client: AlpacaClient,
  dte = 35,
  from: dayjs.Dayjs = dayjs(),
): Promise<SkewCalibration | null> {
  const spyQuote = await client.getMarketPrice("SPY");
  const spot =
    spyQuote.bid != null && spyQuote.ask != null
      ? (spyQuote.bid + spyQuote.ask) / 2
      : (spyQuote.bid ?? spyQuote.ask);
  if (spot == null) throw new Error("SPY spot 取得失敗");
  const atm = Math.round(spot);
  const expiry = expiryForDte(dte, from);

  // ATM + 両 wing（±30 中心）を fetch し 0.20δ の取引 strike まで届かせる
  const puts = dedupe([
    ...(await client.getOptionChain("SPY", expiry, "P", atm)),
    ...(await client.getOptionChain("SPY", expiry, "P", atm - 30)),
  ]).filter((c) => c.impliedVol != null && c.impliedVol > 0);
  const calls = dedupe([
    ...(await client.getOptionChain("SPY", expiry, "C", atm)),
    ...(await client.getOptionChain("SPY", expiry, "C", atm + 30)),
  ]).filter((c) => c.impliedVol != null && c.impliedVol > 0);

  if (puts.length === 0 && calls.length === 0) return null;

  // ATM 基準 IV: spot に最も近い strike の IV（put/call 平均）
  const nearest = (arr: OptionContract[]): OptionContract =>
    arr.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
  const baseIv =
    puts.length && calls.length
      ? (nearest(puts).impliedVol! + nearest(calls).impliedVol!) / 2
      : nearest([...puts, ...calls]).impliedVol!;

  const toPoint = (c: OptionContract): SkewPoint => ({
    strike: c.strike,
    x: (spot - c.strike) / spot,
    iv: c.impliedVol!,
    delta: c.delta,
  });
  const withY = (p: SkewPoint) => ({ x: p.x, y: p.iv / baseIv - 1 });

  const putPts = puts.map(toPoint);
  const callPts = calls.map(toPoint);

  return {
    expiry,
    dte,
    spot,
    baseIv,
    put: { all: fitSlope(putPts.map(withY)), band: fitSlope(putPts.filter(inBand).map(withY)) },
    call: { all: fitSlope(callPts.map(withY)), band: fitSlope(callPts.filter(inBand).map(withY)) },
    overall: fitSlope([...putPts, ...callPts].map(withY)),
    points: [...putPts, ...callPts].sort((a, b) => a.strike - b.strike),
  };
}
