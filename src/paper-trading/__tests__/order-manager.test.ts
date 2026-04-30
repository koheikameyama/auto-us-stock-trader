import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { placeNewSpreadOrder, isDuplicateOrder } from "../order-manager";

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
});
