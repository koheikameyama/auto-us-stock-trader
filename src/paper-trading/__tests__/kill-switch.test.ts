import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { isKillSwitchActive, getKillSwitchInfo } from "../kill-switch";

const KILL_SWITCH_FILE = path.resolve(".paper-trading-stop");

describe("kill-switch", () => {
  afterEach(() => {
    if (fs.existsSync(KILL_SWITCH_FILE)) fs.unlinkSync(KILL_SWITCH_FILE);
  });

  it("returns false when kill switch file does not exist", () => {
    expect(isKillSwitchActive()).toBe(false);
    expect(getKillSwitchInfo().active).toBe(false);
  });

  it("returns true when kill switch file exists", () => {
    fs.writeFileSync(KILL_SWITCH_FILE, "メンテナンス中");
    expect(isKillSwitchActive()).toBe(true);
    const info = getKillSwitchInfo();
    expect(info.active).toBe(true);
    expect(info.reason).toBe("メンテナンス中");
  });

  it("returns '(no reason)' when file exists but is empty", () => {
    fs.writeFileSync(KILL_SWITCH_FILE, "");
    expect(getKillSwitchInfo().reason).toBe("(no reason)");
  });
});
