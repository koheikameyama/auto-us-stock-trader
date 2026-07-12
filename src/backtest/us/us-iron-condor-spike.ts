// src/backtest/us/us-iron-condor-spike.ts
/**
 * Iron Condor feasibility spike（本番実装ではなく edge 有無の当たり付け）
 *
 * put credit spread（既存）に bear call credit spread を足した Iron Condor を、
 * credit-spread と同じフィルタ（trend SMA50 / vixCap / DD hard stop）と
 * skew+slippage 忠実度モデルで 2007〜シミュレートし、CAGR/PF/勝率/MaxDD/CVaR を出す。
 *
 * 前提・caveat:
 * - collateral は片側分（width×100）= IC は同 collateral で ~2倍 credit を取れる
 * - skew は単調 equity skew（skewedIvMonotonic, slope は put 較正の 5.5 を全脚に流用）。
 *   **call 側の skew は live 実 fill で未較正** — put 側ほど信頼できない点に注意。
 * - slippage は片側 $0.04 → IC entry で $0.08
 *
 * Usage:
 *   npx tsx src/backtest/us/us-iron-condor-spike.ts --start 2007-01-03 --end 2026-04-28
 *   （--call-slope N で call 側 skew slope を上書き。デフォルト=put と同じ 5.5）
 */

import { fetchSP500FromDB, fetchVixFromDB } from "./us-data-fetcher";
import {
  bsPutPrice,
  bsCallPrice,
  findStrikeForTargetDelta,
  skewedIvMonotonic,
} from "../../core/options-pricing";
import { calcDDStopState, type DDStopPrevState } from "../credit-spread/dd-stop";
import { US_CREDIT_SPREAD_DEFAULTS, US_CREDIT_SPREAD_BACKTEST_FIDELITY } from "./us-credit-spread-config";

const CONTRACT = 100;

interface Condor {
  entryDate: string;
  expirationDate: string;
  putShort: number;
  putLong: number;
  callShort: number;
  callLong: number;
  totalCredit: number; // per share (put+call)
  contracts: number;
  state: "OPEN" | "CLOSED";
  netPnl?: number;
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

function findExpiration(entry: string, dte: number, tradingDays: string[]): string {
  const target = new Date(new Date(entry).getTime() + dte * 86_400_000).toISOString().slice(0, 10);
  for (const d of tradingDays) if (d >= target) return d;
  return tradingDays[tradingDays.length - 1];
}

/** 現在の condor value（買い戻しコスト, per share）: put spread + call spread、skew 適用 */
function condorValue(c: Condor, spot: number, tte: number, r: number, iv: number, putSlope: number, callSlope: number): number {
  const ps = bsPutPrice(spot, c.putShort, tte, r, skewedIvMonotonic(iv, spot, c.putShort, putSlope));
  const pl = bsPutPrice(spot, c.putLong, tte, r, skewedIvMonotonic(iv, spot, c.putLong, putSlope));
  const cs = bsCallPrice(spot, c.callShort, tte, r, skewedIvMonotonic(iv, spot, c.callShort, callSlope));
  const cl = bsCallPrice(spot, c.callLong, tte, r, skewedIvMonotonic(iv, spot, c.callLong, callSlope));
  return Math.max(ps - pl, 0) + Math.max(cs - cl, 0);
}

function condorIntrinsic(c: Condor, spot: number, width: number): number {
  const put = Math.min(Math.max(c.putShort - spot, 0), width);
  const call = Math.min(Math.max(spot - c.callShort, 0), width);
  return put + call;
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (n: string) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  const startDate = getArg("start") ?? "2007-01-03";
  const endDate = getArg("end") ?? "2026-04-28";
  const cfg = { ...US_CREDIT_SPREAD_DEFAULTS, ...US_CREDIT_SPREAD_BACKTEST_FIDELITY };
  const putSlope = cfg.ivSkewSlope ?? 0;
  const callSlope = getArg("call-slope") ? Number(getArg("call-slope")) : putSlope;
  const slip = cfg.entrySlippage ?? 0;
  const width = cfg.spreadWidth;
  const r = cfg.riskFreeRate;

  console.log("=".repeat(60));
  console.log("Iron Condor Feasibility Spike");
  console.log("=".repeat(60));
  console.log(`Period: ${startDate} ~ ${endDate}`);
  console.log(`put skew=${putSlope} | call skew=${callSlope} | slippage=$${slip}/side | width=$${width} | δ=${cfg.shortPutDelta} | DTE=${cfg.dte}`);

  const gspcData = await fetchSP500FromDB(startDate, endDate);
  const vixData = await fetchVixFromDB(startDate, endDate);
  const tradingDays = [...gspcData.keys()].filter((d) => d >= startDate && d <= endDate).sort();

  // SMA50 cache
  const allDays = [...gspcData.keys()].sort();
  const smaCache = new Map<string, number>();
  const P = cfg.indexTrendSmaPeriod;
  for (let i = P - 1; i < allDays.length; i++) {
    let s = 0;
    for (let j = 0; j < P; j++) s += gspcData.get(allDays[i - j])!;
    smaCache.set(allDays[i], s / P);
  }

  let cash = cfg.initialBudget;
  let dd: DDStopPrevState = { runningPeak: cfg.initialBudget, ddStopActive: false, ddStopActivatedDate: null };
  const open: Condor[] = [];
  const closed: Condor[] = [];
  const equity: number[] = [];

  for (const today of tradingDays) {
    const gspc = gspcData.get(today);
    const vix = vixData.get(today);
    if (gspc == null || vix == null) continue;
    const spot = gspc / 10;
    const iv = (vix / 100) * cfg.ivScaleFactor;

    // 1. 既存 condor の評価・クローズ
    const still: Condor[] = [];
    for (const c of open) {
      if (today >= c.expirationDate) {
        const val = condorIntrinsic(c, spot, width);
        const pnl = (c.totalCredit - val) * CONTRACT * c.contracts - cfg.optionsCommission * 4 * c.contracts;
        cash += width * CONTRACT * c.contracts - val * CONTRACT * c.contracts;
        c.state = "CLOSED"; c.netPnl = pnl; closed.push(c);
        continue;
      }
      const tte = Math.max(daysBetween(today, c.expirationDate) / 365, 0);
      const val = condorValue(c, spot, tte, r, iv, putSlope, callSlope);
      const ptPrice = c.totalCredit * (1 - cfg.profitTarget);
      const slPrice = cfg.stopLossMultiplier > 0 ? c.totalCredit * cfg.stopLossMultiplier : Infinity;
      if (val <= ptPrice || val >= slPrice) {
        const pnl = (c.totalCredit - val) * CONTRACT * c.contracts - cfg.optionsCommission * 8 * c.contracts;
        cash += width * CONTRACT * c.contracts - val * CONTRACT * c.contracts;
        c.state = "CLOSED"; c.netPnl = pnl; closed.push(c);
      } else {
        still.push(c);
      }
    }
    open.length = 0; open.push(...still);

    // 2. DD hard stop 状態
    let unreal = 0;
    for (const c of open) {
      const tte = Math.max(daysBetween(today, c.expirationDate) / 365, 0);
      unreal += width * CONTRACT * c.contracts - condorValue(c, spot, tte, r, iv, putSlope, callSlope) * CONTRACT * c.contracts;
    }
    const ddState = calcDDStopState({ today, totalEquity: cash + unreal, prevState: dd, config: cfg });
    dd = ddState;

    // 3. entry
    const sma = smaCache.get(today) ?? null;
    const trendOk = !cfg.indexTrendFilter || (sma != null && gspc >= sma);
    if (open.length < cfg.maxPositions && !ddState.ddStopActive && vix <= cfg.vixCap && trendOk) {
      const expiration = findExpiration(today, cfg.dte, tradingDays);
      const tte = Math.max(daysBetween(today, expiration) / 365, 0);
      if (tte > 0) {
        // put 側 delta -0.20, call 側 delta +0.20（strike 選択は flat IV = live と同じ）
        const putS = findStrikeForTargetDelta({ spotPrice: spot, targetDelta: -cfg.shortPutDelta, tte, riskFreeRate: r, iv, optionType: "put", strikeStep: 1 }).strike;
        const callS = findStrikeForTargetDelta({ spotPrice: spot, targetDelta: cfg.shortPutDelta, tte, riskFreeRate: r, iv, optionType: "call", strikeStep: 1 }).strike;
        const putL = putS - width;
        const callL = callS + width;
        if (putL > 0) {
          const putCredit =
            bsPutPrice(spot, putS, tte, r, skewedIvMonotonic(iv, spot, putS, putSlope)) -
            bsPutPrice(spot, putL, tte, r, skewedIvMonotonic(iv, spot, putL, putSlope)) - slip;
          const callCredit =
            bsCallPrice(spot, callS, tte, r, skewedIvMonotonic(iv, spot, callS, callSlope)) -
            bsCallPrice(spot, callL, tte, r, skewedIvMonotonic(iv, spot, callL, callSlope)) - slip;
          const totalCredit = putCredit + callCredit;
          const collateral = width * CONTRACT * cfg.contractsPerSpread; // 片側分
          if (totalCredit > 0.1 && cash >= collateral + 50) {
            cash -= collateral;
            cash += totalCredit * CONTRACT * cfg.contractsPerSpread;
            cash -= cfg.optionsCommission * 4 * cfg.contractsPerSpread; // entry 4 legs
            open.push({ entryDate: today, expirationDate: expiration, putShort: putS, putLong: putL, callShort: callS, callLong: callL, totalCredit, contracts: cfg.contractsPerSpread, state: "OPEN" });
          }
        }
      }
    }

    // 4. equity
    let uv = 0;
    for (const c of open) {
      const tte = Math.max(daysBetween(today, c.expirationDate) / 365, 0);
      uv += width * CONTRACT * c.contracts - condorValue(c, spot, tte, r, iv, putSlope, callSlope) * CONTRACT * c.contracts;
    }
    equity.push(cash + uv);
  }

  // ── メトリクス ──
  const initial = cfg.initialBudget;
  const finalEq = equity[equity.length - 1] ?? initial;
  const years = tradingDays.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / initial, 1 / years) - 1 : 0;
  const pnls = closed.map((c) => c.netPnl ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const pf = losses.length ? wins.reduce((s, x) => s + x, 0) / Math.abs(losses.reduce((s, x) => s + x, 0)) : Infinity;
  const winRate = pnls.length ? wins.length / pnls.length : 0;
  let peak = -Infinity, maxDD = 0;
  for (const e of equity) { if (e > peak) peak = e; const d = (peak - e) / peak; if (d > maxDD) maxDD = d; }
  const sorted = [...pnls].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(sorted.length * 0.05));
  const cvar = sorted.slice(0, k).reduce((s, x) => s + x, 0) / k;

  console.log("\n" + "=".repeat(60));
  console.log("Iron Condor 結果（skew+slippage 込み）");
  console.log("=".repeat(60));
  console.log(`Total condors:  ${closed.length}`);
  console.log(`Win Rate:       ${(winRate * 100).toFixed(1)}%   (閾値 ≥70%)`);
  console.log(`Profit Factor:  ${pf.toFixed(2)}   (閾値 ≥1.3)`);
  console.log(`CAGR:           ${(cagr * 100).toFixed(2)}%   (閾値 ≥10%)`);
  console.log(`Max DD:         ${(maxDD * 100).toFixed(1)}%   (閾値 ≤25%)`);
  console.log(`CVaR 5%:        $${cvar.toFixed(0)}   (閾値 ≥ -$250)`);
  console.log(`Final equity:   $${finalEq.toFixed(0)}  (initial $${initial})`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
