import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  placeNewSpreadOrder,
  isDuplicateOrder,
  closeSpreadOrder,
  expirePosition,
  buildOccSymbol,
} from "../order-manager";

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

  describe("buildOccSymbol", () => {
    it("formats SPY P 450 expiring 2026-06-19 as SPY260619P00450000", () => {
      expect(buildOccSymbol("SPY", "20260619", "P", 450)).toBe("SPY260619P00450000");
    });
    it("handles fractional strike (e.g. 480.5)", () => {
      expect(buildOccSymbol("SPY", "20260619", "C", 480.5)).toBe("SPY260619C00480500");
    });
  });

  it("dry-run mode creates TradingOrder without broker call", async () => {
    const fakeAlpaca = {} as any;
    const result = await placeNewSpreadOrder(
      fakeAlpaca,
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
    expect(orders[0].brokerOrderId).toMatch(/^dryrun-/);
  });

  it("isDuplicateOrder returns true for same-day duplicate", async () => {
    const fakeAlpaca = {} as any;
    await placeNewSpreadOrder(
      fakeAlpaca,
      prisma,
      { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
      { dryRun: true },
    );
    const dup = await isDuplicateOrder(prisma, "SPY", 450, 445, "20260619");
    expect(dup).toBe(true);
  });

  it("placeNewSpreadOrder throws on duplicate", async () => {
    const fakeAlpaca = {} as any;
    await placeNewSpreadOrder(
      fakeAlpaca,
      prisma,
      { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
      { dryRun: true },
    );
    await expect(
      placeNewSpreadOrder(
        fakeAlpaca,
        prisma,
        { underlying: "SPY", shortStrike: 450, longStrike: 445, expiry: "20260619", contracts: 1, estimatedCredit: 0.85 },
        { dryRun: true },
      ),
    ).rejects.toThrow(/Duplicate/);
  });

  describe("closeSpreadOrder", () => {
    it("submits a debit mleg order (BUY back short, SELL long) and updates Position state to CLOSED", async () => {
      const mockAlpaca = {
        placeMultiLegOrder: vi.fn().mockResolvedValue({
          orderId: "alpaca-uuid-999",
          status: "FILLED",
          filledPrice: 0.30,
          commission: 0,
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
          totalCommission: 0,
        },
      });

      const result = await closeSpreadOrder(mockAlpaca, prisma, {
        positionId: position.id,
        reason: "profit_target",
        currentSpreadValue: 0.30,
      });

      expect(result.status).toBe("FILLED");
      expect(mockAlpaca.placeMultiLegOrder).toHaveBeenCalledWith(expect.objectContaining({
        legs: [
          expect.objectContaining({ occSymbol: "SPY260619P00480000", side: "buy", positionIntent: "buy_to_close" }),
          expect.objectContaining({ occSymbol: "SPY260619P00475000", side: "sell", positionIntent: "sell_to_close" }),
        ],
        limitPrice: 0.30,
      }));

      const updated = await prisma.position.findUnique({ where: { id: position.id } });
      expect(updated?.state).toBe("CLOSED");
      expect(updated?.closeReason).toBe("profit_target");
      expect(updated?.closeSpreadPrice).toBe(0.30);
      // Alpaca commission = 0, so netPnl = (0.85 - 0.30) * 100 * 1 - 0 = 55.00
      expect(updated?.netPnl).toBeCloseTo(55.00, 2);

      const order = await prisma.tradingOrder.findFirst({
        where: { brokerOrderId: "alpaca-uuid-999" },
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
          totalCommission: 0,
        },
      });
      await prisma.tradingOrder.create({
        data: {
          brokerOrderId: "alpaca-uuid-prior",
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
    it("marks Position as EXPIRED with finalValue and netPnl, no broker call", async () => {
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
          totalCommission: 0,
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
      expect(updated?.netPnl).toBeCloseTo(0.85 * 100, 2); // = 85.00 (no commission on Alpaca)
    });
  });
});
