// src/paper-trading/order-manager.ts
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import dayjs from "dayjs";
import type {
  AlpacaClient,
  MultiLegOrderRequest,
  OrderResult,
} from "./alpaca-client";

export interface NewSpreadOrderInput {
  underlying: string;
  shortStrike: number;
  longStrike: number;
  expiry: string;            // YYYYMMDD
  contracts: number;
  estimatedCredit: number;   // mid から決定した limit (positive)
}

export interface PlacedSpread {
  brokerOrderId: string;
  status: OrderResult["status"];
  filledCredit: number | null;
  positionId: string | null;
}

function expiryToDate(expiry: string): Date {
  return new Date(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`);
}

/**
 * Build an OCC option symbol.
 * @param underlying e.g. "SPY"
 * @param expiry YYYYMMDD
 * @param right "P" | "C"
 * @param strike e.g. 450
 *
 * Example: SPY 20260619 P 450 → "SPY260619P00450000"
 */
export function buildOccSymbol(
  underlying: string,
  expiry: string,
  right: "P" | "C",
  strike: number,
): string {
  const yymmdd = expiry.slice(2);
  const strikeInt = Math.round(strike * 1000);
  const strikePart = strikeInt.toString().padStart(8, "0");
  return `${underlying}${yymmdd}${right}${strikePart}`;
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
  alpaca: AlpacaClient,
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
        brokerOrderId: `dryrun-${randomUUID()}`,
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
    return { brokerOrderId: "", status: "SUBMITTED", filledCredit: null, positionId: null };
  }

  const shortOcc = buildOccSymbol(underlying, expiry, "P", shortStrike);
  const longOcc = buildOccSymbol(underlying, expiry, "P", longStrike);

  const req: MultiLegOrderRequest = {
    legs: [
      { occSymbol: shortOcc, side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { occSymbol: longOcc, side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ],
    totalQuantity: contracts,
    limitPrice: -estimatedCredit,
    tif: "gtc",
  };

  const result = await alpaca.placeMultiLegOrder(req);

  const order = await prisma.tradingOrder.create({
    data: {
      brokerOrderId: result.orderId || `failed-${randomUUID()}`,
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
    filledCredit = -result.filledPrice;
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
    brokerOrderId: result.orderId,
    status: result.status,
    filledCredit,
    positionId,
  };
}

export interface CloseSpreadInput {
  positionId: string;
  reason: "profit_target" | "stop_loss";
  currentSpreadValue: number; // positive = debit to close
}

export async function closeSpreadOrder(
  alpaca: AlpacaClient,
  prisma: PrismaClient,
  input: CloseSpreadInput,
): Promise<PlacedSpread> {
  const position = await prisma.position.findUnique({ where: { id: input.positionId } });
  if (!position) throw new Error(`Position not found: ${input.positionId}`);
  if (position.state !== "OPEN") {
    throw new Error(`Position ${input.positionId} is already closed (state=${position.state})`);
  }

  const todayStart = dayjs().startOf("day").toDate();
  const existingExit = await prisma.tradingOrder.findFirst({
    where: {
      positionId: position.id,
      orderType: "EXIT",
      submittedAt: { gte: todayStart },
    },
  });
  if (existingExit) {
    throw new Error(`EXIT order already submitted today for position ${position.id} (orderId=${existingExit.brokerOrderId})`);
  }

  const expiryYYYYMMDD = position.expiry.toISOString().slice(0, 10).replace(/-/g, "");
  const shortOcc = buildOccSymbol(position.symbol, expiryYYYYMMDD, "P", position.shortStrike);
  const longOcc = buildOccSymbol(position.symbol, expiryYYYYMMDD, "P", position.longStrike);

  const result = await alpaca.placeMultiLegOrder({
    legs: [
      { occSymbol: shortOcc, side: "buy",  ratioQty: 1, positionIntent: "buy_to_close" },
      { occSymbol: longOcc,  side: "sell", ratioQty: 1, positionIntent: "sell_to_close" },
    ],
    totalQuantity: position.contracts,
    limitPrice: input.currentSpreadValue,
    tif: "gtc",
  });

  await prisma.tradingOrder.create({
    data: {
      brokerOrderId: result.orderId || `failed-${randomUUID()}`,
      symbol: position.symbol,
      orderType: "EXIT",
      shortStrike: position.shortStrike,
      longStrike: position.longStrike,
      expiry: position.expiry,
      quantity: position.contracts,
      limitPrice: input.currentSpreadValue,
      status: result.status,
      submittedAt: new Date(),
      filledAt: result.status === "FILLED" ? new Date() : null,
      filledPrice: result.filledPrice,
      commission: result.commission,
      positionId: position.id,
    },
  });

  if (result.status === "FILLED" && result.filledPrice != null) {
    const exitCommission = result.commission ?? 0;
    const totalCommission = (position.totalCommission ?? 0) + exitCommission;
    const netPnl = (position.creditReceived - result.filledPrice) * 100 * position.contracts - totalCommission;
    await prisma.position.update({
      where: { id: position.id },
      data: {
        state: "CLOSED",
        closeDate: new Date(),
        closeReason: input.reason,
        closeSpreadPrice: result.filledPrice,
        netPnl,
        totalCommission,
      },
    });
    return {
      brokerOrderId: result.orderId,
      status: result.status,
      filledCredit: -result.filledPrice,
      positionId: position.id,
    };
  }

  return {
    brokerOrderId: result.orderId,
    status: result.status,
    filledCredit: null,
    positionId: position.id,
  };
}

export async function expirePosition(
  prisma: PrismaClient,
  input: { positionId: string; reason: "expired_worthless" | "expired_max_loss" | "expired_partial"; finalValue: number },
): Promise<void> {
  const position = await prisma.position.findUnique({ where: { id: input.positionId } });
  if (!position) throw new Error(`Position not found: ${input.positionId}`);
  if (position.state !== "OPEN") return; // idempotent
  const totalCommission = position.totalCommission ?? 0;
  const netPnl = (position.creditReceived - input.finalValue) * 100 * position.contracts - totalCommission;
  await prisma.position.update({
    where: { id: position.id },
    data: {
      state: "EXPIRED",
      closeDate: new Date(),
      closeReason: input.reason,
      closeSpreadPrice: input.finalValue,
      netPnl,
    },
  });
}
