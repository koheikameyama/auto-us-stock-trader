import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// Mutable mock so each test can configure its own GSPC history
let mockGspcMap: Map<string, number> = new Map();
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
  fetchIndexFromDB: vi.fn().mockImplementation(async () => mockGspcMap),
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

function makeMockIbkr(overrides: Partial<Record<string, any>> = {}) {
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
    getMarketPrice: vi.fn().mockResolvedValue({ bid: 480, ask: 480.05, last: 480.02 }),
    getVIX: vi.fn().mockResolvedValue(15.5),
    qualifyOptionContract: vi.fn().mockResolvedValue(123456),
    placeComboOrder: vi.fn().mockResolvedValue({ ibkrOrderId: 1, status: "FILLED", filledPrice: -0.85, commission: 1.20 }),
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
  });
  afterEach(async () => {
    await cleanDb();
  });

  it("dry-run cycle: writes DailyEquitySnapshot, SignalLog, and skips IBKR order placement", async () => {
    // GSPC closes 4800..5045 around March 2026 → SMA50 ≈ 4922.5
    // spy=480.02 → gspc=4800.2 < SMA50 → SKIP_TREND_FILTER expected
    mockGspcMap = buildLinearGspc(4800, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockIbkr = makeMockIbkr();
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      ibkr: mockIbkr as any,
      prisma,
      today: "2026-05-01",
      dryRun: true,
    });

    // DailyEquitySnapshot
    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
    expect(snap?.totalEquity).toBe(100_000);
    expect(snap?.openPositionCount).toBe(0);

    // SignalLog: an ENTRY row must exist with a known reason value
    const entrySignal = await prisma.signalLog.findFirst({ where: { signalType: "ENTRY" } });
    expect(entrySignal).toBeTruthy();
    expect(ENTRY_REASONS).toContain(entrySignal!.reason as (typeof ENTRY_REASONS)[number]);
    // With this synthetic data we expect SKIP_TREND_FILTER (gspc 4800.2 < sma50 ~4922.5)
    expect(entrySignal!.reason).toBe("SKIP_TREND_FILTER");

    // No IBKR combo order placed under dry-run
    expect(mockIbkr.placeComboOrder).not.toHaveBeenCalled();
  });

  it("live cycle (dryRun=false) with UP-trend GSPC: places combo order and creates OPEN Position", async () => {
    // GSPC closes 4500..4745 → SMA50 ≈ 4622.5; spy=480.02 → gspc=4800.2 > SMA50 → trend OK
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockIbkr = makeMockIbkr();
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      ibkr: mockIbkr as any,
      prisma,
      today: "2026-05-01",
      dryRun: false,
    });

    // ENTRY signal should be ENTERED
    const entrySignal = await prisma.signalLog.findFirst({ where: { signalType: "ENTRY" } });
    expect(entrySignal).toBeTruthy();
    expect(entrySignal!.reason).toBe("ENTERED");

    // IBKR combo order placed
    expect(mockIbkr.placeComboOrder).toHaveBeenCalledTimes(1);
    expect(mockIbkr.qualifyOptionContract).toHaveBeenCalled();

    // Position row exists with state OPEN
    const positions = await prisma.position.findMany({ where: { state: "OPEN" } });
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe("SPY");
    expect(positions[0].contracts).toBeGreaterThan(0);

    // Snapshot still written
    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
    expect(snap?.totalEquity).toBe(100_000);
  });
});
