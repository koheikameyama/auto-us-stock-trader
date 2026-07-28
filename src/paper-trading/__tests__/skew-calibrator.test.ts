import { describe, it, expect } from "vitest";
import dayjs from "dayjs";
import type { AlpacaClient, OptionContract } from "../alpaca-client";
import { calibrateSkew, expiryForDte, fitSlope } from "../skew-calibrator";

describe("fitSlope", () => {
  it("recovers the slope of a linear skew through the origin", () => {
    // y = 3x
    const pts = [0.01, 0.02, 0.05].map((x) => ({ x, y: 3 * x }));
    expect(fitSlope(pts).slope).toBeCloseTo(3, 10);
    expect(fitSlope(pts).n).toBe(3);
  });

  it("returns NaN for an empty sample", () => {
    const fit = fitSlope([]);
    expect(Number.isNaN(fit.slope)).toBe(true);
    expect(fit.n).toBe(0);
  });
});

describe("expiryForDte", () => {
  it("returns the first Friday on or after the target date", () => {
    // 2026-07-28(火) + 35日 = 2026-09-01(火) → 直後の金曜 2026-09-04
    expect(expiryForDte(35, dayjs("2026-07-28"))).toBe("2026-09-04");
  });

  it("keeps the target date when it is already a Friday", () => {
    // 2026-07-31 は金曜
    expect(expiryForDte(0, dayjs("2026-07-31"))).toBe("2026-07-31");
  });
});

/** getMarketPrice / getOptionChain だけを持つ最小スタブ */
function stubClient(chain: OptionContract[], spot = 700): AlpacaClient {
  return {
    getMarketPrice: async () => ({ bid: spot - 0.05, ask: spot + 0.05 }),
    getOptionChain: async (_u: string, expiry: string, right: "P" | "C") =>
      chain.filter((c) => c.right === right && c.expiry === expiry),
  } as unknown as AlpacaClient;
}

const contract = (
  strike: number,
  right: "P" | "C",
  impliedVol: number | null,
  delta: number | null,
  expiry = "2026-09-04",
): OptionContract => ({
  occSymbol: `SPY${expiry}${right}${strike}`,
  strike,
  expiry,
  right,
  bid: null,
  ask: null,
  delta,
  gamma: null,
  impliedVol,
});

describe("calibrateSkew", () => {
  const from = dayjs("2026-07-28");

  it("fits put / call slopes separately and restricts the band to 0.12-0.30 delta", async () => {
    // baseIv = 0.20（ATM=700）。put 側 slope 5、call 側 slope 2 になるよう IV を作る。
    // iv = baseIv * (1 + slope * (spot - strike) / spot)
    const iv = (strike: number, slope: number) => 0.2 * (1 + (slope * (700 - strike)) / 700);
    const chain = [
      contract(700, "P", iv(700, 5), -0.5),
      contract(680, "P", iv(680, 5), -0.25), // band 内
      contract(670, "P", iv(670, 5), -0.05), // band 外
      contract(700, "C", iv(700, 2), 0.5),
      contract(720, "C", iv(720, 2), 0.2), // band 内
      contract(730, "C", iv(730, 2), 0.05), // band 外
    ];

    const r = await calibrateSkew(stubClient(chain), 35, from);
    expect(r).not.toBeNull();
    expect(r!.expiry).toBe("2026-09-04");
    expect(r!.baseIv).toBeCloseTo(0.2, 10);
    expect(r!.put.all.slope).toBeCloseTo(5, 6);
    expect(r!.call.all.slope).toBeCloseTo(2, 6);
    // ATM(δ0.5) と遠 OTM(δ0.05) は band 外なので各 1 点だけ残る
    expect(r!.put.band.n).toBe(1);
    expect(r!.call.band.n).toBe(1);
    expect(r!.put.band.slope).toBeCloseTo(5, 6);
    expect(r!.call.band.slope).toBeCloseTo(2, 6);
    // 生 smile は strike 昇順で全点保持
    expect(r!.points.map((p) => p.strike)).toEqual([670, 680, 700, 700, 720, 730]);
  });

  it("returns null when no contract carries an implied vol (market closed)", async () => {
    const chain = [contract(700, "P", null, -0.5), contract(700, "C", null, 0.5)];
    expect(await calibrateSkew(stubClient(chain), 35, from)).toBeNull();
  });

  it("ignores contracts without implied vol but keeps the rest", async () => {
    const iv = (strike: number) => 0.2 * (1 + (5 * (700 - strike)) / 700);
    const chain = [
      contract(700, "P", iv(700), -0.5),
      contract(680, "P", null, -0.25), // IV 欠損 → 除外
      contract(670, "P", iv(670), -0.15),
      contract(700, "C", iv(700), 0.5),
    ];
    const r = await calibrateSkew(stubClient(chain), 35, from);
    expect(r!.put.all.n).toBe(2);
    expect(r!.put.band.n).toBe(1);
  });
});
