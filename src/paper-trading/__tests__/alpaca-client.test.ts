import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlpacaClient } from "../alpaca-client";

const BASE = "https://paper-api.alpaca.markets/v2";

function makeFetchMock(handler: (req: { url: string; method: string; body?: unknown }) => { ok?: boolean; status?: number; statusText?: string; body?: unknown }) {
  return vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const r = handler({ url, method, body });
    const status = r.status ?? 200;
    // Status 204/205/304 disallow a body in the WHATWG Response constructor.
    const responseBody = status === 204 || status === 205 || status === 304
      ? null
      : r.body == null ? "" : JSON.stringify(r.body);
    return new Response(responseBody as any, {
      status,
      statusText: r.statusText ?? "OK",
    });
  });
}

function newClient(overrides: Partial<{ pollTimeoutMs: number; pollIntervalMs: number }> = {}) {
  return new AlpacaClient({
    apiKey: "k",
    apiSecret: "s",
    baseUrl: BASE,
    pollTimeoutMs: overrides.pollTimeoutMs ?? 100,
    pollIntervalMs: overrides.pollIntervalMs ?? 5,
  });
}

describe("AlpacaClient.cancelOrder", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("issues DELETE /orders/{id}", async () => {
    const seen: { url: string; method: string }[] = [];
    global.fetch = makeFetchMock(({ url, method }) => {
      seen.push({ url, method });
      return { status: 204 };
    }) as any;

    const c = newClient();
    await c.cancelOrder("abc-123");

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("DELETE");
    expect(seen[0].url).toBe(`${BASE}/orders/abc-123`);
  });

  it("propagates errors when broker returns non-2xx", async () => {
    global.fetch = makeFetchMock(() => ({ status: 422, statusText: "Unprocessable", body: { message: "already filled" } })) as any;
    const c = newClient();
    await expect(c.cancelOrder("xyz")).rejects.toThrow(/422/);
  });
});

describe("AlpacaClient.getOpenOrders", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("requests status=open and parses mleg legs with positionIntent", async () => {
    let seenUrl = "";
    global.fetch = makeFetchMock(({ url }) => {
      seenUrl = url;
      return {
        body: [
          {
            id: "ord-1",
            status: "new",
            order_class: "mleg",
            symbol: "",
            submitted_at: "2026-05-01T13:30:03Z",
            legs: [
              { symbol: "SPY260605P00667000", side: "sell", position_intent: "sell_to_open" },
              { symbol: "SPY260605P00662000", side: "buy", position_intent: "buy_to_open" },
            ],
          },
        ],
      };
    }) as any;

    const c = newClient();
    const orders = await c.getOpenOrders({ symbols: ["SPY"] });

    expect(seenUrl).toContain("status=open");
    expect(seenUrl).toContain("symbols=SPY");
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe("ord-1");
    expect(orders[0].orderClass).toBe("mleg");
    expect(orders[0].legs).toEqual([
      { symbol: "SPY260605P00667000", side: "sell", positionIntent: "sell_to_open" },
      { symbol: "SPY260605P00662000", side: "buy", positionIntent: "buy_to_open" },
    ]);
  });

  it("works without symbols filter", async () => {
    let seenUrl = "";
    global.fetch = makeFetchMock(({ url }) => {
      seenUrl = url;
      return { body: [] };
    }) as any;
    const c = newClient();
    const orders = await c.getOpenOrders();
    expect(orders).toEqual([]);
    expect(seenUrl).toContain("status=open");
    expect(seenUrl).not.toContain("symbols=");
  });
});

describe("AlpacaClient.listOptionContracts", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("sends date/strike range filters and parses tradable active contracts", async () => {
    const seenUrls: string[] = [];
    global.fetch = makeFetchMock(({ url }) => {
      seenUrls.push(url);
      return {
        body: {
          option_contracts: [
            { symbol: "SPY260619P00700000", expiration_date: "2026-06-19", strike_price: "700", type: "put", status: "active", tradable: true },
            { symbol: "SPY260619P00705000", expiration_date: "2026-06-19", strike_price: "705", type: "put", status: "active", tradable: true },
            { symbol: "SPY260626P00700000", expiration_date: "2026-06-26", strike_price: "700", type: "put", status: "active", tradable: true },
            // non-tradable はフィルタアウト
            { symbol: "SPY260619P00710000", expiration_date: "2026-06-19", strike_price: "710", type: "put", status: "active", tradable: false },
          ],
          next_page_token: null,
        },
      };
    }) as any;

    const c = newClient();
    const contracts = await c.listOptionContracts("SPY", "P", "2026-05-11", "2026-08-19", 600, 800);

    expect(contracts).toHaveLength(3);
    expect(contracts.every((c) => c.right === "P")).toBe(true);
    expect(contracts.map((c) => c.strike).sort((a, b) => a - b)).toEqual([700, 700, 705]);

    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain("underlying_symbols=SPY");
    expect(seenUrls[0]).toContain("type=put");
    expect(seenUrls[0]).toContain("expiration_date_gte=2026-05-11");
    expect(seenUrls[0]).toContain("expiration_date_lte=2026-08-19");
    expect(seenUrls[0]).toContain("strike_price_gte=600");
    expect(seenUrls[0]).toContain("strike_price_lte=800");
    expect(seenUrls[0]).toContain("status=active");
  });

  it("follows pagination via next_page_token", async () => {
    let call = 0;
    global.fetch = makeFetchMock(() => {
      call += 1;
      if (call === 1) {
        return {
          body: {
            option_contracts: [
              { symbol: "SPY260619P00700000", expiration_date: "2026-06-19", strike_price: "700", type: "put", status: "active", tradable: true },
            ],
            next_page_token: "tok-1",
          },
        };
      }
      return {
        body: {
          option_contracts: [
            { symbol: "SPY260619P00705000", expiration_date: "2026-06-19", strike_price: "705", type: "put", status: "active", tradable: true },
          ],
          next_page_token: null,
        },
      };
    }) as any;

    const c = newClient();
    const contracts = await c.listOptionContracts("SPY", "P", "2026-05-11", "2026-08-19", 600, 800);
    expect(contracts).toHaveLength(2);
    expect(call).toBe(2);
  });
});

describe("AlpacaClient.placeMultiLegOrder TIMEOUT cancel (KOH-466)", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it("calls DELETE /orders/{id} when poll times out without terminal status", async () => {
    const calls: { url: string; method: string }[] = [];
    global.fetch = makeFetchMock(({ url, method }) => {
      calls.push({ url, method });
      // POST /orders → returns id, status pending
      if (method === "POST" && url.endsWith("/orders")) {
        return { body: { id: "ord-stuck", status: "pending_new" } };
      }
      // GET /orders/ord-stuck → keeps returning non-terminal status
      if (method === "GET" && url.endsWith("/orders/ord-stuck")) {
        return { body: { id: "ord-stuck", status: "new" } };
      }
      // DELETE /orders/ord-stuck → cancel succeeds
      if (method === "DELETE" && url.endsWith("/orders/ord-stuck")) {
        return { status: 204 };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as any;

    const c = newClient({ pollTimeoutMs: 50, pollIntervalMs: 5 });
    const result = await c.placeMultiLegOrder({
      legs: [
        { occSymbol: "SPY260605P00667000", side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { occSymbol: "SPY260605P00662000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
      totalQuantity: 1,
      limitPrice: -0.97,
      tif: "day",
    });

    expect(result.status).toBe("TIMEOUT");
    expect(result.orderId).toBe("ord-stuck");

    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].url).toBe(`${BASE}/orders/ord-stuck`);
    expect(result.message).toMatch(/cancel attempted/);
  });

  it("returns TIMEOUT with cancel-failed message if broker rejects DELETE (e.g. order just filled)", async () => {
    global.fetch = makeFetchMock(({ url, method }) => {
      if (method === "POST" && url.endsWith("/orders")) {
        return { body: { id: "ord-raced", status: "pending_new" } };
      }
      if (method === "GET" && url.endsWith("/orders/ord-raced")) {
        return { body: { id: "ord-raced", status: "new" } };
      }
      if (method === "DELETE" && url.endsWith("/orders/ord-raced")) {
        return { status: 422, statusText: "Unprocessable", body: { message: "order is in a terminal state" } };
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }) as any;

    const c = newClient({ pollTimeoutMs: 50, pollIntervalMs: 5 });
    const result = await c.placeMultiLegOrder({
      legs: [
        { occSymbol: "SPY260605P00667000", side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { occSymbol: "SPY260605P00662000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
      totalQuantity: 1,
      limitPrice: -0.97,
      tif: "day",
    });

    expect(result.status).toBe("TIMEOUT");
    expect(result.message).toMatch(/cancel failed/);
  });
});
