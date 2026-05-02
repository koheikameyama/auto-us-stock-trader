import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getRegimeMultiplier, scaleContracts } from "../regime-multiplier";

const prisma = new PrismaClient();

async function insertSignal(date: string, state: "RISK_ON" | "NEUTRAL" | "RISK_OFF") {
  const mult = state === "RISK_ON" ? 1.5 : state === "RISK_OFF" ? 0.5 : 1.0;
  await prisma.regimeSignal.create({
    data: {
      date: new Date(date),
      xlyXlpRatio: 1.0,
      xlyXlp50dma: 1.0,
      xlyXlpState: state === "RISK_OFF" ? "OFF" : "ON",
      xlkXluRatio: 1.0,
      xlkXlu50dma: 1.0,
      xlkXluState: state === "RISK_OFF" ? "OFF" : state === "NEUTRAL" ? "OFF" : "ON",
      combinedState: state,
      sizeMultiplier: mult,
    },
  });
}

describe("regime-multiplier", () => {
  beforeEach(async () => {
    await prisma.regimeSignal.deleteMany({
      where: { date: { gte: new Date("2099-01-01"), lt: new Date("2099-12-31") } },
    });
  });
  afterEach(async () => {
    await prisma.regimeSignal.deleteMany({
      where: { date: { gte: new Date("2099-01-01"), lt: new Date("2099-12-31") } },
    });
  });

  describe("scaleContracts", () => {
    it("RISK_ON 1.5x: 1 contract -> 1 (floor)", () => {
      expect(scaleContracts(1, 1.5)).toBe(1);
    });
    it("RISK_ON 1.5x: 4 contracts -> 6", () => {
      expect(scaleContracts(4, 1.5)).toBe(6);
    });
    it("NEUTRAL 1.0x: 1 contract -> 1", () => {
      expect(scaleContracts(1, 1.0)).toBe(1);
    });
    it("RISK_OFF 0.5x: 1 contract -> 0 (skip)", () => {
      expect(scaleContracts(1, 0.5)).toBe(0);
    });
    it("RISK_OFF 0.5x: 4 contracts -> 2", () => {
      expect(scaleContracts(4, 0.5)).toBe(2);
    });
  });

  describe("getRegimeMultiplier", () => {
    it("returns RISK_ON state and 1.5 multiplier", async () => {
      await insertSignal("2099-01-15", "RISK_ON");
      const r = await getRegimeMultiplier(prisma, "2099-01-15");
      expect(r.state).toBe("RISK_ON");
      expect(r.multiplier).toBe(1.5);
      expect(r.ratios).toEqual({ xlyXlpState: "ON", xlkXluState: "ON" });
    });
    it("returns RISK_OFF state and 0.5 multiplier", async () => {
      await insertSignal("2099-02-15", "RISK_OFF");
      const r = await getRegimeMultiplier(prisma, "2099-02-15");
      expect(r.state).toBe("RISK_OFF");
      expect(r.multiplier).toBe(0.5);
    });
    it("fail-safe: returns multiplier=1.0 and state=null when no signal exists", async () => {
      const r = await getRegimeMultiplier(prisma, "2099-12-30");
      expect(r.state).toBeNull();
      expect(r.multiplier).toBe(1.0);
      expect(r.ratios).toBeNull();
    });
  });
});
