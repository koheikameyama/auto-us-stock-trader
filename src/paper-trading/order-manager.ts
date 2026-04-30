// src/paper-trading/order-manager.ts
import { PrismaClient } from "@prisma/client";
import dayjs from "dayjs";
import type { IBKRClient, ComboOrderRequest, OrderResult } from "./ibkr-client";

export interface NewSpreadOrderInput {
  underlying: string;
  shortStrike: number;
  longStrike: number;
  expiry: string;            // YYYYMMDD
  contracts: number;
  estimatedCredit: number;   // mid から決定した limit (positive)
}

export interface PlacedSpread {
  ibkrOrderId: number;
  status: OrderResult["status"];
  filledCredit: number | null;
  positionId: string | null;
}

function expiryToDate(expiry: string): Date {
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`);
}

/** 同日に同じ symbol/strikes/expiry で entry 注文が DB にあるか確認 */
export async function isDuplicateOrder(
  prisma: PrismaClient,
  underlying: string,
  shortStrike: number,
  longStrike: number,
  expiry: string,
): Promise<boolean> {
  const today = dayjs().format("YYYY-MM-DD");
  const existing = await prisma.tradingOrder.findFirst({
    where: {
      symbol: underlying,
      shortStrike,
      longStrike,
      expiry: expiryToDate(expiry),
      submittedAt: { gte: new Date(`${today}T00:00:00Z`) },
      orderType: "ENTRY",
    },
  });
  return existing != null;
}

export async function placeNewSpreadOrder(
  ibkr: IBKRClient,
  prisma: PrismaClient,
  input: NewSpreadOrderInput,
  options: { dryRun?: boolean } = {},
): Promise<PlacedSpread> {
  const { underlying, shortStrike, longStrike, expiry, contracts, estimatedCredit } = input;

  if (await isDuplicateOrder(prisma, underlying, shortStrike, longStrike, expiry)) {
    throw new Error(`Duplicate entry order detected: ${underlying} ${expiry} ${shortStrike}/${longStrike}`);
  }

  const expiryDate = expiryToDate(expiry);

  if (options.dryRun) {
    await prisma.tradingOrder.create({
      data: {
        ibkrOrderId: 0,
        symbol: underlying,
        orderType: "ENTRY",
        shortStrike,
        longStrike,
        expiry: expiryDate,
        quantity: contracts,
        limitPrice: -estimatedCredit,
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    });
    return { ibkrOrderId: 0, status: "SUBMITTED", filledCredit: null, positionId: null };
  }

  const shortConId = await ibkr.qualifyOptionContract(underlying, expiry, shortStrike, "P");
  const longConId = await ibkr.qualifyOptionContract(underlying, expiry, longStrike, "P");

  const req: ComboOrderRequest = {
    underlying,
    legs: [
      { conId: shortConId, action: "SELL", ratio: 1 },
      { conId: longConId, action: "BUY", ratio: 1 },
    ],
    totalQuantity: contracts,
    limitPrice: -estimatedCredit,
    tif: "DAY",
  };

  const result = await ibkr.placeComboOrder(req);

  const order = await prisma.tradingOrder.create({
    data: {
      ibkrOrderId: result.ibkrOrderId,
      symbol: underlying,
      orderType: "ENTRY",
      shortStrike,
      longStrike,
      expiry: expiryDate,
      quantity: contracts,
      limitPrice: -estimatedCredit,
      status: result.status,
      submittedAt: new Date(),
      filledAt: result.status === "FILLED" ? new Date() : null,
      filledPrice: result.filledPrice,
      commission: result.commission,
    },
  });

  let positionId: string | null = null;
  let filledCredit: number | null = null;
  if (result.status === "FILLED" && result.filledPrice != null) {
    filledCredit = -result.filledPrice;  // NET_CREDIT なので約定価格は負、credit は反転
    const position = await prisma.position.create({
      data: {
        symbol: underlying,
        shortStrike,
        longStrike,
        expiry: expiryDate,
        contracts,
        creditReceived: filledCredit,
        entryDate: new Date(),
        state: "OPEN",
        totalCommission: result.commission ?? 0,
      },
    });
    await prisma.tradingOrder.update({
      where: { id: order.id },
      data: { positionId: position.id },
    });
    positionId = position.id;
  }

  return {
    ibkrOrderId: result.ibkrOrderId,
    status: result.status,
    filledCredit,
    positionId,
  };
}
