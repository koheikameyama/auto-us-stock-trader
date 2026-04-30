import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendSlack,
  formatEntrySuccess,
  formatCloseSuccess,
  formatErrorAlert,
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
});
