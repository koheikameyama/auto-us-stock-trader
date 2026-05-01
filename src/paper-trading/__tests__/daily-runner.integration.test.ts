import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

// Stub fetchIndexFromDB so we don't hit real DB for index data
vi.mock("../../backtest/data-fetcher", () => ({
  fetchIndexFromDB: vi.fn().mockImplementation(async () => {
    // Return 50 trading days of GSPC closes around 4800-5000
    const map = new Map<string, number>();
    let close = 4800;
    for (let i = 0; i < 50; i++) {
      const d = new Date(2026, 2, 1 + i); // Mar 1+i 2026
      map.set(d.toISOString().slice(0, 10), close);
      close += 5;
    }
    return map;
  }),
}));

const prisma = new PrismaClient();

const mockIbkr: any = {
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
  qualifyOptionContract: vi.fn().mockResolvedValue(0),
  placeComboOrder: vi.fn().mockResolvedValue({ ibkrOrderId: 1, status: "FILLED", filledPrice: -0.85, commission: 1.20 }),
};

describe("runDailyCycle integration", () => {
  beforeEach(async () => {
    await prisma.tradingOrder.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.dailyEquitySnapshot.deleteMany({});
    await prisma.signalLog.deleteMany({});
    await prisma.errorLog.deleteMany({});
  });
  afterEach(async () => {
    await prisma.tradingOrder.deleteMany({});
    await prisma.position.deleteMany({});
    await prisma.dailyEquitySnapshot.deleteMany({});
    await prisma.signalLog.deleteMany({});
    await prisma.errorLog.deleteMany({});
  });

  it("dry-run cycle: writes DailyEquitySnapshot, skips entry, no IBKR order placed", async () => {
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      ibkr: mockIbkr,
      prisma,
      today: "2026-05-01",
      dryRun: true,
    });

    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
    expect(snap?.totalEquity).toBe(100_000);
    expect(snap?.openPositionCount).toBe(0);

    const orders = await prisma.tradingOrder.findMany();
    // Dry-run path of placeNewSpreadOrder may or may not write a TradingOrder depending on whether signal entered
    // We don't assert specific count here — just that no real IBKR order was placed
    expect(mockIbkr.placeComboOrder).not.toHaveBeenCalled();
  });
});
