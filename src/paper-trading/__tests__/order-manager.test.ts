import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { placeNewSpreadOrder, isDuplicateOrder, closeSpreadOrder, expirePosition } from "../order-manager";

const prisma = new PrismaClient();

describe("order-manager", () => {
  beforeEach(async () => {
    await prisma.tradingOrder.deleteMany({});
    await prisma.position.deleteMany({});
  });
  afterEach(async () => {
    await prisma.tradingOrder.deleteMany({});
    await prisma.position.deleteMany({});
  });

  it("dry-run mode creates TradingOrder without IBKR call", async () => {
    const fakeIbkr = {} as any;
    const result = await placeNewSpreadOrder(
      fakeIbkr,
      prisma,
      {
        underlying: "SPY",
        shortStrike: 450,
        longStrike: 445,
        expiry: "20260619",
        contracts: 1,
        estimatedCredit: 0.85,
      },
      { dryRun: true },
    );
    expect(result.status).toBe("SUBMITTED");
    expect(result.positionId).toBeNull();

    const orders = await prisma.tradingOrder.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0].symbol).toBe("SPY");
    expect(orders[0].limitPrice).toBe(-0.85);
  });

  it("isDuplicateOrder returns true for same-day duplicate", async () => {
    const fakeIbkr = {} as any;
    await placeNewSpreadOrder(
      fakeIbkr,
      prisma,
      { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
      { dryRun: true },
    );
    const dup = await isDuplicateOrder(prisma, "SPY", 450, 445, "20260619");
    expect(dup).toBe(true);
  });

  it("placeNewSpreadOrder throws on duplicate", async () => {
    const fakeIbkr = {} as any;
    await placeNewSpreadOrder(
      fakeIbkr,
      prisma,
      { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
      { dryRun: true },
    );
    await expect(
      placeNewSpreadOrder(
        fakeIbkr,
        prisma,
        { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
        { dryRun: true },
      ),
    ).rejects.toThrow(/Duplicate/);
  });

  describe("closeSpreadOrder", () => {
    it("submits a debit combo order (BUY back short, SELL long) and updates Position state to CLOSED", async () => {
      const mockIbkr = {
        qualifyOptionContract: vi.fn()
          .mockResolvedValueOnce(111) // short put conId
          .mockResolvedValueOnce(222), // long put conId
        placeComboOrder: vi.fn().mockResolvedValue({
          ibkrOrderId: 999,
          status: "FILLED",
          filledPrice: 0.30,    // debit (positive limit)
          commission: 1.20,
        }),
      } as any;

      const position = await prisma.position.create({
        data: {
          symbol: "SPY",
          shortStrike: 480,
          longStrike: 475,
          expiry: new Date("2026-06-19"),
          contracts: 1,
          creditReceived: 0.85,
          entryDate: new Date("2026-05-01"),
          state: "OPEN",
          totalCommission: 1.20,
        },
      });

      const result = await closeSpreadOrder(mockIbkr, prisma, {
        positionId: position.id,
        reason: "profit_target",
        currentSpreadValue: 0.30,
      });

      expect(result.status).toBe("FILLED");
      expect(mockIbkr.placeComboOrder).toHaveBeenCalledWith(expect.objectContaining({
        legs: [
          expect.objectContaining({ conId: 111, action: "BUY" }),
          expect.objectContaining({ conId: 222, action: "SELL" }),
        ],
        limitPrice: 0.30,
      }));

      const updated = await prisma.position.findUnique({ where: { id: position.id } });
      expect(updated?.state).toBe("CLOSED");
      expect(updated?.closeReason).toBe("profit_target");
      expect(updated?.closeSpreadPrice).toBe(0.30);
      expect(updated?.netPnl).toBeCloseTo(52.60, 2);

      const order = await prisma.tradingOrder.findFirst({
        where: { ibkrOrderId: 999 },
      });
      expect(order?.orderType).toBe("EXIT");
      expect(order?.positionId).toBe(position.id);
    });

    it("throws if Position is already CLOSED (duplicate close prevention)", async () => {
      const position = await prisma.position.create({
        data: {
          symbol: "SPY", shortStrike: 480, longStrike: 475,
          expiry: new Date("2026-06-19"), contracts: 1, creditReceived: 0.85,
          entryDate: new Date("2026-05-01"), state: "CLOSED",
        },
      });
      await expect(
        closeSpreadOrder({} as any, prisma, {
          positionId: position.id, reason: "profit_target", currentSpreadValue: 0.30,
        }),
      ).rejects.toThrow(/already closed/i);
    });

    it("throws if EXIT order already submitted today", async () => {
      const position = await prisma.position.create({
        data: {
          symbol: "SPY",
          shortStrike: 480,
          longStrike: 475,
          expiry: new Date("2026-06-19"),
          contracts: 1,
          creditReceived: 0.85,
          entryDate: new Date("2026-05-01"),
          state: "OPEN",
          totalCommission: 1.20,
        },
      });
      await prisma.tradingOrder.create({
        data: {
          ibkrOrderId: 100,
          symbol: "SPY",
          orderType: "EXIT",
          shortStrike: 480,
          longStrike: 475,
          expiry: new Date("2026-06-19"),
          quantity: 1,
          limitPrice: 0.30,
          status: "SUBMITTED",
          submittedAt: new Date(),
          positionId: position.id,
        },
      });
      await expect(
        closeSpreadOrder({} as any, prisma, {
          positionId: position.id,
          reason: "profit_target",
          currentSpreadValue: 0.30,
        }),
      ).rejects.toThrow(/already submitted/i);
    });
  });

  describe("expirePosition", () => {
    it("marks Position as EXPIRED with finalValue and netPnl, no IBKR call", async () => {
      const position = await prisma.position.create({
        data: {
          symbol: "SPY",
          shortStrike: 480,
          longStrike: 475,
          expiry: new Date("2026-06-19"),
          contracts: 1,
          creditReceived: 0.85,
          entryDate: new Date("2026-05-01"),
          state: "OPEN",
          totalCommission: 1.20,
        },
      });
      await expirePosition(prisma, {
        positionId: position.id,
        reason: "expired_worthless",
        finalValue: 0,
      });
      const updated = await prisma.position.findUnique({ where: { id: position.id } });
      expect(updated?.state).toBe("EXPIRED");
      expect(updated?.closeReason).toBe("expired_worthless");
      expect(updated?.netPnl).toBeCloseTo(0.85 * 100 - 1.20, 2); // = 83.80
    });
  });
});
