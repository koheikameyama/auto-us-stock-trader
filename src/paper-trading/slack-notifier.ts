export type Level = "info" | "warn" | "error" | "critical";

export interface SlackMessage {
  text: string;
  level: Level;
}

const COLOR: Record<Level, string> = {
  info: "good",
  warn: "warning",
  error: "danger",
  critical: "danger",
};

export async function sendSlack(msg: SlackMessage): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const prefix =
    msg.level === "critical"
      ? "<!channel> 🚨 "
      : msg.level === "error"
        ? "❌ "
        : msg.level === "warn"
          ? "⚠️ "
          : "✅ ";
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: prefix + msg.text,
        attachments: [{ color: COLOR[msg.level], text: msg.text }],
      }),
    });
  } catch {
    // best-effort: do not let notification failure crash the runner
  }
}

export function formatEntrySuccess(p: {
  shortStrike: number;
  longStrike: number;
  expiry: string;
  filledCredit: number | null;
}): string {
  return `Entry: SPY P ${p.shortStrike}/${p.longStrike} ${p.expiry} credit=$${(p.filledCredit ?? 0).toFixed(2)}`;
}

export function formatEntrySkip(
  reason: string,
  ctx: { spy: number; vix: number; sma50?: number | null },
): string {
  return `Skip entry (${reason}): SPY=${ctx.spy} VIX=${ctx.vix.toFixed(2)} SMA50=${ctx.sma50?.toFixed(2) ?? "n/a"}`;
}

export function formatCloseSuccess(p: {
  shortStrike: number;
  longStrike: number;
  reason: string;
  netPnl: number | null;
  daysHeld: number;
}): string {
  return `Close (${p.reason}): SPY P ${p.shortStrike}/${p.longStrike} pnl=$${(p.netPnl ?? 0).toFixed(2)} days=${p.daysHeld}`;
}

export function formatExpire(p: {
  shortStrike: number;
  longStrike: number;
  reason: string;
  netPnl: number | null;
}): string {
  return `Expired (${p.reason}): SPY P ${p.shortStrike}/${p.longStrike} pnl=$${(p.netPnl ?? 0).toFixed(2)}`;
}

export function formatDDStop(
  action: "ACTIVATED" | "DEACTIVATED",
  peak: number,
  equity: number,
): string {
  return `DD stop ${action}: peak=$${peak.toFixed(0)} equity=$${equity.toFixed(0)} drawdown=${((1 - equity / peak) * 100).toFixed(2)}%`;
}

export function formatDailySummary(s: {
  date: string;
  openCount: number;
  equity: number;
  dailyPnl: number;
  events?: string[];
}): string {
  const head = `Daily summary ${s.date}: open=${s.openCount} equity=$${s.equity.toFixed(0)} ΔPnL=$${s.dailyPnl.toFixed(2)}`;
  if (!s.events || s.events.length === 0) return head;
  return `${head}\n` + s.events.map((e) => `• ${e}`).join("\n");
}

export function formatErrorAlert(
  category: string,
  message: string,
  ctx?: object,
): string {
  const ctxStr = ctx ? ` ctx=${JSON.stringify(ctx)}` : "";
  return `${category}: ${message}${ctxStr}`;
}

export function formatKillSwitch(reason: string): string {
  return `Kill switch active: ${reason}`;
}

export function formatDuplicateOrder(detail: string): string {
  return `DUPLICATE ORDER DETECTED: ${detail}`;
}
