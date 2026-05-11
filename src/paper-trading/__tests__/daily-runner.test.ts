import { describe, it, expect } from "vitest";
import { snapStrikesToChain } from "../daily-runner";

describe("snapStrikesToChain", () => {
  it("理想 strike が listing にちょうど存在する場合はそのまま返す", () => {
    const r = snapStrikesToChain({
      idealShort: 708,
      idealLong: 703,
      availableStrikes: [700, 701, 702, 703, 704, 705, 706, 707, 708, 709, 710],
    });
    expect(r.snappedShort).toBe(708);
    expect(r.snappedLong).toBe(703);
    expect(r.snappedWidth).toBe(5);
  });

  it("$5 刻みの listing には最近傍 strike にスナップする", () => {
    // 理想 708/703 だが listing は 700, 705, 710, 715 のみ → 705/700 にスナップ (width=5)
    const r = snapStrikesToChain({
      idealShort: 708,
      idealLong: 703,
      availableStrikes: [690, 695, 700, 705, 710, 715, 720],
    });
    expect(r.snappedShort).toBe(710);
    // 703 と最も近い strike (705 はスナップ済み short と同じので除外、700 を選ぶ)
    expect(r.snappedLong).toBe(705);
    expect(r.snappedWidth).toBe(5);
  });

  it("listing が空のときは両方 null を返す", () => {
    const r = snapStrikesToChain({ idealShort: 708, idealLong: 703, availableStrikes: [] });
    expect(r.snappedShort).toBeNull();
    expect(r.snappedLong).toBeNull();
    expect(r.snappedWidth).toBeNull();
  });

  it("スナップ距離が maxSnapDistance を超える場合は SHORT を諦める", () => {
    const r = snapStrikesToChain({
      idealShort: 708,
      idealLong: 703,
      availableStrikes: [600, 800], // 708 から 92 ドル離れている
      maxSnapDistance: 3,
    });
    expect(r.snappedShort).toBeNull();
  });

  it("short にスナップした strike より下の listing が無いと long が null", () => {
    const r = snapStrikesToChain({
      idealShort: 700,
      idealLong: 695,
      availableStrikes: [700], // 700 しかない → long を取れない
    });
    expect(r.snappedShort).toBe(700);
    expect(r.snappedLong).toBeNull();
  });

  it("long のスナップ距離超過時は null", () => {
    const r = snapStrikesToChain({
      idealShort: 700,
      idealLong: 695,
      availableStrikes: [700, 600], // long ideal=695, 直近候補は 600 (距離 95 > maxSnapDistance)
      maxSnapDistance: 3,
    });
    expect(r.snappedShort).toBe(700);
    expect(r.snappedLong).toBeNull();
  });

  it("$0.50 刻みも扱える（小数 strike）", () => {
    const r = snapStrikesToChain({
      idealShort: 480,
      idealLong: 475,
      availableStrikes: [475.5, 476, 478.5, 479.5, 480.5],
    });
    expect(r.snappedShort).toBe(479.5);
    // 475 と最も近い strike で snappedShort より小さい → 475.5
    expect(r.snappedLong).toBe(475.5);
    expect(r.snappedWidth).toBe(4);
  });
});
