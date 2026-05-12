import { describe, it, expect } from "vitest";
import { snapStrikesToChain, decideLimitCredit } from "../daily-runner";

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

describe("decideLimitCredit", () => {
  it("両 leg の bid/ask が揃っていれば natural mid - haircut を採用", () => {
    const r = decideLimitCredit({
      shortQuote: { bid: 1.20, ask: 1.30 }, // mid 1.25
      longQuote: { bid: 0.20, ask: 0.30 },  // mid 0.25
      bsCredit: 1.50,                       // BS は使わない
    });
    expect(r.source).toBe("quote");
    expect(r.quoteCredit).toBeCloseTo(1.00);
    expect(r.shortMid).toBeCloseTo(1.25);
    expect(r.longMid).toBeCloseTo(0.25);
    expect(r.limit).toBeCloseTo(0.98); // 1.00 - 0.02 haircut
  });

  it("haircut / minLimit はオーバーライド可能", () => {
    const r = decideLimitCredit({
      shortQuote: { bid: 1.20, ask: 1.30 },
      longQuote: { bid: 0.20, ask: 0.30 },
      bsCredit: 1.50,
      midHaircut: 0.05,
      minLimit: 0.10,
    });
    expect(r.limit).toBeCloseTo(0.95);
  });

  it("haircut で 0 を割り込んだら minLimit に張り付く", () => {
    const r = decideLimitCredit({
      shortQuote: { bid: 0.10, ask: 0.12 }, // mid 0.11
      longQuote: { bid: 0.05, ask: 0.07 },  // mid 0.06
      bsCredit: 0.20,
    });
    expect(r.source).toBe("quote");
    expect(r.quoteCredit).toBeCloseTo(0.05);
    expect(r.limit).toBeCloseTo(0.03); // max(0.01, 0.05 - 0.02)
  });

  it("どちらかの bid が欠損なら BS にフォールバック", () => {
    const r = decideLimitCredit({
      shortQuote: { bid: null, ask: 1.30 },
      longQuote: { bid: 0.20, ask: 0.30 },
      bsCredit: 1.50,
    });
    expect(r.source).toBe("bs");
    expect(r.limit).toBe(1.50);
    expect(r.quoteCredit).toBeNull();
  });

  it("どちらかの quote が null そのものでも BS にフォールバック", () => {
    const r = decideLimitCredit({
      shortQuote: null,
      longQuote: { bid: 0.20, ask: 0.30 },
      bsCredit: 1.50,
    });
    expect(r.source).toBe("bs");
    expect(r.limit).toBe(1.50);
  });

  it("quote が反転 (shortMid <= longMid) なら BS にフォールバック", () => {
    const r = decideLimitCredit({
      shortQuote: { bid: 0.20, ask: 0.30 }, // mid 0.25
      longQuote: { bid: 1.20, ask: 1.30 },  // mid 1.25
      bsCredit: 0.80,
    });
    expect(r.source).toBe("bs");
    expect(r.limit).toBe(0.80);
    // 観測用に mid 自体は埋めて返す（quoteCredit のみ null）
    expect(r.shortMid).toBeCloseTo(0.25);
    expect(r.longMid).toBeCloseTo(1.25);
    expect(r.quoteCredit).toBeNull();
  });
});
