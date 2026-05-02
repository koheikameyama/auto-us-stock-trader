// src/backtest/us/event-fetcher.ts
/**
 * Backtest 用 MacroEvent bulk fetch + proximity 判定
 *
 * 全期間分の MacroEvent を 1 クエリで取得し、date(YYYY-MM-DD) → EventInfo[] の Map に格納。
 * `nearestEvent` は per-day ループ内で「今日 ±window 日以内に対象イベントがあるか」を
 * O(window) で判定するためのユーティリティ。
 */

import { prisma } from "../../lib/prisma";

export type EventType = "FOMC" | "CPI" | "NFP" | "PPI";

export interface EventInfo {
  eventType: EventType;
  description: string | null;
}

export type EventCalendar = Map<string, EventInfo[]>;

export interface ProximityHit {
  eventType: EventType;
  /** Negative = event already passed; positive = event upcoming; 0 = today. */
  daysAway: number;
  description: string | null;
}

export async function fetchEventsFromDB(
  startDate: string,
  endDate: string,
  eventTypes?: EventType[],
): Promise<EventCalendar> {
  const rows = await prisma.macroEvent.findMany({
    where: {
      date: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
      ...(eventTypes && eventTypes.length > 0
        ? { eventType: { in: eventTypes } }
        : {}),
    },
    select: {
      date: true,
      eventType: true,
      description: true,
    },
  });

  const map: EventCalendar = new Map();
  for (const r of rows) {
    const key = r.date.toISOString().slice(0, 10);
    const list = map.get(key) ?? [];
    list.push({
      eventType: r.eventType as EventType,
      description: r.description,
    });
    map.set(key, list);
  }
  return map;
}

function shiftDateString(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 指定日の ±windowDays 以内にイベントがあれば、その内一番近いものを返す。
 * 同日複数イベントがあれば eventTypes の優先順 (FOMC > CPI > NFP > PPI) で選ぶ。
 *
 * @param calendar       fetchEventsFromDB の戻り値
 * @param date           判定対象日 (YYYY-MM-DD)
 * @param windowDays     0 なら当日のみ、1 なら前日・当日・翌日、2 なら ±2 日…
 */
export function nearestEvent(
  calendar: EventCalendar,
  date: string,
  windowDays: number,
): ProximityHit | null {
  if (windowDays < 0) return null;

  const priority: Record<EventType, number> = {
    FOMC: 0,
    CPI: 1,
    NFP: 2,
    PPI: 3,
  };

  let best: ProximityHit | null = null;
  for (let offset = -windowDays; offset <= windowDays; offset++) {
    const key = shiftDateString(date, offset);
    const events = calendar.get(key);
    if (!events || events.length === 0) continue;

    for (const e of events) {
      const candidate: ProximityHit = {
        eventType: e.eventType,
        daysAway: offset,
        description: e.description,
      };
      if (!best) {
        best = candidate;
        continue;
      }
      // 1. 距離（絶対値）が小さい方が優先
      const aDist = Math.abs(candidate.daysAway);
      const bDist = Math.abs(best.daysAway);
      if (aDist < bDist) {
        best = candidate;
        continue;
      }
      if (aDist > bDist) continue;
      // 2. 距離が同じなら eventType priority
      if (priority[candidate.eventType] < priority[best.eventType]) {
        best = candidate;
      }
    }
  }
  return best;
}
