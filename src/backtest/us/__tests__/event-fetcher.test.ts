import { describe, it, expect } from "vitest";
import {
  nearestEvent,
  type EventCalendar,
  type EventInfo,
} from "../event-fetcher";

function makeCalendar(
  entries: Array<[string, EventInfo[]]>,
): EventCalendar {
  return new Map(entries);
}

describe("nearestEvent", () => {
  it("returns null when calendar is empty", () => {
    const cal = makeCalendar([]);
    expect(nearestEvent(cal, "2025-06-18", 1)).toBeNull();
  });

  it("returns null when no event within window", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: null }]],
    ]);
    expect(nearestEvent(cal, "2025-06-10", 1)).toBeNull();
  });

  it("detects same-day event with daysAway=0", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: "Jun" }]],
    ]);
    const hit = nearestEvent(cal, "2025-06-18", 1);
    expect(hit).not.toBeNull();
    expect(hit!.eventType).toBe("FOMC");
    expect(hit!.daysAway).toBe(0);
  });

  it("detects upcoming event within window (positive daysAway)", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: null }]],
    ]);
    const hit = nearestEvent(cal, "2025-06-17", 1);
    expect(hit!.daysAway).toBe(1);
  });

  it("detects past event within window (negative daysAway)", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: null }]],
    ]);
    const hit = nearestEvent(cal, "2025-06-19", 1);
    expect(hit!.daysAway).toBe(-1);
  });

  it("does not detect event outside window", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: null }]],
    ]);
    expect(nearestEvent(cal, "2025-06-16", 1)).toBeNull();
    expect(nearestEvent(cal, "2025-06-20", 1)).toBeNull();
  });

  it("picks the closer event when two events are within window", () => {
    const cal = makeCalendar([
      ["2025-06-15", [{ eventType: "FOMC", description: "old" }]],
      ["2025-06-18", [{ eventType: "FOMC", description: "new" }]],
    ]);
    // Today=06-17 → 06-15 is daysAway=-2, 06-18 is daysAway=+1 → pick +1
    const hit = nearestEvent(cal, "2025-06-17", 3);
    expect(hit!.daysAway).toBe(1);
    expect(hit!.description).toBe("new");
  });

  it("respects priority FOMC > CPI when same-day same-distance", () => {
    const cal = makeCalendar([
      [
        "2025-06-18",
        [
          { eventType: "CPI", description: "cpi" },
          { eventType: "FOMC", description: "fomc" },
        ],
      ],
    ]);
    const hit = nearestEvent(cal, "2025-06-18", 0);
    expect(hit!.eventType).toBe("FOMC");
  });

  it("windowDays=0 only matches same-day", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: null }]],
    ]);
    expect(nearestEvent(cal, "2025-06-17", 0)).toBeNull();
    expect(nearestEvent(cal, "2025-06-18", 0)).not.toBeNull();
    expect(nearestEvent(cal, "2025-06-19", 0)).toBeNull();
  });

  it("windowDays=2 covers ±2 days correctly across month boundary", () => {
    const cal = makeCalendar([
      ["2025-06-30", [{ eventType: "FOMC", description: null }]],
    ]);
    const hit = nearestEvent(cal, "2025-07-02", 2);
    expect(hit!.daysAway).toBe(-2);
  });

  it("windowDays<0 returns null", () => {
    const cal = makeCalendar([
      ["2025-06-18", [{ eventType: "FOMC", description: null }]],
    ]);
    expect(nearestEvent(cal, "2025-06-18", -1)).toBeNull();
  });
});
