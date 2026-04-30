import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../with-retry";

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const r = await withRetry(fn, { retries: 3, intervalMs: 0 });
    expect(r).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries up to N times then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(withRetry(fn, { retries: 3, intervalMs: 0 })).rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("returns on second attempt if first fails", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");
    const r = await withRetry(fn, { retries: 3, intervalMs: 0 });
    expect(r).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
