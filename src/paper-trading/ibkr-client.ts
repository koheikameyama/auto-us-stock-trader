// src/paper-trading/ibkr-client.ts
import { IBApiNext, ConnectionState } from "@stoqey/ib";

export interface IBKRClientConfig {
  host?: string; // default: "127.0.0.1"
  port?: number; // default: 7497 (TWS Paper)
  clientId?: number; // default: 100
  connectTimeoutMs?: number; // default: 10_000
}

export interface AccountSummary {
  netLiquidation: number;
  totalCashValue: number;
  buyingPower: number;
  availableFunds: number;
}

export interface IBKRPosition {
  symbol: string;
  secType: string; // "STK" | "OPT" | "FUT" | etc.
  right?: "P" | "C";
  strike?: number;
  expiry?: string; // YYYYMMDD format
  quantity: number;
  avgCost: number;
  marketValue: number;
  unrealizedPnl: number;
}

export interface MarketPrice {
  bid: number | null;
  ask: number | null;
  last: number | null;
}

export interface OptionContract {
  strike: number;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  gamma: number | null;
  impliedVol: number | null;
}

export interface OptionLeg {
  conId: number;
  action: "BUY" | "SELL";
  ratio: number;
}

export interface ComboOrderRequest {
  underlying: string;
  legs: OptionLeg[];
  totalQuantity: number;
  limitPrice: number; // negative = NET CREDIT
  tif: "DAY" | "GTC";
}

export interface OrderResult {
  ibkrOrderId: number;
  status: "SUBMITTED" | "FILLED" | "CANCELLED" | "REJECTED" | "TIMEOUT";
  filledPrice?: number;
  commission?: number;
  message?: string;
}

export class IBKRClient {
  private api: IBApiNext;
  private config: Required<IBKRClientConfig>;
  private connected = false;

  constructor(config: IBKRClientConfig = {}) {
    this.config = {
      host: config.host ?? "127.0.0.1",
      port: config.port ?? 7497,
      clientId: config.clientId ?? 100,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
    };
    this.api = new IBApiNext({
      host: this.config.host,
      port: this.config.port,
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        sub.unsubscribe();
        reject(
          new Error(
            `Connection timeout after ${this.config.connectTimeoutMs}ms`,
          ),
        );
      }, this.config.connectTimeoutMs);

      const sub = this.api.connectionState.subscribe((state) => {
        if (state === ConnectionState.Connected) {
          clearTimeout(timeout);
          this.connected = true;
          sub.unsubscribe();
          resolve();
        } else if (state === ConnectionState.Disconnected && this.connected) {
          this.connected = false;
        }
      });

      this.api.connect(this.config.clientId);
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.api.disconnect();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getAccountSummary(): Promise<AccountSummary> {
    if (!this.connected) throw new Error("Not connected");
    const tags = "NetLiquidation,TotalCashValue,BuyingPower,AvailableFunds";
    return new Promise<AccountSummary>((resolve, reject) => {
      const result: Partial<AccountSummary> = {};
      const sub = this.api.getAccountSummary("All", tags).subscribe({
        next: (update) => {
          for (const [, accountMap] of update.all) {
            for (const [tag, valueMap] of accountMap) {
              const v = [...valueMap.values()][0];
              if (!v) continue;
              const num = Number(v.value);
              if (tag === "NetLiquidation") result.netLiquidation = num;
              else if (tag === "TotalCashValue") result.totalCashValue = num;
              else if (tag === "BuyingPower") result.buyingPower = num;
              else if (tag === "AvailableFunds") result.availableFunds = num;
            }
          }
          if (
            result.netLiquidation != null &&
            result.totalCashValue != null &&
            result.buyingPower != null &&
            result.availableFunds != null
          ) {
            sub.unsubscribe();
            resolve(result as AccountSummary);
          }
        },
        error: (e) => {
          sub.unsubscribe();
          reject(e);
        },
      });
      setTimeout(() => {
        sub.unsubscribe();
        reject(new Error("getAccountSummary timeout (10s)"));
      }, 10_000);
    });
  }

  async getPositions(): Promise<IBKRPosition[]> {
    if (!this.connected) throw new Error("Not connected");
    return new Promise<IBKRPosition[]>((resolve) => {
      const positions: IBKRPosition[] = [];
      const sub = this.api.getPositions().subscribe({
        next: (update) => {
          positions.length = 0;
          for (const [, accountPositions] of update.all) {
            for (const p of accountPositions) {
              const c = p.contract;
              const right =
                c.right === "P" || c.right === "C" ? c.right : undefined;
              positions.push({
                symbol: c.symbol ?? "",
                secType: c.secType ?? "",
                right,
                strike: c.strike,
                expiry: c.lastTradeDateOrContractMonth,
                quantity: p.pos,
                avgCost: p.avgCost ?? 0,
                marketValue: p.marketValue ?? 0,
                unrealizedPnl: p.unrealizedPNL ?? 0,
              });
            }
          }
        },
        error: () => {
          sub.unsubscribe();
        },
      });
      setTimeout(() => {
        sub.unsubscribe();
        resolve(positions);
      }, 5_000);
    });
  }

  /** 株式 / ETF のリアルタイム bid/ask/last 取得 */
  async getMarketPrice(symbol: string): Promise<MarketPrice> {
    if (!this.connected) throw new Error("Not connected");
    const contract = {
      symbol,
      secType: "STK" as const,
      exchange: "SMART",
      currency: "USD",
    };
    return this.fetchMarketData(contract);
  }

  /** VIX (CBOE INDEX) の current value 取得 */
  async getVIX(): Promise<number> {
    if (!this.connected) throw new Error("Not connected");
    const contract = {
      symbol: "VIX",
      secType: "IND" as const,
      exchange: "CBOE",
      currency: "USD",
    };
    const { last } = await this.fetchMarketData(contract);
    if (last == null) throw new Error("VIX last price unavailable");
    return last;
  }

  /**
   * SPY オプションの指定 expiry / right の選択 strike を取得。
   * Phase B では smoke test として ATM ±20 strike を返す（最大 41 件）。
   *
   * @param underlying 例: "SPY"
   * @param expiry YYYYMMDD 形式（例: "20260619"）
   * @param right "P" or "C"
   * @param atmStrike ATM strike（リクエストする中心、これの ±20 を取得）
   */
  async getOptionChain(
    underlying: string,
    expiry: string,
    right: "P" | "C",
    atmStrike: number,
  ): Promise<OptionContract[]> {
    if (!this.connected) throw new Error("Not connected");

    const strikes: number[] = [];
    for (let s = atmStrike - 20; s <= atmStrike + 20; s++) {
      strikes.push(s);
    }

    const results: OptionContract[] = [];
    for (const strike of strikes) {
      try {
        const data = await this.fetchOptionTick(
          underlying,
          expiry,
          right,
          strike,
        );
        results.push(data);
      } catch {
        // skip individual failures
      }
    }
    return results;
  }

  private async fetchOptionTick(
    underlying: string,
    expiry: string,
    right: "P" | "C",
    strike: number,
  ): Promise<OptionContract> {
    const contract = {
      symbol: underlying,
      secType: "OPT" as const,
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: expiry,
      strike,
      right,
      multiplier: "100",
    };

    return new Promise<OptionContract>((resolve) => {
      const result: OptionContract = {
        strike,
        bid: null,
        ask: null,
        delta: null,
        gamma: null,
        impliedVol: null,
      };
      // genericTickList "13" = Model Option Computation (Greeks)
      const sub = this.api
        .getMarketData(contract as any, "13", false, false)
        .subscribe({
          next: (update) => {
            for (const [tickType, tick] of update.all) {
              if (tickType === 1) result.bid = tick.value ?? null;
              else if (tickType === 2) result.ask = tick.value ?? null;
              else if (tickType === 13) {
                const t = tick as any;
                result.delta = t.delta ?? null;
                result.gamma = t.gamma ?? null;
                result.impliedVol = t.impliedVol ?? null;
              }
            }
          },
          error: () => {
            sub.unsubscribe();
            resolve(result);
          },
        });
      setTimeout(() => {
        sub.unsubscribe();
        resolve(result);
      }, 3_000); // 3 seconds per strike
    });
  }

  /** 単一 OPT contract の conId を取得（Combo Order 構築用）*/
  async qualifyOptionContract(
    underlying: string,
    expiry: string, // YYYYMMDD
    strike: number,
    right: "P" | "C",
  ): Promise<number> {
    if (!this.connected) throw new Error("Not connected");
    const contract = {
      symbol: underlying,
      secType: "OPT",
      exchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: expiry,
      strike,
      right,
      multiplier: "100",
    };
    const timeoutMs = 10_000;
    const detailsPromise = this.api.getContractDetails(contract as any);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("qualifyOptionContract timeout (10s)")),
        timeoutMs,
      );
    });
    const details = await Promise.race([detailsPromise, timeoutPromise]);
    const arr = Array.isArray(details) ? details : [];
    for (const d of arr) {
      const c = (d as any).contract ?? d;
      if (c?.conId != null) return c.conId as number;
    }
    throw new Error(
      `Contract not found: ${underlying} ${expiry} ${strike}${right}`,
    );
  }

  /** Combo Order を発注、約定 or タイムアウト (5 分) まで待つ */
  async placeComboOrder(req: ComboOrderRequest): Promise<OrderResult> {
    if (!this.connected) throw new Error("Not connected");

    const combo: any = {
      symbol: req.underlying,
      secType: "BAG",
      currency: "USD",
      exchange: "SMART",
      comboLegs: req.legs.map((leg) => ({
        conId: leg.conId,
        ratio: leg.ratio,
        action: leg.action,
        exchange: "SMART",
      })),
    };

    const order: any = {
      action: req.limitPrice < 0 ? "BUY" : "SELL",
      orderType: "LMT",
      totalQuantity: req.totalQuantity,
      lmtPrice: req.limitPrice,
      tif: req.tif,
      transmit: true,
    };

    // 1. Place order, then 2. monitor via getOpenOrders Observable
    const ibkrOrderId = await this.api.placeNewOrder(combo, order);

    return new Promise<OrderResult>((resolve) => {
      let settled = false;
      const settle = (result: OrderResult) => {
        if (settled) return;
        settled = true;
        sub.unsubscribe();
        clearTimeout(timer);
        resolve(result);
      };

      const sub = this.api.getOpenOrders().subscribe({
        next: (update: any) => {
          const all = update.all ?? [];
          for (const openOrder of all) {
            if (openOrder.orderId !== ibkrOrderId) continue;
            const status = openOrder.orderStatus?.status;
            if (!status) continue;
            if (status === "Filled") {
              settle({
                ibkrOrderId,
                status: "FILLED",
                filledPrice: openOrder.orderStatus?.avgFillPrice,
                commission: (openOrder.orderState as any)?.commission,
              });
              return;
            }
            if (status === "Cancelled" || status === "ApiCancelled") {
              settle({
                ibkrOrderId,
                status: "CANCELLED",
                message: `Order ${status}`,
              });
              return;
            }
            if (status === "Inactive") {
              settle({
                ibkrOrderId,
                status: "REJECTED",
                message: "Order inactive (likely rejected)",
              });
              return;
            }
          }
        },
        error: (e: any) => {
          settle({
            ibkrOrderId,
            status: "REJECTED",
            message: e?.message ?? String(e),
          });
        },
      });

      const timer = setTimeout(
        () => {
          settle({
            ibkrOrderId,
            status: "TIMEOUT",
            message: "Order fill confirmation timed out (5 min)",
          });
        },
        5 * 60 * 1000,
      );
    });
  }

  /** 内部ヘルパー: reqMktData で snapshot 取得 */
  private async fetchMarketData(contract: any): Promise<MarketPrice> {
    return new Promise<MarketPrice>((resolve) => {
      const result: MarketPrice = { bid: null, ask: null, last: null };
      const sub = this.api.getMarketData(contract, "", false, false).subscribe({
        next: (update) => {
          for (const [tickType, tick] of update.all) {
            if (tickType === 1) result.bid = tick.value ?? null; // BID
            else if (tickType === 2) result.ask = tick.value ?? null; // ASK
            else if (tickType === 4) result.last = tick.value ?? null; // LAST
          }
          if (
            result.bid != null &&
            result.ask != null &&
            result.last != null
          ) {
            sub.unsubscribe();
            resolve(result);
          }
        },
        error: () => {
          sub.unsubscribe();
          resolve(result);
        },
      });
      // 5 秒で打ち切り、取得済みを返す
      setTimeout(() => {
        sub.unsubscribe();
        resolve(result);
      }, 5_000);
    });
  }
}
