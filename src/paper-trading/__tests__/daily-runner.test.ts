import { describe, it, expect } from "vitest";
import { buildOptionExpiryCandidates } from "../daily-runner";

describe("buildOptionExpiryCandidates", () => {
  it("today が木曜のとき、最初の候補は翌日の金曜", () => {
    // 2026-05-07 = Thursday → 最初の Friday = 2026-05-08
    const days = buildOptionExpiryCandidates("2026-05-07", 14);
    expect(days[0]).toBe("2026-05-08");
  });

  it("全候補が金曜（dow=5）", () => {
    const days = buildOptionExpiryCandidates("2026-05-07", 100);
    for (const d of days) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(dow, `${d} should be Friday`).toBe(5);
    }
    // 100 日 ≒ 14 金曜
    expect(days.length).toBeGreaterThanOrEqual(13);
    expect(days.length).toBeLessThanOrEqual(15);
  });

  it("today 自身が金曜の場合、その日も含む", () => {
    // 2026-05-08 = Friday
    const days = buildOptionExpiryCandidates("2026-05-08", 7);
    expect(days[0]).toBe("2026-05-08");
  });

  it("週をまたいで連続する金曜が並ぶ（7 日刻み）", () => {
    const days = buildOptionExpiryCandidates("2026-05-07", 21);
    // 5/8, 5/15, 5/22 が並ぶはず
    expect(days[0]).toBe("2026-05-08");
    expect(days[1]).toBe("2026-05-15");
    expect(days[2]).toBe("2026-05-22");
  });
});
