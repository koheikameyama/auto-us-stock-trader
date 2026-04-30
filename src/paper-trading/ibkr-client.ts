// src/paper-trading/ibkr-client.ts
import { IBApiNext, ConnectionState } from "@stoqey/ib";

export interface IBKRClientConfig {
  host?: string; // default: "127.0.0.1"
  port?: number; // default: 7497 (TWS Paper)
  clientId?: number; // default: 100
  connectTimeoutMs?: number; // default: 10_000
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
}
