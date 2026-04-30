import type { USCreditSpreadBacktestConfig } from "../us/us-credit-spread-types";

export interface DDStopPrevState {
  runningPeak: number;
  ddStopActive: boolean;
  ddStopActivatedDate: string | null;
}

export interface DDStopContext {
  today: string;
  totalEquity: number;
  prevState: DDStopPrevState;
  config: Pick<USCreditSpreadBacktestConfig, "ddStopEnabled" | "ddStopThreshold" | "ddStopCooldownDays">;
}

export interface DDStopState {
  runningPeak: number;
  ddStopActive: boolean;
  ddStopActivatedDate: string | null;
  transition: "ACTIVATED" | "DEACTIVATED" | "UNCHANGED";
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function calcDDStopState(ctx: DDStopContext): DDStopState {
  const { today, totalEquity, prevState, config } = ctx;

  let runningPeak = prevState.runningPeak;
  if (totalEquity > runningPeak) runningPeak = totalEquity;

  if (!config.ddStopEnabled) {
    return {
      runningPeak,
      ddStopActive: prevState.ddStopActive,
      ddStopActivatedDate: prevState.ddStopActivatedDate,
      transition: "UNCHANGED",
    };
  }

  if (!prevState.ddStopActive) {
    const dd = (runningPeak - totalEquity) / runningPeak;
    if (dd > config.ddStopThreshold) {
      return {
        runningPeak,
        ddStopActive: true,
        ddStopActivatedDate: today,
        transition: "ACTIVATED",
      };
    }
    return {
      runningPeak,
      ddStopActive: false,
      ddStopActivatedDate: null,
      transition: "UNCHANGED",
    };
  } else {
    if (prevState.ddStopActivatedDate != null) {
      const daysSinceStop = daysBetween(prevState.ddStopActivatedDate, today);
      if (daysSinceStop >= config.ddStopCooldownDays) {
        return {
          runningPeak: totalEquity,
          ddStopActive: false,
          ddStopActivatedDate: null,
          transition: "DEACTIVATED",
        };
      }
    }
    return {
      runningPeak,
      ddStopActive: true,
      ddStopActivatedDate: prevState.ddStopActivatedDate,
      transition: "UNCHANGED",
    };
  }
}
