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

/**
 * テストで signal-generator が選びそうな strike を全部含む密な put listing を作る。
 * spot 480 / VIX 15 で ~30 DTE のショート strike は 450 前後に出るので、
 * 420 〜 490 を $1 刻みで広めに用意する。
 */
function makeDenseSpyChain(today: string = "2026-05-01"): {
  occSymbol: string; strike: number; expiry: string; right: "P" | "C";
  bid: number | null; ask: number | null; delta: number | null; gamma: number | null; impliedVol: number | null;
}[] {
  const contracts: any[] = [];
  // 14 週間ぶんの金曜 = signal-generator が tradingDays から選ぶ候補
  for (let w = 1; w <= 14; w++) {
    const expiry = new Date(today);
    // signal-generator は entry+30d 近傍を選ぶので、当日から 7d, 14d, ... 経過した金曜列で十分
    expiry.setUTCDate(expiry.getUTCDate() + w * 7);
    const exp = expiry.toISOString().slice(0, 10);
    for (let k = 420; k <= 490; k++) {
      const strikePart = String(k * 1000).padStart(8, "0");
      contracts.push({
        occSymbol: `SPY${exp.slice(2).replace(/-/g, "")}P${strikePart}`,
        strike: k,
        expiry: exp,
        right: "P",
        bid: null, ask: null, delta: null, gamma: null, impliedVol: null,
      });
    }
  }
  return contracts;
}

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
    listOptionContracts: vi.fn().mockResolvedValue(makeDenseSpyChain()),
    getOptionSnapshots: vi.fn().mockResolvedValue(new Map()),
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
  // sendSlack は global.fetch を直接叩くだけ。`@prisma/client` が `.env` を
  // 自動 load するため process.env.SLACK_WEBHOOK_URL は本物が漏れることが
  // ある。fetch を describe 全体で mock して、どんな経路でも実 Slack に
  // 飛ばさないようにする。
  const fetchMock = vi.fn();
  const origFetch = global.fetch;

  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as any);
    (global as any).fetch = fetchMock;
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
    await cleanDb();
    mockVixMap = new Map([["2026-04-30", 15.5]]);
  });
  afterEach(async () => {
    (global as any).fetch = origFetch;
    delete process.env.SLACK_WEBHOOK_URL;
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

  it("snapshot 分解: cash + positionsValue ≡ totalEquity (含み損益が positionsValue に反映される)", async () => {
    // Alpaca paper では credit spread をオープン中 → 受領クレジット分 cash が増え、
    // 開ポジの mark-to-market は (買い戻しコストの) 負値になる。
    // ex: 初期 cash 100,073 (=100,000 + $73 クレジット), 開ポジ MTM = -$60 (含み益 $13)
    //     equity = 100,073 + (-60) = 100,013
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockAlpaca = makeMockAlpaca({
      getAccountSummary: vi.fn().mockResolvedValue({
        netLiquidation: 100_013,
        totalCashValue: 100_073,
        buyingPower: 400_000,
        availableFunds: 100_000,
      }),
    });
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: true,
    });

    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
    expect(snap?.cash).toBe(100_073);
    expect(snap?.positionsValue).toBeCloseTo(-60, 5);
    expect(snap?.totalEquity).toBe(100_013);
    // invariant: cash + positionsValue == totalEquity
    expect((snap!.cash + snap!.positionsValue)).toBeCloseTo(snap!.totalEquity, 5);
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

  it("REJECTED 注文時に Slack に reject reason を含む alert を送る + DailyEquitySnapshot は保存される", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockAlpaca = makeMockAlpaca({
      placeMultiLegOrder: vi.fn().mockResolvedValue({
        orderId: "",
        status: "REJECTED",
        message: "Alpaca 422: option contract not tradable",
      }),
    });
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: false,
    });

    // describe-level fetchMock に reject alert が乗っている
    const bodies = fetchMock.mock.calls.map((c: any) => JSON.parse(c[1].body));
    const rejectMsg = bodies.find((b: any) =>
      b.attachments?.[0]?.text?.includes("ENTRY REJECTED"),
    );
    expect(rejectMsg, "reject Slack alert was not sent").toBeTruthy();
    expect(rejectMsg.attachments[0].text).toContain("Alpaca 422: option contract not tradable");

    const order = await prisma.tradingOrder.findFirst({
      where: { status: "REJECTED" },
    });
    expect(order?.message).toBe("Alpaca 422: option contract not tradable");

    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
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

  it("skips entry with SKIP_NO_CONTRACTS when Alpaca returns 0 option contracts", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    const mockAlpaca = makeMockAlpaca({
      listOptionContracts: vi.fn().mockResolvedValue([]),
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
    expect(entrySignal?.reason).toBe("SKIP_NO_CONTRACTS");
    const snap = await prisma.dailyEquitySnapshot.findUnique({ where: { date: new Date("2026-05-01") } });
    expect(snap).toBeTruthy();
  });

  it("snaps signal strikes to Alpaca listing before placing order (SKIP_STRIKE_UNAVAILABLE if too far)", async () => {
    mockGspcMap = buildLinearGspc(4500, 5, 50, new Date(Date.UTC(2026, 2, 1)));

    // 当 expiry に 1 strike しか listing が無い → long が取れず SKIP
    const sparseChain = [
      {
        occSymbol: "SPY260605P00450000",
        strike: 450, expiry: "2026-06-05", right: "P" as const,
        bid: null, ask: null, delta: null, gamma: null, impliedVol: null,
      },
    ];
    const mockAlpaca = makeMockAlpaca({
      listOptionContracts: vi.fn().mockResolvedValue(sparseChain),
    });
    const { runDailyCycle } = await import("../daily-runner");

    await runDailyCycle({
      alpaca: mockAlpaca as any,
      prisma,
      today: "2026-05-01",
      dryRun: false,
    });

    expect(mockAlpaca.placeMultiLegOrder).not.toHaveBeenCalled();
    const skipLog = await prisma.signalLog.findFirst({
      where: { reason: "SKIP_STRIKE_UNAVAILABLE" },
    });
    expect(skipLog).toBeTruthy();
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
