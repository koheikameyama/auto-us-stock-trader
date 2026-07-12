/**
 * 公開ページで共有する「開示可能な成績スナップショット」（米国株版）。
 *
 * 相場局面モニターの運用実績セクションの単一ソース。開示範囲は % と局面情報のみ:
 *   - 銘柄名・strike・絶対額は返さない
 *
 * 核は「仕込み時の局面」の復元。決済トレードごとに Position.entryDate 時点の局面を
 * detectRegimeShift({ asOfDate }) で復元して添える（当日の局面と混同しないため）。
 *
 * データソース: Position（state=CLOSED, netPnl）と DailyEquitySnapshot（totalEquity）。
 * paper trading の実ポジションが未蓄積（Phase F）でも、空スナップショットを安全に返す。
 */

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { prisma } from "../lib/prisma";
import {
  detectRegimeShift,
  getLevelEmoji,
  type SignalLevel,
} from "./regime-shift-detector";

dayjs.extend(utc);

/** 仕込み日時点の局面（局面モニター復元値） */
export interface EntryContext {
  date: string;
  breadthPct: number;
  level: SignalLevel;
  emoji: string;
}

/** 決済済みトレード1件分の開示可能情報 */
export interface ClosedTradePerf {
  /** per-trade 損益率（%、口座残高比）。equity が無ければ collateral 比 */
  returnPct: number;
  entryDate: string;
  exitDate: string;
  /** 仕込み日の局面。復元失敗時は null（表示側で省略） */
  entry: EntryContext | null;
}

export interface PerformanceSnapshot {
  /** 今月決済分。決済ゼロなら null */
  month: { wins: number; losses: number; pf: number | null } | null;
  /** 運用開始からの累計リターン%（DailyEquitySnapshot 比）。算出不能なら null */
  cumulativeReturnPct: number | null;
  /** 直近の決済（新しい順、公開ページの実績リスト用） */
  recentClosed: ClosedTradePerf[];
}

interface ClosedRow {
  shortStrike: number;
  longStrike: number;
  contracts: number;
  netPnl: number | null;
  entryDate: Date;
  closeDate: Date | null;
}

const CONTRACT_SIZE = 100;

function jstDateOf(d: Date): string {
  return dayjs.utc(d).format("YYYY-MM-DD");
}

/** 決済分の Profit Factor（Σ利益 / Σ損失、netPnl ベース）。 */
function profitFactor(rows: ClosedRow[]): number | null {
  let gross = 0;
  let loss = 0;
  for (const r of rows) {
    const pnl = r.netPnl ?? 0;
    if (pnl >= 0) gross += pnl;
    else loss += -pnl;
  }
  if (loss === 0) return gross > 0 ? Infinity : null;
  return gross / loss;
}

/**
 * 仕込み日の局面復元は detectRegimeShift（DB 読み）を日付ごとに叩くため、
 * 確定済みの過去日のみプロセス内でメモ化する。
 */
const entryContextMemo = new Map<string, EntryContext>();
const ENTRY_CONTEXT_MEMO_MAX = 60;

async function getEntryContext(dateStr: string): Promise<EntryContext | null> {
  const memoized = entryContextMemo.get(dateStr);
  if (memoized) return memoized;

  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const regime = await detectRegimeShift({
      asOfDate: new Date(Date.UTC(y, m - 1, d)),
    });
    const ctx: EntryContext = {
      date: dateStr,
      breadthPct: regime.current.breadth * 100,
      level: regime.level,
      emoji: getLevelEmoji(regime.level),
    };
    if (dateStr < dayjs.utc().format("YYYY-MM-DD")) {
      if (entryContextMemo.size >= ENTRY_CONTEXT_MEMO_MAX) {
        const oldest = entryContextMemo.keys().next().value;
        if (oldest !== undefined) entryContextMemo.delete(oldest);
      }
      entryContextMemo.set(dateStr, ctx);
    }
    return ctx;
  } catch (e) {
    console.warn(`仕込み日 ${dateStr} の局面復元に失敗（表示は省略）:`, e);
    return null;
  }
}

/** date → totalEquity（昇順配列）から、指定日以前の直近 equity を返す */
function equityAt(
  snapshots: { date: string; equity: number }[],
  dateStr: string,
): number | null {
  let result: number | null = null;
  for (const s of snapshots) {
    if (s.date <= dateStr) result = s.equity;
    else break;
  }
  return result;
}

async function toPerf(
  rows: ClosedRow[],
  equitySnapshots: { date: string; equity: number }[],
): Promise<ClosedTradePerf[]> {
  const uniqueDates = [...new Set(rows.map((r) => jstDateOf(r.entryDate)))];
  const contexts = new Map<string, EntryContext | null>();
  for (const date of uniqueDates) {
    contexts.set(date, await getEntryContext(date));
  }

  return rows.map((r) => {
    const entryDate = jstDateOf(r.entryDate);
    const pnl = r.netPnl ?? 0;
    const eq = equityAt(equitySnapshots, entryDate);
    const width = Math.abs(r.shortStrike - r.longStrike);
    const collateral = width * CONTRACT_SIZE * r.contracts;
    const denom = eq && eq > 0 ? eq : collateral > 0 ? collateral : 0;
    return {
      returnPct: denom > 0 ? (pnl / denom) * 100 : 0,
      entryDate,
      exitDate: r.closeDate ? jstDateOf(r.closeDate) : entryDate,
      entry: contexts.get(entryDate) ?? null,
    };
  });
}

const CLOSED_SELECT = {
  shortStrike: true,
  longStrike: true,
  contracts: true,
  netPnl: true,
  entryDate: true,
  closeDate: true,
} as const;

/**
 * 公開ページ用の成績スナップショットを構築する。
 * @param opts.recentLimit 直近決済の件数（既定5）
 */
export async function buildPerformanceSnapshot(
  opts: { recentLimit?: number } = {},
): Promise<PerformanceSnapshot> {
  const recentLimit = opts.recentLimit ?? 5;
  const monthStart = dayjs.utc().startOf("month").toDate();

  const [closedMonthRaw, recentRaw, snaps] = await Promise.all([
    prisma.position.findMany({
      where: { state: "CLOSED", closeDate: { gte: monthStart } },
      select: CLOSED_SELECT,
    }),
    prisma.position.findMany({
      where: { state: "CLOSED", closeDate: { not: null } },
      select: CLOSED_SELECT,
      orderBy: { closeDate: "desc" },
      take: recentLimit,
    }),
    prisma.dailyEquitySnapshot.findMany({
      select: { date: true, totalEquity: true },
      orderBy: { date: "asc" },
    }),
  ]);

  const equitySnapshots = snaps.map((s) => ({
    date: jstDateOf(s.date),
    equity: s.totalEquity,
  }));

  let month: PerformanceSnapshot["month"] = null;
  if (closedMonthRaw.length > 0) {
    const wins = closedMonthRaw.filter((r) => (r.netPnl ?? 0) >= 0).length;
    month = {
      wins,
      losses: closedMonthRaw.length - wins,
      pf: profitFactor(closedMonthRaw),
    };
  }

  let cumulativeReturnPct: number | null = null;
  if (equitySnapshots.length >= 2) {
    const base = equitySnapshots[0].equity;
    const latest = equitySnapshots[equitySnapshots.length - 1].equity;
    if (base > 0) cumulativeReturnPct = (latest / base - 1) * 100;
  }

  return {
    month,
    cumulativeReturnPct,
    recentClosed: await toPerf(recentRaw, equitySnapshots),
  };
}
