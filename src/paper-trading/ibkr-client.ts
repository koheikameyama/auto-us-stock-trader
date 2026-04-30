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
