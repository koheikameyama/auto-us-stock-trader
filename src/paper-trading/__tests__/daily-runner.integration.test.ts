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
    isTradingDay: vi.fn().mockResolvedValue(true),
    getCalendar: vi.fn().mockResolvedValue([{ date: "2026-05-01", open: "09:30", close: "16:00" }]),
    getAccountSummary: vi.fn().mockResolvedValue({
      netLiquidation: 100_000,
      totalCashValue: 100_000,
      buyingPower: 400_000,
      availableFunds: 100_000,
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getMarketPrice: vi.fn().mockResolvedValue({ bid: 480, ask: 480.05, last: null }),
    placeMultiLegOrder: vi.fn().mockResolvedValue({
      orderId: "alpaca-test-order",
      status: "FILLED",
      filledPrice: -0.85,
      commission: 0,
    }),
    cancelOrder: vi.fn().mockResolvedValue(undefined),
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

  it("skips cycle when today is not a trading day (US holiday / weekend)", async () => {
    const mockAlpaca = makeMockAlpaca({
      isTradingDay: vi.fn().mockResolvedValue(false),
    });
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-25", // Memorial Day 2026
      dryRun: true,
    });

    expect(mockAlpaca.isTradingDay).toHaveBeenCalledWith("2026-05-25");
    expect(mockAlpaca.getAccountSummary).not.toHaveBeenCalled();
    expect(mockAlpaca.placeMultiLegOrder).not.toHaveBeenCalled();
    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-25") } });
    expect(snap).toBeNull();
  });

  it("counts broker pending mleg ENTRY orders toward openPositionCount (KOH-466)", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    // Broker に既に sell_to_open を含む mleg 注文が 2 本 alive。
    // maxPositions=2 のため 2 件あれば SKIP_MAX_POSITIONS で抑止される想定。
    const mockAlpaca = makeMockAlpaca({
      getOpenOrders: vi.fn().mockResolvedValue([
        {
          id: "broker-pending-1",
          symbol: "",
          orderClass: "mleg",
          status: "new",
          submittedAt: "2026-05-01T13:30:03Z",
          legs: [
            { symbol: "SPY260605P00667000", side: "sell", positionIntent: "sell_to_open" },
            { symbol: "SPY260605P00662000", side: "buy", positionIntent: "buy_to_open" },
          ],
        },
        {
          id: "broker-pending-2",
          symbol: "",
          orderClass: "mleg",
          status: "new",
          submittedAt: "2026-05-01T13:35:34Z",
          legs: [
            { symbol: "SPY260605P00695000", side: "sell", positionIntent: "sell_to_open" },
            { symbol: "SPY260605P00690000", side: "buy", positionIntent: "buy_to_open" },
          ],
        },
      ]),
    });
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: false,
    });

    expect(mockAlpaca.placeMultiLegOrder).not.toHaveBeenCalled();
    const entrySignal = await prisma.signalLog.findFirst({ where: { signalType: "ENTRY" } });
    expect(entrySignal?.reason).toBe("SKIP_MAX_POSITIONS");
  });

  it("ignores broker pending EXIT-only mleg orders (no sell_to_open) — does not block entry", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    // 同じ broker pending 注文でも buy_to_close + sell_to_close は EXIT。
    // capacity を埋めるべきではない。
    const mockAlpaca = makeMockAlpaca({
      getOpenOrders: vi.fn().mockResolvedValue([
        {
          id: "broker-exit-1",
          symbol: "",
          orderClass: "mleg",
          status: "new",
          submittedAt: "2026-05-01T13:30:03Z",
          legs: [
            { symbol: "SPY260605P00667000", side: "buy", positionIntent: "buy_to_close" },
            { symbol: "SPY260605P00662000", side: "sell", positionIntent: "sell_to_close" },
          ],
        },
      ]),
    });
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: false,
    });

    expect(mockAlpaca.placeMultiLegOrder).toHaveBeenCalledTimes(1); // ENTRY 通る
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
