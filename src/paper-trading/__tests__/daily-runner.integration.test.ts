import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

let mockGspcMap: Map<string, number> = new Map();
let mockVixMap: Map<string, number> = new Map();
function buildLinearGspc(start: number, step: number, count: number, baseDate: Date): Map<string, number> {
  const map = new Map<string, number>();
  let close = start;
  for (let i = 0; i < count; i++) {
    const d = new Date(baseDate);
    d.setDate(baseDate.getDate() + i);
    map.set(d.toISOString().slice(0, 10), close);
    close += step;
  }
  return map;
}

vi.mock("../../backtest/data-fetcher", () => ({
  fetchIndexFromDB: vi.fn().mockImplementation(async (ticker: string) => {
    if (ticker === "^VIX") return mockVixMap;
    return mockGspcMap;
  }),
}));

const prisma = new PrismaClient();

const ENTRY_REASONS = [
  "ENTERED",
  "SKIP_VIX_CAP",
  "SKIP_TREND_FILTER",
  "SKIP_DD_STOP",
  "SKIP_MAX_POSITIONS",
  "SKIP_INSUFFICIENT_CASH",
  "SKIP_LOW_CREDIT",
  "SKIP_INVALID_STRIKE",
] as const;

function makeMockAlpaca(overrides: Partial<Record<string, any>> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    getAccountSummary: vi.fn().mockResolvedValue({
      netLiquidation: 100_000,
      totalCashValue: 100_000,
      buyingPower: 400_000,
      availableFunds: 100_000,
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getMarketPrice: vi.fn().mockResolvedValue({ bid: 480, ask: 480.05, last: null }),
    placeMultiLegOrder: vi.fn().mockResolvedValue({
      orderId: "alpaca-test-order",
      status: "FILLED",
      filledPrice: -0.85,
      commission: 0,
    }),
    ...overrides,
  };
}

async function cleanDb() {
  await prisma.tradingOrder.deleteMany({});
  await prisma.position.deleteMany({});
  await prisma.dailyEquitySnapshot.deleteMany({});
  await prisma.signalLog.deleteMany({});
  await prisma.errorLog.deleteMany({});
}

describe("runDailyCycle integration", () => {
  beforeEach(async () => {
    await cleanDb();
    mockVixMap = new Map([["2026-04-30", 15.5]]);
  });
  afterEach(async () => {
    await cleanDb();
  });

  it("dry-run cycle: writes DailyEquitySnapshot, SignalLog, and skips broker order placement", async () => {
    mockGspcMap = buildLinearGspc(4800, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockAlpaca = makeMockAlpaca();
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: true,
    });

    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
    expect(snap?.totalEquity).toBe(100_000);
    expect(snap?.openPositionCount).toBe(0);

    const entrySignal = await prisma.signalLog.findFirst({ where: { signalType: "ENTRY" } });
    expect(entrySignal).toBeTruthy();
    expect(ENTRY_REASONS).toContain(entrySignal!.reason as (typeof ENTRY_REASONS)[number]);
    expect(entrySignal!.reason).toBe("SKIP_TREND_FILTER");

    expect(mockAlpaca.placeMultiLegOrder).not.toHaveBeenCalled();
  });

  it("live cycle (dryRun=false) with UP-trend GSPC: places mleg order and creates OPEN Position", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockAlpaca = makeMockAlpaca();
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: false,
    });

    const entrySignal = await prisma.signalLog.findFirst({ where: { signalType: "ENTRY" } });
    expect(entrySignal).toBeTruthy();
    expect(entrySignal!.reason).toBe("ENTERED");

    expect(mockAlpaca.placeMultiLegOrder).toHaveBeenCalledTimes(1);

    const positions = await prisma.position.findMany({ where: { state: "OPEN" } });
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe("SPY");
    expect(positions[0].contracts).toBeGreaterThan(0);

    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
    expect(snap?.totalEquity).toBe(100_000);
  });

  it("skips cycle when VIX is unavailable from DB", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));
    mockVixMap = new Map(); // empty

    const mockAlpaca = makeMockAlpaca();
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: true,
    });

    expect(mockAlpaca.placeMultiLegOrder).not.toHaveBeenCalled();
    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeNull();
  });
});
