// src/paper-trading/alpaca-client.ts
//
// Alpaca Paper Trading client. Mirrors the public surface of `IBKRClient`
// where it makes sense so an executor abstraction can be layered on top.
//
// Differences from IBKR:
//   - REST + Bearer-style headers; no persistent connection. `connect()` /
//     `disconnect()` are no-ops kept for interface parity.
//   - Multi-leg legs use the OCC symbol (e.g. SPY260619P00450000) directly,
//     so there is no `qualifyOptionContract` step.
//   - Trading and market-data live under separate hosts:
//       trading: ALPACA_API_ENDPOINT  (e.g. https://paper-api.alpaca.markets/v2)
//       data:    ALPACA_DATA_ENDPOINT (default https://data.alpaca.markets)

export interface AlpacaClientConfig {
  apiKey: string;
  apiSecret: string;
  /** Trading API base, including /v2 — e.g. https://paper-api.alpaca.markets/v2 */
  baseUrl: string;
  /** Market-data API base (no trailing version). default: https://data.alpaca.markets */
  dataUrl?: string;
  fetchTimeoutMs?: number;
}

export interface AccountSummary {
  netLiquidation: number;
  totalCashValue: number;
  buyingPower: number;
  availableFunds: number;
}

export interface AlpacaPosition {
  symbol: string;
  assetClass: string;
  side: "long" | "short";
  quantity: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPnl: number;
}

export interface MarketPrice {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface OptionContract {
  occSymbol: string;
  strike: number;
  expiry: string; // YYYY-MM-DD
  right: "P" | "C";
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma: number | null;
  impliedVol: number | null;
}

export interface MultiLegLeg {
  /** OCC symbol, e.g. SPY260619P00450000 */
  occSymbol: string;
  side: "buy" | "sell";
  ratioQty: number;
  positionIntent:
    | "buy_to_open"
    | "sell_to_open"
    | "buy_to_close"
    | "sell_to_close";
}

export interface MultiLegOrderRequest {
  legs: MultiLegLeg[];
  totalQuantity: number;
  /**
   * Net price per spread. Alpaca convention: positive for net debit,
   * negative for net credit (matches IBKR's combo limit-price sign).
   */
  limitPrice: number;
  tif: "day" | "gtc";
}

export interface OrderResult {
  orderId: string;
  status: "SUBMITTED" | "FILLED" | "CANCELLED" | "REJECTED" | "TIMEOUT";
  filledPrice?: number;
  commission?: number;
  message?: string;
}

const DEFAULT_DATA_URL = "https://data.alpaca.markets";

interface FetchOpts {
  method?: "GET" | "POST" | "DELETE" | "PATCH";
  body?: unknown;
  base?: "trading" | "data";
}

export class AlpacaClient {
  private readonly config: Required<AlpacaClientConfig>;

  constructor(config: AlpacaClientConfig) {
    if (!config.apiKey || !config.apiSecret || !config.baseUrl) {
      throw new Error(
        "AlpacaClient requires apiKey, apiSecret, and baseUrl in config",
      );
    }
    this.config = {
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      dataUrl: (config.dataUrl ?? DEFAULT_DATA_URL).replace(/\/+$/, ""),
      fetchTimeoutMs: config.fetchTimeoutMs ?? 10_000,
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  isConnected(): boolean {
    return true;
  }

  async getAccountSummary(): Promise<AccountSummary> {
    const a = await this.request<RawAccount>("/account");
    return {
      netLiquidation: Number(a.equity),
      totalCashValue: Number(a.cash),
      buyingPower: Number(a.buying_power),
      availableFunds: Number(a.effective_buying_power ?? a.buying_power),
    };
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    const raw = await this.request<RawPosition[]>("/positions");
    return raw.map((p) => ({
      symbol: p.symbol,
      assetClass: p.asset_class,
      side: p.side,
      quantity: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
      marketValue: Number(p.market_value),
      unrealizedPnl: Number(p.unrealized_pl),
    }));
  }

  /** Latest stock quote via market-data API. IEX feed on free tier. */
  async getMarketPrice(symbol: string): Promise<MarketPrice> {
    const path = `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`;
    const r = await this.request<RawStockQuote>(path, { base: "data" });
    return {
      bid: positiveOrNull(r.quote?.bp),
      ask: positiveOrNull(r.quote?.ap),
      last: null,
    };
  }

  /**
   * SPY (or any underlying) のオプションチェーンを取得。
   * `atmStrike ± 20` の strike で `right` 側のみフィルタ。
   * Greeks (delta/gamma/iv) と quote (bid/ask) は snapshots API から付加。
   *
   * @param underlying e.g. "SPY"
   * @param expiry YYYY-MM-DD
   * @param right "P" or "C"
   * @param atmStrike center strike
   */
  async getOptionChain(
    underlying: string,
    expiry: string,
    right: "P" | "C",
    atmStrike: number,
  ): Promise<OptionContract[]> {
    const lo = atmStrike - 20;
    const hi = atmStrike + 20;
    const type = right === "P" ? "put" : "call";

    const contracts: OptionContract[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        underlying_symbols: underlying,
        expiration_date: expiry,
        type,
        strike_price_gte: String(lo),
        strike_price_lte: String(hi),
        status: "active",
        limit: "100",
      });
      if (pageToken) params.set("page_token", pageToken);
      const page = await this.request<RawOptionContractPage>(
        `/options/contracts?${params.toString()}`,
      );
      for (const c of page.option_contracts ?? []) {
        contracts.push({
          occSymbol: c.symbol,
          strike: Number(c.strike_price),
          expiry: c.expiration_date,
          right: c.type === "put" ? "P" : "C",
          bid: null,
          ask: null,
          delta: null,
          gamma: null,
          impliedVol: null,
        });
      }
      pageToken = page.next_page_token ?? undefined;
    } while (pageToken);

    if (contracts.length > 0) {
      await this.attachSnapshots(underlying, contracts);
    }
    return contracts;
  }

  private async attachSnapshots(
    _underlying: string,
    contracts: OptionContract[],
  ): Promise<void> {
    const bySymbol = new Map(contracts.map((c) => [c.occSymbol, c]));
    const symbols = [...bySymbol.keys()];
    const chunkSize = 100;
    for (let i = 0; i < symbols.length; i += chunkSize) {
      const chunk = symbols.slice(i, i + chunkSize);
      const params = new URLSearchParams({ symbols: chunk.join(",") });
      const r = await this.request<RawOptionSnapshotsResponse>(
        `/v1beta1/options/snapshots?${params.toString()}`,
        { base: "data" },
      );
      const snaps = r.snapshots ?? {};
      for (const sym of chunk) {
        const s = snaps[sym];
        const c = bySymbol.get(sym);
        if (!c || !s) continue;
        c.bid = positiveOrNull(s.latestQuote?.bp);
        c.ask = positiveOrNull(s.latestQuote?.ap);
        c.delta = s.greeks?.delta ?? null;
        c.gamma = s.greeks?.gamma ?? null;
        c.impliedVol = s.impliedVolatility ?? null;
      }
    }
  }

  /**
   * Place a multi-leg (mleg) order. Polls until terminal state or 5 min timeout.
   *
   * Sign convention for `limitPrice`:
   *   - Negative = net credit (e.g. selling a put credit spread)
   *   - Positive = net debit
   * This matches the IBKR combo convention so the upstream executor can stay
   * sign-stable across brokers.
   */
  async placeMultiLegOrder(req: MultiLegOrderRequest): Promise<OrderResult> {
    const body = {
      order_class: "mleg",
      qty: String(req.totalQuantity),
      type: "limit",
      limit_price: req.limitPrice.toFixed(2),
      time_in_force: req.tif,
      legs: req.legs.map((l) => ({
        symbol: l.occSymbol,
        side: l.side,
        ratio_qty: String(l.ratioQty),
        position_intent: l.positionIntent,
      })),
    };

    let placed: RawOrder;
    try {
      placed = await this.request<RawOrder>("/orders", {
        method: "POST",
        body,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { orderId: "", status: "REJECTED", message: msg };
    }

    return await this.pollOrder(placed.id, 5 * 60 * 1000);
  }

  private async pollOrder(
    orderId: string,
    timeoutMs: number,
  ): Promise<OrderResult> {
    const start = Date.now();
    let intervalMs = 1_000;
    while (Date.now() - start < timeoutMs) {
      const order = await this.request<RawOrder>(
        `/orders/${encodeURIComponent(orderId)}`,
      );
      const terminal = mapTerminalStatus(order.status);
      if (terminal) {
        return {
          orderId,
          status: terminal,
          filledPrice:
            order.filled_avg_price != null
              ? Number(order.filled_avg_price)
              : undefined,
          commission: 0,
          message: terminal === "FILLED" ? undefined : order.status,
        };
      }
      await sleep(intervalMs);
      intervalMs = Math.min(intervalMs * 2, 5_000);
    }
    return {
      orderId,
      status: "TIMEOUT",
      message: "Order fill confirmation timed out (5 min)",
    };
  }

  private async request<T>(path: string, opts: FetchOpts = {}): Promise<T> {
    const base = opts.base === "data" ? this.config.dataUrl : this.config.baseUrl;
    const url = `${base}${path.startsWith("/") ? "" : "/"}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.fetchTimeoutMs,
    );
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers: {
          "APCA-API-KEY-ID": this.config.apiKey,
          "APCA-API-SECRET-KEY": this.config.apiSecret,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body != null ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Alpaca ${res.status} ${res.statusText}: ${text}`);
      }
      return text ? (JSON.parse(text) as T) : (undefined as unknown as T);
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapTerminalStatus(s: string): OrderResult["status"] | null {
  switch (s) {
    case "filled":
      return "FILLED";
    case "canceled":
    case "expired":
    case "replaced":
      return "CANCELLED";
    case "rejected":
    case "suspended":
      return "REJECTED";
    default:
      return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function positiveOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// --- Internal raw response shapes --------------------------------------

interface RawAccount {
  equity: string;
  cash: string;
  buying_power: string;
  effective_buying_power?: string;
}

interface RawPosition {
  symbol: string;
  asset_class: string;
  side: "long" | "short";
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

interface RawStockQuote {
  symbol: string;
  quote?: { bp?: number; ap?: number; bs?: number; as?: number };
}

interface RawOptionContractPage {
  option_contracts?: Array<{
    symbol: string;
    expiration_date: string;
    strike_price: string;
    type: "put" | "call";
    status: string;
    tradable: boolean;
  }>;
  next_page_token?: string | null;
}

interface RawOptionSnapshotsResponse {
  snapshots?: Record<
    string,
    {
      latestQuote?: { bp?: number; ap?: number };
      greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number };
      impliedVolatility?: number;
    }
  >;
}

interface RawOrder {
  id: string;
  status: string;
  filled_avg_price?: string | null;
}
