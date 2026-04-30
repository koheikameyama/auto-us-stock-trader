import { describe, it, expect } from "vitest";
import { calcDDStopState } from "../dd-stop";
import type { USCreditSpreadBacktestConfig } from "../../us/us-credit-spread-types";

const baseConfig: Pick<USCreditSpreadBacktestConfig, "ddStopEnabled" | "ddStopThreshold" | "ddStopCooldownDays"> = {
  ddStopEnabled: true,
  ddStopThreshold: 0.15,
  ddStopCooldownDays: 252,
};

describe("calcDDStopState", () => {
  it("does nothing when ddStopEnabled=false", () => {
    const result = calcDDStopState({
      today: "2024-01-15",
      totalEquity: 800,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: { ...baseConfig, ddStopEnabled: false },
    });
    expect(result.ddStopActive).toBe(false);
    expect(result.transition).toBe("UNCHANGED");
    expect(result.runningPeak).toBe(1000);
  });

  it("activates when DD exceeds threshold", () => {
    const result = calcDDStopState({
      today: "2024-01-15",
      totalEquity: 840,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(true);
    expect(result.ddStopActivatedDate).toBe("2024-01-15");
    expect(result.transition).toBe("ACTIVATED");
  });

  it("does not activate when DD is exactly at threshold", () => {
    const result = calcDDStopState({
      today: "2024-01-15",
      totalEquity: 850,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(false);
    expect(result.transition).toBe("UNCHANGED");
  });

  it("updates runningPeak when totalEquity exceeds it", () => {
    const result = calcDDStopState({
      today: "2024-02-01",
      totalEquity: 1100,
      prevState: { runningPeak: 1000, ddStopActive: false, ddStopActivatedDate: null },
      config: baseConfig,
    });
    expect(result.runningPeak).toBe(1100);
  });

  it("stays active during cooldown period", () => {
    const result = calcDDStopState({
      today: "2024-06-01",
      totalEquity: 850,
      prevState: { runningPeak: 1000, ddStopActive: true, ddStopActivatedDate: "2024-01-15" },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(true);
    expect(result.transition).toBe("UNCHANGED");
  });

  it("deactivates after cooldown elapses + resets peak to current equity", () => {
    const result = calcDDStopState({
      today: "2024-09-23",
      totalEquity: 850,
      prevState: { runningPeak: 1000, ddStopActive: true, ddStopActivatedDate: "2024-01-15" },
      config: baseConfig,
    });
    expect(result.ddStopActive).toBe(false);
    expect(result.ddStopActivatedDate).toBeNull();
    expect(result.runningPeak).toBe(850);
    expect(result.transition).toBe("DEACTIVATED");
  });
});
