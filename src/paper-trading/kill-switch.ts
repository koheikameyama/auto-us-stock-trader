// src/paper-trading/kill-switch.ts
import * as fs from "fs";
import * as path from "path";

const KILL_SWITCH_FILE = path.resolve(".paper-trading-stop");

export function isKillSwitchActive(): boolean {
  return fs.existsSync(KILL_SWITCH_FILE);
}

export function getKillSwitchInfo(): { active: boolean; reason?: string; createdAt?: Date } {
  if (!fs.existsSync(KILL_SWITCH_FILE)) return { active: false };
  const stat = fs.statSync(KILL_SWITCH_FILE);
  const reason = fs.readFileSync(KILL_SWITCH_FILE, "utf-8").trim() || "(no reason)";
  return { active: true, reason, createdAt: stat.birthtime };
}
