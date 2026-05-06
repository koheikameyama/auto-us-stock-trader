import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendSlack,
  formatEntrySuccess,
  formatCloseSuccess,
  formatErrorAlert,
  formatEntryRejected,
  formatEntryTimeout,
} from "../slack-notifier";

describe("sendSlack", () => {
  const fetchMock = vi.fn();
  const origFetch = global.fetch;

  beforeEach(() => {
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/test";
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true } as any);
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete process.env.SLACK_WEBHOOK_URL;
    (global as any).fetch = origFetch;
  });

  it("posts JSON payload to webhook URL", async () => {
    await sendSlack({ text: "hello", level: "info" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toContain("hello");
  });

  it("no-op if SLACK_WEBHOOK_URL not set", async () => {
    delete process.env.SLACK_WEBHOOK_URL;
    await sendSlack({ text: "x", level: "info" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw if webhook fails (best effort)", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    await expect(sendSlack({ text: "x", level: "info" })).resolves.toBeUndefined();
  });
});

describe("formatters", () => {
  it("formatEntrySuccess includes strike + credit", () => {
    const msg = formatEntrySuccess({
      shortStrike: 480,
      longStrike: 475,
      expiry: "20260619",
      filledCredit: 0.85,
    });
    expect(msg).toContain("480/475");
    expect(msg).toContain("$0.85");
  });

  it("formatCloseSuccess includes reason and PnL", () => {
    const msg = formatCloseSuccess({
      shortStrike: 480,
      longStrike: 475,
      reason: "profit_target",
      netPnl: 52.6,
      daysHeld: 7,
    });
    expect(msg).toContain("profit_target");
    expect(msg).toContain("$52.60");
  });

  it("formatErrorAlert includes category and message", () => {
    const msg = formatErrorAlert("ORDER_FAILED", "rejected by exchange");
    expect(msg).toContain("ORDER_FAILED");
    expect(msg).toContain("rejected by exchange");
  });

  it("formatEntryRejected includes spread + broker reject message", () => {
    const msg = formatEntryRejected({
      shortStrike: 692,
      longStrike: 687,
      expiry: "2026-06-08",
      contracts: 1,
      message: "Alpaca 422: option contract not found",
    });
    expect(msg).toContain("REJECTED");
    expect(msg).toContain("692/687");
    expect(msg).toContain("2026-06-08");
    expect(msg).toContain("Alpaca 422: option contract not found");
  });

  it("formatEntryRejected handles missing message gracefully", () => {
    const msg = formatEntryRejected({
      shortStrike: 692,
      longStrike: 687,
      expiry: "2026-06-08",
      contracts: 1,
      message: null,
    });
    expect(msg).toContain("REJECTED");
    expect(msg).toContain("692/687");
    // 何らかの「reason 不明」を表す表記があれば OK（"unknown" / "no detail" 等）
    expect(msg.toLowerCase()).toMatch(/unknown|no detail|none/);
  });

  it("formatEntryTimeout includes spread + broker order id", () => {
    const msg = formatEntryTimeout({
      shortStrike: 695,
      longStrike: 690,
      expiry: "2026-06-05",
      contracts: 1,
      brokerOrderId: "abc-123",
      message: "Order fill confirmation timed out (5 min); cancel attempted",
    });
    expect(msg).toContain("TIMEOUT");
    expect(msg).toContain("695/690");
    expect(msg).toContain("abc-123");
    expect(msg).toContain("timed out");
  });
});
