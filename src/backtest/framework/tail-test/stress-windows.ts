// src/backtest/tail-test/stress-windows.ts
import type { StressWindow } from "./types";

export const STRESS_WINDOWS: readonly StressWindow[] = [
  { name: "Lehman / 2008 GFC",          start: "2008-09-01", end: "2009-03-31" },
  { name: "Flash Crash",                 start: "2010-05-01", end: "2010-05-31" },
  { name: "EU Debt Crisis",              start: "2011-08-01", end: "2011-10-31" },
  { name: "China Black Monday",          start: "2015-08-15", end: "2015-09-30" },
  { name: "Volmageddon",                 start: "2018-02-01", end: "2018-02-28" },
  { name: "Q4 2018 Selloff",             start: "2018-10-01", end: "2018-12-31" },
  { name: "COVID-19",                    start: "2020-02-15", end: "2020-04-30" },
  { name: "2022 Bear",                   start: "2022-01-01", end: "2022-10-31" },
  { name: "Aug 2024 Yen Carry Unwind",   start: "2024-08-01", end: "2024-08-15" },
] as const;
